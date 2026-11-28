---
'better-playwriter': patch
---

A page error thrown as a plain object now shows its properties: `[PAGE ERROR] Object { code: 42, reason: "no access" }` instead of `[PAGE ERROR] Object`. Patchright sessions still show the class name only, since Chrome's replayed exceptions carry no preview.
