---
'better-playwriter': patch
---

1. **`getCleanHTML` reads a snapshot ref.** `getCleanHTML({ ref: '@e12', page })` returns the HTML of that element, for elements no role or label locator finds.
2. **A covered control with no dialog open gets a keyboard hint.** The error for "intercepts pointer events" suggests focus and Enter, which opens controls that show only on hover, such as a chat message's menu button.
