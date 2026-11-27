---
'better-playwriter': patch
---

Keep busy pages usable after a snapshot. `snapshot()` left the DOM and Accessibility domains enabled, so a page that keeps changing sent every DOM change through the extension and the relay: the next snapshot timed out and the extension disconnected. Both domains are now released after the capture, which also stops Chrome from keeping the tab's accessibility tree up to date between snapshots.

Stop the relay from stalling on large results. Writing a 2 MB screenshot to `cdp.jsonl` blocked the relay for about 140 ms per message, and now takes under 1 ms. Frequent network events are no longer serialized for the log a second time.

Other speedups:

1. The extension no longer sends a debug log message for every CDP command and event, and it syncs tab groups once for a burst of tab changes.
2. `getStylesForLocator` no longer downloads the whole stylesheet for every matched rule.
3. The first command after a relay start no longer waits a fixed second, and CLI commands that never execute code start about 100 ms faster.
4. `session new --browser <profile name>` probes the profile cached under that name first, not every connected profile.
5. Screencast frames are dropped for a client that reads slower than Chrome produces them, so relay and extension memory stay bounded.
