# Sessions and CLI

Use `better-playwriter` from an installed package. In a built source checkout, run `node ./playwriter/bin.js` from the repository root. Use only the browser profile and tabs the user authorizes.

## Open a tab in a Chrome profile

On macOS, `better-playwriter browser open [url] --profile <name>` opens a URL in the named Chrome profile and verifies the result. Omit the URL for a blank tab. If the matching tab is already open, the command can activate it. It works with a running Chrome window without an extension session.

Pass a verified profile name for a user who requests a particular profile. If Chrome cannot verify a unique match, stop and report it. To continue browser automation, create a session with `session new --browser <name> --tab-group docs`.

## Sessions

Each session runs in an **isolated sandbox** with its own `state` object. Use sessions to:

- Keep state separate between different tasks or agents
- Persist data (pages, variables) across multiple execute calls
- Avoid interference when multiple agents use better-playwriter simultaneously

Get a new session ID to use in commands. Always pass a short task-specific `--tab-group` name (see Tab groups):

```bash
better-playwriter session new --tab-group docs
# Session 1 created. Use with: better-playwriter -s 1 -e "..."
```

**Always use your own session** - pass `-s <id>` to all commands. Using the same session preserves your `state` between calls. Using a different session gives you a fresh `state`.

List active sessions with their tab counts and state keys:

```bash
better-playwriter session list
```

Add `--tabs` to list their URLs.

With the user's approval, `better-playwriter session prune --idle 60` ends idle local extension sessions and leaves their tabs open by default. When the relay restarts, restored local sessions keep their IDs and tabs. Reacquire `state.page` because JavaScript state is cleared.

Reset a session if the browser connection is stale or broken:

```bash
better-playwriter session reset <sessionId>
```

## Tab groups

**Always** set a custom group name for every session instead of the legacy defaults (`playwriter` locally, `remote` for browser sharing). Use a short single-word name such as `docs` or `test`. For a local dev server, use a short project name.

```bash
better-playwriter session new --tab-group docs
better-playwriter session new --tab-group scrape --tab-group-color grey
```

Colors: `grey, blue, red, yellow, green, pink, purple, cyan, orange`; otherwise color is derived from the name. Chrome can collapse or move groups. Dragging a tab between Better Playwriter groups keeps it connected; dragging it out disconnects it. Local and remote-control extension sessions only.

## Patchright

Choose the matching browser implementation when reproducing a test in a controlled environment. Start with `session new --patchright`, or switch with `session update <id> --patchright` (`--patchright false` switches back). Switching clears `state`. Tabs stay open, so look them up again by URL.

## Node API

Node programs and TypeScript SDKs use the `better-playwriter` package as a library. Use `connectViaExtension()` for SDK sessions.

```ts
import { connectViaExtension } from 'better-playwriter'

// connection: disconnects and deletes the session at scope end, also on throw. It does NOT close tabs
await using connection = await connectViaExtension({ tabGroup: 'docs' })
// page: closes the tab this script opened
await using page = await connection.browser.contexts()[0].newPage()
await page.goto('https://example.com')
```

**Always** close the tabs your script opens (`await using page` or `page.close()`). A tab you leave open stays in Chrome, so a later process can reuse it via `context.pages()`. Match the tab by its **exact** url (`p.url() === 'https://example.com/app'`), never `startsWith`/`includes`: `context.pages()` also lists tabs other sessions opened for other work. `closeTabsOnEnd: true` makes `close()` also close every tab the session opened.

To share one tab between processes (for example many SDK scripts calling `fetch` inside a signed-in site), keep the holder list inside the tab (`window.__shared`, updated with one atomic `page.evaluate`), and let the last holder call `page.close()`.

With several browsers or profiles connected, pass `selectBrowser: (browsers) => browsers.find((b) => b.id === selectedBrowserId)`. Each item has `id` (stable), `browser` (Chrome, Brave, Ghost...), `email`.

On macOS, `better-playwriter browser list` reads and caches actual local Chrome profile names via Accessibility. `better-playwriter browser identify` refreshes them. `session new --browser <name>` verifies the current name. Use the browser key when a name is unavailable or ambiguous.

## Remote access

For a relay the user explicitly makes available, connect with `BETTER_PLAYWRITER_HOST` and `BETTER_PLAYWRITER_TOKEN`. Use a trusted transport. Keep relay tokens out of command output, logs, and version control.

## Direct CDP connection (no extension needed)

Better Playwriter can connect directly to a Chrome instance via the Chrome DevTools Protocol, bypassing the browser extension entirely. This is useful for:

- Chrome running with remote debugging enabled (CI, Docker, headless environments)
- Cloud browser providers that expose a CDP endpoint (e.g. `wss://browser.example.com`)
- Any service or machine that gives you a `ws://` or `wss://` URL to a Chrome DevTools session

**Prerequisites:** you need a CDP-enabled Chrome. Either:

- Open `chrome://inspect/#remote-debugging` in Chrome
- Launch Chrome with `--remote-debugging-port=9222`
- Use `better-playwriter browser start` (enables debugging automatically)
- Use a cloud browser provider URL (no local Chrome needed)

**CLI usage:**

```bash
# Auto-discover local Chrome instances with debugging enabled
better-playwriter session new --direct

# Connect to a specific CDP endpoint (local or cloud browser provider)
better-playwriter session new --direct ws://localhost:9222/devtools/browser/...
better-playwriter session new --direct wss://browser.example.com

# Connect to a remote Chrome instance (host:port auto-resolves to ws://)
better-playwriter session new --direct 192.168.1.50:9222

# Then use the session normally
better-playwriter -s 1 -e "state.page = await context.newPage(); await state.page.goto('https://example.com')"
```

