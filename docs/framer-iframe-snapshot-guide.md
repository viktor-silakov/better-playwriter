---
title: Framer Plugin Iframe Snapshot Guide
description: Step-by-step instructions to open the Framer MCP plugin iframe and run snapshot on it.
---

## Step-by-step

- Open your Framer project in an already running Chrome profile and connect the tab with Better Playwriter.
- Use `better-playwriter browser list` to find the profile and create a session with `better-playwriter session new --browser <browser-key> --tab-group framer`. Set `SESSION_ID` to the returned ID.
- Replace `YOUR_PROJECT_URL` with the exact URL of the connected tab.

```bash
better-playwriter -s "$SESSION_ID" -e "state.page = context.pages().findLast(p => p.url() === 'YOUR_PROJECT_URL'); if (state.page === undefined) throw new Error('Connect the Framer editor tab first.');"
```

- Wait for the editor UI to finish loading (toolbar visible) before opening the command palette.

- Press Command+K to open the command palette.

- Verify the palette is open (look for the command dialog and MCP entry in the snapshot output):

```bash
better-playwriter -s "$SESSION_ID" -e "console.log(await snapshot({ page: state.page, search: /dialog|Search…|MCP/ }));"
```

- Search for **MCP**, press Enter, then wait about 1 second for the plugin iframe to appear.

- Wait until the MCP iframe is present (verifies the action worked):

```bash
better-playwriter -s "$SESSION_ID" -e "const iframe = state.page.locator(\"iframe[src*='plugins.framercdn.com']\"); await iframe.first().waitFor({ timeout: 10000 }); console.log('iframe ready');"
```

- Grab the iframe’s locator by URL:

```bash
better-playwriter -s "$SESSION_ID" -e "const iframe = state.page.locator(\"iframe[src*='plugins.framercdn.com']\"); console.log(await iframe.count());"
```

- Run the accessibility snapshot on that iframe using `contentFrame()` (FrameLocator is auto-resolved to Frame):

```bash
better-playwriter -s "$SESSION_ID" -e "const frame = await state.page.locator(\"iframe[src*='plugins.framercdn.com']\").contentFrame(); console.log(await snapshot({ page: state.page, frame }));"
```

- Alternative: use `state.page.frames()` to get the Frame directly:

```bash
better-playwriter -s "$SESSION_ID" -e "const frame = state.page.frames().find(f => f.url().includes('plugins.framercdn.com')); console.log(await snapshot({ page: state.page, frame }));"
```

- Validate the snapshot contains MCP UI text (confirms the panel is actually loaded):

```bash
better-playwriter -s "$SESSION_ID" -e "const frame = await state.page.locator(\"iframe[src*='plugins.framercdn.com']\").contentFrame(); console.log(await snapshot({ page: state.page, frame, search: /Control Framer with MCP|Login With Google/ }));"
```

## Expected iframe URL

- The hostname ends in `plugins.framercdn.com`.
