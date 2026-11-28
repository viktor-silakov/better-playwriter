---
'better-playwriter': patch
---

1. **Navigation waits longer when the call does.** `goto` and other navigations wait three quarters of the execute timeout, at least 10 s. Before, a slow page failed its `goto` at 10 s even with `--timeout 60000`.
2. **A thrown string keeps its whole text in page errors.** `throw 'Loader:Create failed'` printed `reate failed`: Playwright split it at the first colon and dropped the next character.
3. **The scrolling-list note names the row attribute when only most rows carry it**, as in a history that mixes messages with date separators: `Track rows by [data-id] (20 of 30 rows have it)`.
4. **Skill: take names from a snapshot, not from memory**, and `elementForRef` returns an ElementHandle. The index hint points to `scrollRegion`.
