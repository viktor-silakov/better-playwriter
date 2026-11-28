---
'better-playwriter': patch
---

1. **A snapshot over its budget names what it cut.** The footer adds a line such as `[Cut: list "Messages" (57 lines), navigation "Apps" (12 lines)]`, so you know which region to scope to.
2. **A click under a dialog names the dialog.** The error adds `[HINT: The target is covered by the dialog "Discard draft?" …]` next to Playwright's "intercepts pointer events".
3. **A long string inside a returned object is cut at 4,000 characters, not 1,000,** and the output says to return the string by itself to get all of it.
