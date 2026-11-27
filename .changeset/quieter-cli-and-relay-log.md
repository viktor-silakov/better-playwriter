---
'better-playwriter': patch
---

1. **Less noise from the CLI.** `session new`, `browser list` and `doctor` print "Waiting for extension to connect..." and "Extension connected" only when they actually had to wait.
2. **A smaller, truer relay log.** The text log no longer has a line for every console message of the page (more than half of its lines on a chat app; the messages stay in the CDP log), and no longer reports a `Runtime.enable` timeout for a worker that closed before it could answer.
