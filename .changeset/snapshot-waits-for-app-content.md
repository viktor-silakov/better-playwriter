---
'better-playwriter': patch
---

1. **`goto` then `snapshot` shows the app.** A single-page app is still an empty shell when `goto(..., { waitUntil: 'domcontentloaded' })` returns, so the snapshot showed a progress bar or nothing. A snapshot taken within 5 seconds of a navigation now waits up to 4 seconds for the page to load its content, also after an in-app navigation such as opening a calendar. Pass `waitForLoad: false` to skip the wait.
2. **`waitForPageLoad` sees requests in flight.** A page cannot see its own unfinished requests, so a bundle still downloading looked like a quiet page. The wait now also counts requests the browser has open, except long polls and streams.
