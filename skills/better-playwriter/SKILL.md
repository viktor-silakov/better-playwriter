---
name: better-playwriter
description: Use Better Playwriter to open a tab in a named Chrome profile, or inspect, test, or operate Chrome through a Playwright session.
---

Run `better-playwriter skill` for the core workflow and load details with `better-playwriter skill --ref <topic>`. In a built source checkout, you can run `node ./playwriter/bin.js skill` from its root.

An explicitly named profile must be verified before opening or inspecting a tab. For an open-only request on macOS, use `better-playwriter browser open [url] --profile <name>`. Prefer a headless session for local tests. Keep snapshots, recordings, account details, and secrets local unless the user authorizes sharing.

```bash
better-playwriter session new --tab-group docs
better-playwriter -s 1 -e 'state.page = await context.newPage(); await state.page.goto("https://example.com"); console.log(await snapshot({ page: state.page }))'
better-playwriter session delete 1 --close-created-tabs
```

Use the session ID the CLI returns. Use single quotes around `-e` JavaScript in POSIX shells and save the tab in `state.page` when you need it again.
