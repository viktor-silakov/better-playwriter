---
'better-playwriter': patch
---

1. **A snapshot notes a list that scrolls inside the page,** where rows off screen may not be loaded: `[scrolls: listbox "Rows" shows about 10% of its height …]`.
2. **A timeout on a locator that ends with an index** hints to check `count()` and to scroll the list.
3. **The execute timeout error names the fix:** `--timeout <ms>` on the CLI, the timeout argument in MCP. The skill states the 10 second default.
4. **The URL line of a snapshot cuts a long query or hash.** `page.url()` still has all of it.
5. **Page errors print once each, three at most per call,** with a pointer to the rest.
6. **Skill: a recipe for a list that loads more as it scrolls.**
