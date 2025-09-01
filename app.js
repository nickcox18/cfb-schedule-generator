const { createApp, ref, reactive, computed } = Vue

function normalizeRow(row, targetLength) {
  const copy = row.slice()
  while (copy.length < targetLength) copy.push('')
  return copy.slice(0, targetLength)
}

function parseCSVToTeams(csvText) {
  const result = Papa.parse(csvText.trim(), { delimiter: '', skipEmptyLines: true })
  if (result.errors && result.errors.length) {
    throw new Error(result.errors[0].message || 'CSV parse error')
  }
  const rows = result.data
  if (!rows.length) throw new Error('CSV appears empty')

  const teams = []
  for (let r = 0; r < rows.length; r++) {
    let row = rows[r]
    row = normalizeRow(row, 17) // A..Q => 17 columns (0..16)

    const [name, conference, oocNeededRaw, ...weeksRaw] = row
    const lineNo = r + 1
    if (!name || !conference) throw new Error(`Row ${lineNo}: missing team or conference`)

    const oocNeeded = Number((oocNeededRaw ?? '').toString().trim() || '0')
    if (!Number.isFinite(oocNeeded)) throw new Error(`Row ${lineNo}: invalid OOC games needed`)

    const weeks = []
    for (let i = 0; i < 14; i++) {
      const raw = (weeksRaw[i] ?? '').toString().trim()
      if (raw === 'h') {
        weeks.push({ type: 'confHome' })
      } else if (raw === 'a') {
        weeks.push({ type: 'confAway' })
      } else if (/^bye$/i.test(raw)) {
        weeks.push({ type: 'bye' })
      } else if (raw.length === 0) {
        weeks.push({ type: 'empty' })
      } else {
        // Existing OOC opponent (do not modify). Away indicated by optional leading @
        let away = false
        let opponent = raw
        if (raw.startsWith('@')) {
          away = true
          opponent = raw.slice(1)
        }
        weeks.push({ type: 'lockedOOC', opponent, away })
      }
    }

    teams.push({ name, conference, oocNeeded, weeks })
  }
  return teams
}

function validateParsedTeams(teams) {
  const errors = []
  const warnings = []
  const byName = new Map()
  for (const t of teams) {
    const key = t.name.trim().toLowerCase()
    if (byName.has(key)) {
      errors.push(`Duplicate team name detected: ${t.name}`)
    } else {
      byName.set(key, t)
    }
  }

  for (const t of teams) {
    // total scheduled games so far (conf + locked OOC)
    let scheduled = 0
    for (const w of t.weeks) {
      if (w.type === 'confHome' || w.type === 'confAway' || w.type === 'lockedOOC') scheduled++
      if (w.type === 'lockedOOC' && (!w.opponent || !w.opponent.trim())) {
        errors.push(`${t.name}: has an OOC opponent with empty name`)
      }
      if (w.type === 'lockedOOC' && w.opponent.trim().toLowerCase() === t.name.trim().toLowerCase()) {
        errors.push(`${t.name}: cannot play itself`)
      }
    }
    if (scheduled > 12) {
      errors.push(`${t.name}: exceeds 12 total scheduled games (${scheduled})`)
    }
  }

  // Validate that any known opponent is not same-conference
  for (const t of teams) {
    for (const w of t.weeks) {
      if (w.type === 'lockedOOC') {
        const opp = byName.get(w.opponent.trim().toLowerCase())
        if (opp) {
          if (opp.conference === t.conference) {
            errors.push(`${t.name}: existing OOC opponent ${opp.name} is from same conference (${t.conference})`)
          }
        } else {
          warnings.push(`${t.name}: opponent '${w.opponent}' not found in team list`)
        }
      }
    }
  }

  return { errors, warnings }
}

function teamsToCSV(teams) {
  const rows = teams.map(t => {
    const weekVals = t.weeks.map(w => {
      if (w.type === 'confHome') return 'h'
      if (w.type === 'confAway') return 'a'
      if (w.type === 'bye') return 'BYE'
      if (w.type === 'oocGame' || w.type === 'lockedOOC') return `${w.away ? '@' : ''}${w.opponent}`
      return ''
    })
    return [t.name, t.conference, t.oocNeeded, ...weekVals]
  })
  return Papa.unparse(rows, { quotes: false })
}

