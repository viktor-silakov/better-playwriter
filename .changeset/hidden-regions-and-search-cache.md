---
'better-playwriter': patch
---

1. **A snapshot points at visible regions the page hides from the accessibility tree.** Some apps mark an open panel `aria-hidden="true"`, so it was missing from the snapshot without a word. The snapshot now ends with `[visible region not included: … Read it with getCleanHTML({ locator: page.locator('…') })]`.
2. **A search no longer hides the next change.** `snapshot({ search })` stored the whole page as already shown, so the next snapshot answered "No changes since last snapshot" about content the search never returned.
