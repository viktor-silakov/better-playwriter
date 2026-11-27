---
'better-playwriter': patch
---

A Chrome profile keeps its browser key when extension storage answers slowly at startup. The extension used to stay connected under a temporary key until its next restart, so saved keys stopped matching the profile. It now reconnects under the stored key as soon as storage answers.
