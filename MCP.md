# Better Playwriter MCP setup

Install the Better Playwriter extension and CLI, then add the server to your MCP client:

```json
{
  "mcpServers": {
    "better-playwriter": {
      "command": "better-playwriter"
    }
  }
}
```

After the npm package is published, the alternative is `"command": "npx"` with `"args": ["-y", "better-playwriter@latest"]`. In a built source checkout, use `node` with the path to `playwriter/bin.js` as its argument.

Enable the extension on a tab in Chrome. The MCP starts the relay. The first `execute` creates a default session. Each session has its own `state` and sees the tabs it opens plus tabs you enabled with the extension icon.

| Tool | Use |
| --- | --- |
| `execute` | Run Playwright code, optionally in a named session. |
| `execute_id` | Create an ID to pass to `execute` when you may need to check its status later. |
| `execute_status` | Check the status of an execution by session and ID. |
| `reset` | Reconnect a session. |
| `session_list` | List sessions, their tab counts, and available browsers. |
| `session_new` | Choose a browser key, headless Chrome, or a direct Chrome CDP endpoint. |
| `session_update` | Change the tab group or switch the Playwright implementation. |
| `session_delete` | Delete a session, optionally closing its tabs. |
| `session_prune` | End idle local extension sessions and optionally release or close the tabs they created. |

For multiple Chrome profiles, use `session_list` to get a browser key before calling `session_new`. On macOS, you can also pass a local Chrome profile name. The CLI and MCP verify the current name when selecting it. For direct Chrome DevTools Protocol, enable Chrome debugging and pass `direct: "auto"` or an explicit `ws://127.0.0.1:9222/devtools/browser/...` endpoint. Chrome may ask the user to approve the connection.

For clients on another machine, use a relay you control and set `BETTER_PLAYWRITER_HOST` and `BETTER_PLAYWRITER_TOKEN` in the MCP server environment. See the [remote relay guide](./docs/remote-access.md).
