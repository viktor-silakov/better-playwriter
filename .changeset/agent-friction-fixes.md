---
'better-playwriter': patch
---

1. **`snapshot({ search })` returns refs.** A search now reads the compact view, so matches come as `button "Send" @e12` with page text included, not as legacy `role=…` locator lines. Pass `interactiveOnly` or `format: 'raw'` for the old output.
2. **A snapshot scope that matches nothing fails in 2 seconds** with `snapshot: the locator matched 0 elements`, not after the whole timeout with a `locator.elementHandle` error.
3. **A role that finds nothing points to the ref.** When `getByRole` times out, the error adds a hint to act on the snapshot ref: Chrome and Playwright can name an element's role differently, for example an editable div without a role.
4. **`session new` prints the bound profile and `session delete --close-created-tabs` prints how many tabs it closed.**
5. **Error text has no ANSI colour codes.**
