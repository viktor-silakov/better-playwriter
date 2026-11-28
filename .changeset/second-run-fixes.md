---
'better-playwriter': patch
---

1. **The "covered by a dialog" hint ignores closed dialogs** that an app keeps hidden in the page.
2. **A ref click reaches a checkbox under its own row cell,** as in a file list where the selection cell covers the input and holds no other control.
3. **The role hint also offers `getByLabel(name, { exact: true })`** for snapshot lines that have no ref.
4. **Skill notes for mail and chat apps:** snapshot and click in one call, open a menu and pick its item in one call, and press Enter only once on a message's menu button.
