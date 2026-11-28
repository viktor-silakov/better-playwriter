---
'better-playwriter': patch
---

1. **A snapshot marks an editable element that `getByRole` cannot find with `[use ref]`,** so the agent acts on the ref and does not wait for a timeout.
2. **Errors of the page's own scripts are labelled `[ERROR IN PAGE SCRIPT]`,** not `[PAGE ERROR]`, so they do not read as a failure of the call.
