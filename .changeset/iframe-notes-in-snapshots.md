---
'better-playwriter': patch
---

1. **Snapshots point at embedded apps.** A page snapshot stops at the border of an iframe. When a visible iframe holds content (a calendar inside a chat app), the snapshot now ends with a line that names it and shows the call that reads it: `snapshot({ page, frame: page.frames()[1] })`. Tiny tracker frames are not listed.
2. **No empty `status` lines.** Live regions with no text no longer take lines in the default snapshot.
