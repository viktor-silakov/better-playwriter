---
'better-playwriter': patch
---

A snapshot right after a navigation returns as soon as the page content stops changing, not when the network goes quiet. Mail and chat apps keep fetching in the background for many seconds, so the wait used to run to its 4 second limit: a mail inbox now comes back in about 3.2 seconds instead of 5. A page that is still fetching has to hold still for 750 ms, a loaded and quiet page for one check. A splash screen with only hidden controls counts as empty, so the snapshot waits for the app behind it.
