---
'better-playwriter': patch
---

`stream start` works with ffmpeg 9. ffmpeg 9 rejects `-thread_queue_size` before an input and exited right away with "cannot be applied to input url". Better Playwriter now asks the installed ffmpeg once and leaves the option out when it is not accepted.
