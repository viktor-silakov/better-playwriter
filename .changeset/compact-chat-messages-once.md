---
'better-playwriter': patch
---

Compact snapshots show a chat message once. A message group is named with its whole text, and the blocks inside it repeat that text, so each message took three times its length. A node whose name its named ancestor already contains is now left out. Condensing an oversized snapshot keeps message groups and the full text of content lines; only control names are shortened.
