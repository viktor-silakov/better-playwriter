---
'better-playwriter': patch
---

1. **`refToLocator` accepts a ref with `@`,** as snapshots print it: `refToLocator({ ref: '@e12', page })`.
2. **A fault from code that already returned is labelled `[WARNING from an earlier call]`,** so a forgotten `await` is not read as a problem of the current call.
