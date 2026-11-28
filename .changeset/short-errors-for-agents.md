---
'better-playwriter': patch
---

1. **Errors and warnings show only the frames of your own code,** as `at your code, line 3, column 17`. Internal frames with local paths are gone.
2. **A Playwright call log is shorter:** each distinct line appears once, long lines are cut, and a last line says how many were left out.