createApp({
  setup() {
    const currentTab = ref('generator')
    const dragActive = ref(false)
    const fileName = ref('')
    const teams = ref([])
    const generating = ref(false)
    const errors = ref([])
    const status = reactive({ type: 'info', message: '' })

    const options = reactive({
      avoidWeek0: true,
    })

    function unscheduledForTeam(t) {
      let scheduledOOC = 0
      for (const w of t.weeks) {
        if (w.type === 'oocGame' || w.type === 'lockedOOC') scheduledOOC++
      }
      const remaining = (t.oocNeeded || 0) - scheduledOOC
      return remaining > 0 ? remaining : 0
    }

    const stats = computed(() => {
      const s = { totalGames: 0, weekMost: { index: null, count: 0 }, weekLeast: { index: null, count: 0 } }
      if (!teams.value.length) return s
      const weekCounts = new Array(14).fill(0)
      for (const t of teams.value) {
        for (let i = 0; i < t.weeks.length; i++) {
          const w = t.weeks[i]
          if (w.type === 'confHome' || w.type === 'confAway' || w.type === 'oocGame' || w.type === 'lockedOOC') {
            weekCounts[i]++
          }
        }
      }
      s.totalGames = weekCounts.reduce((a, b) => a + b, 0) / 2 // divide by 2 since each game counted twice
      let maxC = -1, minC = Number.POSITIVE_INFINITY, maxI = null, minI = null
      for (let i = 0; i < weekCounts.length; i++) {
        const c = weekCounts[i]
        if (c > maxC) { maxC = c; maxI = i }
        if (c < minC) { minC = c; minI = i }
      }
      s.weekMost.index = maxI
      s.weekMost.count = maxC
      s.weekLeast.index = minI
      s.weekLeast.count = minC
      return s
    })

    function resetStatus() {
      status.type = 'info'
      status.message = ''
      errors.value = []
    }

    function setError(msg) {
      errors.value = [msg]
      status.type = 'error'
      status.message = msg
    }

    function onDrop(e) {
      dragActive.value = false
      const f = e.dataTransfer.files?.[0]
      if (f) handleFile(f)
    }

    function onFileChange(e) {
      const f = e.target.files?.[0]
      if (f) handleFile(f)
      e.target.value = '' // reset so same file can trigger again
    }

    function handleFile(file) {
      resetStatus()
      if (!file.name.toLowerCase().endsWith('.csv')) {
        setError('Please upload a .csv file')
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        try {
          const text = reader.result.toString()
          const parsed = parseCSVToTeams(text)
          const { errors: vErrors, warnings: vWarnings } = validateParsedTeams(parsed)
          if (vErrors.length) {
            throw new Error(vErrors[0])
          }
          teams.value = parsed
          fileName.value = file.name
          status.type = vWarnings.length ? 'info' : 'success'
          status.message = vWarnings.length
            ? `Loaded ${parsed.length} teams with ${vWarnings.length} warning(s)`
            : `Loaded ${parsed.length} teams from ${file.name}`
        } catch (err) {
          console.error(err)
          setError(err.message || 'Failed to parse CSV')
        }
      }
      reader.onerror = () => setError('Failed to read file')
      reader.readAsText(file)
    }

    function onReset() {
      teams.value = []
      fileName.value = ''
      resetStatus()
    }

    // --- Scheduling Algorithm (initial implementation) ---
    function deepCloneTeams(src) {
      return src.map(t => ({
        name: t.name,
        conference: t.conference,
        oocNeeded: t.oocNeeded,
        weeks: t.weeks.map(w => ({ ...w })),
      }))
    }

    function computeTeamState(ts) {
      // Build name map and precompute counts
      const byName = new Map()
      for (const t of ts) byName.set(t.name.trim().toLowerCase(), t)

      const state = ts.map(t => {
        let totalGames = 0
        let homeGames = 0
        let awayGames = 0
        let lockedOOC = 0
        const playedOpp = new Set()
        const availableWeeks = []
        for (let i = 0; i < t.weeks.length; i++) {
          const w = t.weeks[i]
          if (w.type === 'confHome') { totalGames++; homeGames++ }
          else if (w.type === 'confAway') { totalGames++; awayGames++ }
          else if (w.type === 'lockedOOC') {
            totalGames++; lockedOOC++
            if (w.away) awayGames++; else homeGames++
            if (w.opponent) playedOpp.add(w.opponent.trim().toLowerCase())
          } else if (w.type === 'oocGame') {
            totalGames++
            if (w.away) awayGames++; else homeGames++
            if (w.opponent) playedOpp.add(w.opponent.trim().toLowerCase())
          } else if (w.type === 'empty' || w.type === 'bye') {
            availableWeeks.push(i)
          }
        }
        // Remaining OOC to schedule is based on stated need minus locked OOC present
        const oocRemaining = Math.max(0, (t.oocNeeded || 0) - lockedOOC)
        return {
          ref: t,
          name: t.name,
          key: t.name.trim().toLowerCase(),
          conference: t.conference,
          totalGames,
          homeGames,
          awayGames,
          playedOpp,
          availableWeeks,
          oocRemaining,
        }
      })

      return { byName, state }
    }

    function chooseNextTeam(state, preferWeeksNoZero) {
      // Choose team with oocRemaining > 0 and minimal branching factor
      let best = null
      let bestScore = Infinity
      for (const s of state) {
        if (s.oocRemaining <= 0) continue
        const weeks = s.availableWeeks.filter(w => preferWeeksNoZero ? w !== 0 : true)
        const score = weeks.length // simple heuristic: fewer weeks first
        if (score < bestScore) { best = s; bestScore = score }
      }
      return best
    }

    function canScheduleBetween(a, b) {
      if (!a || !b) return false
      if (a.key === b.key) return false
      if (a.conference === b.conference) return false
      if (a.oocRemaining <= 0 || b.oocRemaining <= 0) return false
      if (a.totalGames >= 12 || b.totalGames >= 12) return false
      if (a.playedOpp.has(b.key) || b.playedOpp.has(a.key)) return false
      return true
    }

    function pickHomeAway(a, b) {
      // Prefer to make home the one with fewer current home games to approach 6
      if (a.homeGames !== b.homeGames) {
        return a.homeGames < b.homeGames ? { home: a, away: b } : { home: b, away: a }
      }
      // Tiebreaker: team with more away games becomes home
      if (a.awayGames !== b.awayGames) {
        return a.awayGames > b.awayGames ? { home: a, away: b } : { home: b, away: a }
      }
      // Fallback deterministic order
      return a.key < b.key ? { home: a, away: b } : { home: b, away: a }
    }

    function placeGameAtWeek(a, b, week) {
      // Mutate teams' refs and state
      const { home, away } = pickHomeAway(a, b)
      home.ref.weeks[week] = { type: 'oocGame', opponent: away.name, away: false }
      away.ref.weeks[week] = { type: 'oocGame', opponent: home.name, away: true }
      a.totalGames++
      b.totalGames++
      home.homeGames++
      away.awayGames++
      a.oocRemaining--
      b.oocRemaining--
      a.playedOpp.add(b.key)
      b.playedOpp.add(a.key)
      // remove week from available lists
      a.availableWeeks = a.availableWeeks.filter(w => w !== week)
      b.availableWeeks = b.availableWeeks.filter(w => w !== week)
    }

    function undoGameAtWeek(a, b, week) {
      // Reverse placeGameAtWeek; assumes no other content in those cells
      const ar = a.ref.weeks[week]
      const br = b.ref.weeks[week]
      a.ref.weeks[week] = { type: 'empty' }
      b.ref.weeks[week] = { type: 'empty' }
      a.totalGames--
      b.totalGames--
      if (ar && ar.away === false) a.homeGames--
      if (br && br.away === true) b.awayGames--
      a.oocRemaining++
      b.oocRemaining++
      a.playedOpp.delete(b.key)
      b.playedOpp.delete(a.key)
      if (!a.availableWeeks.includes(week)) a.availableWeeks.push(week)
      if (!b.availableWeeks.includes(week)) b.availableWeeks.push(week)
    }

    // Greedy, best-effort scheduler that does not require even parity
    function tryGenerateSchedule(baseTeams, avoidWeek0) {
      const working = deepCloneTeams(baseTeams)
      const { state } = computeTeamState(working)

      const beforeRemaining = state.reduce((s, t) => s + t.oocRemaining, 0)
      const weekOrder = (() => {
        const w = Array.from({ length: 14 }, (_, i) => i)
        if (avoidWeek0) {
          // Move 0 to the end
          return w.slice(1).concat([0])
        }
        return w
      })()

      for (const w of weekOrder) {
        // Recompute eligible set for this week
        const eligible = state.filter(t => t.oocRemaining > 0 && t.availableWeeks.includes(w) && t.totalGames < 12)
        // Sort by tightest availability first
        eligible.sort((a, b) => (a.availableWeeks.length - b.availableWeeks.length) || (b.oocRemaining - a.oocRemaining))
        const used = new Set()
        for (const t of eligible) {
          if (used.has(t.key)) continue
          // Candidate opponents for this week
          const candidates = eligible
            .filter(o => o !== t && !used.has(o.key) && o.availableWeeks.includes(w) && canScheduleBetween(t, o))
            .sort((a, b) => (a.availableWeeks.length - b.availableWeeks.length) || (b.oocRemaining - a.oocRemaining) || (a.key.localeCompare(b.key)))
          const opp = candidates[0]
          if (opp) {
            placeGameAtWeek(t, opp, w)
            used.add(t.key)
            used.add(opp.key)
          }
        }
      }

      const afterRemaining = state.reduce((s, t) => s + t.oocRemaining, 0)
      const scheduled = beforeRemaining - afterRemaining

      if (beforeRemaining > 0 && scheduled === 0) {
        return { ok: false, reason: 'No valid OOC pairings available under constraints' }
      }

      return { ok: true, teams: working, unscheduled: afterRemaining, scheduledOOC: scheduled, neededOOC: beforeRemaining }
    }

    function onGenerate() {
      if (!teams.value.length) return
      generating.value = true
      resetStatus()
      setTimeout(() => {
        const result = tryGenerateSchedule(teams.value, options.avoidWeek0)
        generating.value = false
        if (result.ok) {
          teams.value = result.teams
          assignByes(teams.value, options.avoidWeek0)
          if (result.unscheduled && result.unscheduled > 0) {
            status.type = 'warning'
            status.message = `Scheduled ${result.scheduledOOC} of ${result.neededOOC} OOC games. ${result.unscheduled} remain unscheduled.`
          } else {
            status.type = 'success'
            status.message = 'Successfully generated schedule.'
          }
        } else {
          status.type = 'error'
          status.message = `Failed to generate schedule: ${result.reason}`
        }
      }, 10)
    }

    function onExport() {
      if (!teams.value.length) return
      const csv = teamsToCSV(teams.value)
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName.value ? fileName.value.replace(/\.csv$/i, '') + '-scheduled.csv' : 'schedule.csv'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }

    function cellClass(wk) {
      switch (wk.type) {
        case 'confHome': return 'bg-gray-200 text-gray-700'
        case 'confAway': return 'bg-gray-300 text-gray-800'
        case 'bye': return 'bg-amber-50 text-amber-700'
        case 'oocGame': return wk.away ? 'bg-blue-100 text-blue-800' : 'bg-green-100 text-green-800'
        case 'lockedOOC': return wk.away ? 'bg-blue-50 text-blue-700' : 'bg-green-50 text-green-700'
        case 'empty': return 'bg-white'
        default: return 'bg-white'
      }
    }

    function cellTitle(wk) {
      if (wk.type === 'confHome') return 'Conference (home)'
      if (wk.type === 'confAway') return 'Conference (away)'
      if (wk.type === 'bye') return 'Bye week'
      if (wk.type === 'oocGame' || wk.type === 'lockedOOC') return `${wk.away ? 'Away' : 'Home'} vs ${wk.opponent}`
      return 'Open week'
    }

    function assignByes(list, avoidWeek0) {
      // Distribute up to 3 BYEs per team in rounds to encourage equality
      const maxByesPerTeam = 3
      const views = list.map(t => {
        const byes = []
        const emptiesNon0 = []
        const empties0 = []
        for (let i = 0; i < t.weeks.length; i++) {
          const w = t.weeks[i]
          if (w.type === 'bye') byes.push(i)
          else if (w.type === 'empty') {
            if (i === 0) empties0.push(i)
            else emptiesNon0.push(i)
          }
        }
        return { t, byes, emptiesNon0, empties0 }
      })

      for (let r = 1; r <= maxByesPerTeam; r++) {
        for (const v of views) {
          if (v.byes.length >= r || v.byes.length >= maxByesPerTeam) continue
          let idx = -1
          if (avoidWeek0 && v.emptiesNon0.length) idx = v.emptiesNon0.shift()
          else if (v.emptiesNon0.length) idx = v.emptiesNon0.shift()
          else if (v.empties0.length) idx = v.empties0.shift()
          if (idx >= 0) {
            v.t.weeks[idx] = { type: 'bye' }
            v.byes.push(idx)
          }
        }
      }
    }

    return {
      currentTab,
      dragActive,
      fileName,
      teams,
      generating,
      errors,
      status,
      options,
      stats,
      unscheduledForTeam,
      onDrop,
      onFileChange,
      onReset,
      onGenerate,
      onExport,
      cellClass,
      cellTitle,
    }
  }
}).mount('#app')

