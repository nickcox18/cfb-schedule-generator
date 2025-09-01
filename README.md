# College Football OOC Schedule Generator

Single-page web app to generate out-of-conference (OOC) schedules from a CSV/TSV input. No backend required.

## Quick Start

- Open `index.html` in a modern browser (Chrome, Firefox, Safari, Edge).
- Drag-and-drop or choose your CSV/TSV file.
- Toggle "Avoid Week 0" if desired.
- Click "Generate Schedule" to fill OOC games.
- Click "Export CSV" to download the updated file.

## Input Format

- Columns: Team, Conference, OOC Games Needed, Weeks 0–13 (14 columns)
- Week cells: `h` = conference home, `a` = conference away, empty = open, `@Opponent` or `Opponent` = existing OOC game
- No header row expected (optional improvement: header detection)
- Comma- or tab-delimited files are supported

## Status

- Core UI, CSV parsing, basic validation, and a first-pass backtracking scheduler are implemented.
- The scheduler respects: different conferences, 12-game limit, 1 game/week, no repeats, preserve existing games, and tries to balance home/away.
- If it cannot find a valid schedule, it reports why and suggests retrying with Week 0 enabled.

## Notes

- The algorithm starts without using Week 0 (if selected) and retries including Week 0 if needed.
- Existing OOC mismatches (opponent not in file) are allowed but warned.
- Future work: richer conflict explanations, per-team stats, and algorithm tuning.
