---
'better-playwriter': patch
---

1. **Snapshots of large web apps show the content.** A snapshot over its size budget now drops disabled controls, empty status regions, per-row buttons repeated more than three times and labels that repeat their control, and indents by real depth. A mail or chat list fits the default 4,000 characters instead of being cut off after the toolbar. The closing note says how many lines of each kind were left out.
2. **Compact snapshots keep a consistent tree.** Children are no longer indented deeper or shallower than their siblings.
3. **A snapshot right after navigation works.** When the page redirects while the snapshot is taken, the snapshot waits for the next document instead of failing with "Cannot find context with specified id".
4. **Fewer wrong reset hints.** A script's own error no longer comes with advice to reset the session. A navigation in flight gets its own hint.
