---
'better-playwriter': patch
---

1. **`getPageMarkdown` works on web apps.** On pages that enforce Trusted Types (chat and mail apps) it failed with "This document requires 'TrustedHTML' assignment". It now returns the page text there. When a page has no article, it returns the main region with the open item instead of toolbar tooltips, and squeezes runs of blank lines.
2. **Date grids no longer fill a snapshot.** An oversized snapshot keeps three day cells of a mini calendar or a long page-number row and drops rows that only repeat the names of their cells, so calendar events stay visible.
3. **Leaner compact snapshots.** Nested nodes with the same name (a cell inside a cell, a button with its icon) take one line.
