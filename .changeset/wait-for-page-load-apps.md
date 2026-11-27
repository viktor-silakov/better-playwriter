---
'better-playwriter': patch
---

`waitForPageLoad` waits for single-page apps to show their content. It used to return as soon as the document was complete, which a mail or chat app reaches on an empty shell. It now also waits until the page has stopped fetching and changing its DOM for `quietMs` (500 ms by default), for at most 5 seconds past complete, and keeps waiting through a redirect instead of failing. Pass `quietMs: 0` for the old behavior.
