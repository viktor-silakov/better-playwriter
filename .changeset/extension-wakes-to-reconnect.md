---
'better-playwriter': patch
---

The extension reconnects by itself after the relay was down for a while. Chrome stops the extension's idle service worker after about 30 seconds, and a stopped worker could not notice that the relay was back: the CLI reported "Extension did not connect within timeout" and listed only the headless browser until someone touched that Chrome profile. The extension now wakes every 30 seconds to reconnect. It asks for the `alarms` permission, which shows no prompt.
