---
'better-playwriter': patch
---

1. **Missing elements fail fast.** Actions and waits now give up after half the execute timeout (5 seconds by default) instead of 60 seconds. A wrong locator returns its own error and call log instead of running into the execute timeout. For slow content pass `timeout` to the action or raise the execute timeout.
2. **Faster session start by Chrome profile name.** A name already verified on the current extension connection is trusted, so `session new --browser <profile name>` no longer opens a probe tab every time. The name is verified again after the extension reconnects.
3. **No 3 second stall on web workers.** The relay answered `Runtime.enable` for a worker only after a 3 second timeout. It now answers as soon as the worker context exists.
4. **Clearer logs.** A relay on a non-default port writes `relay-server-<port>.log` and `cdp-<port>.jsonl`, every relay log line starts with a timestamp, and console events in the CDP log are cut to 300 characters without stack traces.