## Remote control

Browser sharing requires a configured `BETTER_PLAYWRITER_REMOTE_URL` and consent from the person sharing the browser. The remote recipient can control every enabled tab and open new tabs. Treat share links and IDs as passwords. Use **Stop sharing** to revoke access.

## Headless browser (no extension, no user browser)

Launch a headless Chrome automatically. No extension setup, no user browser involvement. Useful when the user doesn't want their personal browser used, in CI/server environments, or for fully autonomous automation.

```bash
# Install Chrome for Testing (first time only, if no Chrome is available)
better-playwriter browser install

# Launch headless Chrome and create a session
better-playwriter session new --browser headless

# Use the session normally
better-playwriter -s 1 -e "state.page = await context.newPage(); await state.page.goto('https://example.com')"
better-playwriter -s 1 -e "console.log(await snapshot({ page: state.page }))"
```

Multiple sessions reuse the same headless Chrome process. A headless session is deleted after 30 minutes with no execute; Chrome exits with the last one. Run `better-playwriter session delete <id>` when done.

If no Chrome binary is found, `better-playwriter session new --browser headless` will tell you to run `better-playwriter browser install` first to download Chrome for Testing.

## Execute code

```bash
better-playwriter -s <sessionId> -e "<code>"
```

The `-s` flag specifies a session ID (required). Get one with `better-playwriter session new --tab-group <name>`. Use the same session to persist state across commands.

**Execution timeout:** default is 10000ms. Override per call with `--timeout <ms>`, or set a new default via env:

```bash
# One-off longer timeout
better-playwriter -s 1 --timeout 120000 -e '...'

# Default for all -e/-f in this shell
export BETTER_PLAYWRITER_EXEC_TIMEOUT=30000
better-playwriter -s 1 -e '...'
```

BETTER_PLAYWRITER_EXEC_TIMEOUT is the default fallback. --timeout overrides it, and MCP clients can set the env var or pass a per-call timeout.

On timeout the code is aborted: its running and later Playwright calls fail and the global `signal` (AbortSignal) is aborted. Steps done before the timeout stay done, so check the page before retrying. In long-running code, pass `signal` to `fetch` and check `signal.aborted` in loops so it stops on timeout:

```js
for (const url of urls) {
  if (signal.aborted) break
  state.results.push(await (await fetch(url, { signal })).text())
}
```

Calls in one session run in order.

**File-based execution:** for complex multi-line code, write a `.js` file and run it with `-f` instead of fighting with bash quoting:

```bash
better-playwriter -s 1 -f ./scripts/my-automation.js
```

`-f` and `-e` cannot be used together. The file content is executed with the same sandbox context (context, state, snapshot, etc.).

**Examples:**

```bash
# Navigate to a page
better-playwriter -s 1 -e 'state.page = await context.newPage(); await state.page.goto("https://example.com")'

# Click a button
better-playwriter -s 1 -e 'await state.page.click("button")'

# Get page title
better-playwriter -s 1 -e 'await state.page.title()'

# Take a screenshot
better-playwriter -s 1 -e 'await state.page.screenshot({ path: "/absolute/path/to/screenshot.png", scale: "css" })'

# Get accessibility snapshot
better-playwriter -s 1 -e 'await snapshot({ page: state.page })'

# Get accessibility snapshot for a specific iframe
better-playwriter -s 1 -e 'const frame = await state.page.locator("iframe").contentFrame(); await snapshot({ page: state.page, frame })'
```

**Why single quotes?** Always wrap `-e` code in single quotes (`'...'`) to prevent bash from interpreting `$`, backticks, and other special characters inside your JS code. Use double quotes or backtick template literals for strings inside the JS code.

**Multiline code:**

```bash
# Preferred: use heredoc with quoted delimiter (disables all bash expansion)
better-playwriter -s 1 -e "$(cat <<'EOF'
const links = await state.page.$$eval('a', els => els.map(e => e.href));
console.log('Found', links.length, 'links');
const price = text.match(/\$[\d.]+/);
EOF
)"

# Alternative: $'...' syntax (but beware: \n and \t become special, and
# single quotes inside must be escaped as \')
better-playwriter -s 1 -e $'
const title = await state.page.title();
const url = state.page.url();
console.log({ title, url });
'
```

**Quoting rules summary:**
- **Single quotes** (`'...'`): best for one-liners. No bash expansion at all. But you cannot include a literal single quote inside — use double quotes for JS strings instead.
- **Heredoc** (`<<'EOF'`): best for multiline code. The quoted `'EOF'` delimiter disables all bash expansion. Any character works inside, including `$`, backticks, and single quotes.
- **`$'...'`**: allows `\'` escaping but `\n`, `\t`, `\\` become special — conflicts with JS regex patterns.

## Execute from file

For longer scripts, use `-f` instead of `-e` to execute JavaScript from a file:

```bash
better-playwriter -s 1 -f script.js
```

The file is read from disk and executed in the same sandbox as `-e`. All context variables (`state`, `context`, etc.) are available. `-e` and `-f` cannot be used together.

For an action whose result you may need to check after a disconnect, get an ID with `better-playwriter execute id` and pass it as `--execution-id <id>`. Check `better-playwriter execute status <sessionId> <id>` and verify the page before retrying an interrupted action.
