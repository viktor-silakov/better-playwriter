---
'better-playwriter': patch
---

**An action stopped by the 15 s cap says how to wait longer.** When a call with a long timeout fails because a click or wait reached the 15 s action limit, the error names the fix: give that action its own `timeout`.
