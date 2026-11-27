---
'better-playwriter': patch
---

Snapshots are about 30% faster on large pages. The relay wrote every accessibility tree and flattened document to the CDP log in full, a megabyte per snapshot in each direction, and stalled while serializing it. The log now records how many items such a list had. Set `BETTER_PLAYWRITER_CDP_LOG_MAX_ARRAY_LENGTH` to keep longer lists.
