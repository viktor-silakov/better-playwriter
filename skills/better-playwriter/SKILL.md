---
name: better-playwriter
description: Use Better Playwriter to inspect, test, or operate Chrome through a local CLI session with Playwright. Use when the user asks for Better Playwriter or an existing Better Playwriter browser session. It also supports headless Chrome for local testing.
---

Run `better-playwriter skill` for session instructions, selectors, and API reference. If the CLI is unavailable in a built source checkout, run `node ./playwriter/bin.js skill` from its root.

Use the Chrome profile and tabs the user authorizes. Prefer a headless session for local tests. Keep snapshots, recordings, account details, and secrets local unless the user authorizes sharing. Follow the user's instructions for actions that affect other people or systems.

```bash
better-playwriter session new --tab-group docs
better-playwriter -s 1 -e 'state.page = await context.newPage(); await state.page.goto("https://example.com"); console.log(await snapshot({ page: state.page }))'
better-playwriter session delete 1 --close-created-tabs
```

Use the session ID the CLI returns. Use single quotes around `-e` JavaScript in POSIX shells and save the tab in `state.page` when you need it again.
