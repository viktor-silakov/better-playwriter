# Diagnostics

## Debugging Better Playwriter issues

Start with `better-playwriter doctor --browser <key>` to check the relay, profile, and attached tabs. Use `better-playwriter logfile` for detailed logs:

```bash
better-playwriter logfile  # prints the log file path
# typically: ~/.better-playwriter/relay-server.log (relay-server-<port>.log on a non-default port)
```

The relay log contains logs from the extension, MCP and WS server. A separate CDP JSONL log is created alongside it (see `better-playwriter logfile`) with all CDP commands/responses and events, with long strings truncated. Both files are recreated every time the server starts. For debugging internal better-playwriter errors, read these files with grep/rg to find relevant lines.

Example: summarize CDP traffic counts by direction + method:

```bash
jq -r '.direction + "\t" + (.message.method // "response")' ~/.better-playwriter/cdp.jsonl | uniq -c
```

If you find a bug, prepare a minimal reproduction with synthetic data. Ask the user before sending it outside their machine.

**inspect** - get layout, scroll, visibility, input state, and aria attributes for a locator as formatted text. Use this instead of `page.evaluate()` for element inspection:

```js
const info = await inspect({ locator: state.page.locator('.sidebar') })
console.log(info)
// Element: div.sidebar
// Box: x=1000 y=144 w=396 h=756
// Children: 4  Text length: 1832
// Scroll Y: size=1200 client=756 overflowing=true top=0
// Scroll X: size=396 client=396 overflowing=false left=0
// Styles: overflow-y=auto overflow-x=visible position=sticky max-height=756px display=flex flex-direction=column flex-shrink=0

// Visibility line only appears when something is non-default:
// Visibility: opacity=0 pointer-events=none

// Input line only appears for form elements:
// Input: value="hello" checked=true disabled

// Aria line only appears when aria attributes are set:
// Aria: aria-expanded=true aria-selected=false

// Custom CSS properties
const info = await inspect({
  locator: state.page.locator('.card'),
  properties: ['background-color', 'border-radius', 'gap', 'padding']
})
```

Default CSS properties: `overflow-y`, `overflow-x`, `position`, `max-height`, `display`, `flex-direction`, `flex-shrink`. Override with the `properties` array. Visibility, input state, and aria attributes are always checked regardless of `properties`.

**getLatestLogs** - retrieve captured browser console logs and page errors (up to 5000 per page):

Always use this helper when inspecting browser logs. Do not attach new `page.on('console')` listeners for debugging because they only see future events and can miss logs emitted during page startup or hydration.

Uncaught errors from pages assigned directly to `state` keys also appear automatically in execute output. `getLatestLogs()` keeps the full page log history for filtering and deeper diagnosis.

Use `sinceLastCall: true` during debugging to get only new entries. The first call includes buffered entries, and logs persist across navigations.

```js
await getLatestLogs({ page: state.page, count?, search?, sinceLastCall? })
const newLogs = await getLatestLogs({ page: state.page, sinceLastCall: true })
const errors = await getLatestLogs({ page: state.page, search: /error/i, count: 50 })
const pageLogs = await getLatestLogs({ page: state.page, count: 100 })
const hydrationErrors = await getLatestLogs({ page: state.page, search: /hydration|pageerror|React/i })
```

**waitForPageLoad** - waits until the document is complete and the page has stopped fetching and changing for `quietMs` (500), at most 5 seconds past complete. Ignores analytics and ads:

```js
await waitForPageLoad({ page: state.page, timeout?, pollInterval?, minWait?, quietMs? })
// Returns: { success, readyState, pendingRequests, waitTimeMs, timedOut }
```

**getCDPSession** - send raw CDP commands:

```js
const cdp = await getCDPSession({ page: state.page })
const metrics = await cdp.send('Page.getLayoutMetrics')
```

**getLocatorStringForElement** - get stable Playwright selector from an element:

```js
const selector = await getLocatorStringForElement(state.page.locator('[id="submit-btn"]'))
// => "getByRole('button', { name: 'Save' })"
```

**getReactSource** - get React component source location (dev mode only):

```js
const source = await getReactSource({ locator: state.page.locator('[data-testid="submit-btn"]') })
// => { fileName, lineNumber, columnNumber, componentName }
```

**getReactComponentInfo** - get best-effort React component info for an element. Returns `null` for non-React elements and never throws just because an element was not rendered by React. Source locations are usually only available in React dev builds. Props are sanitized and truncated so functions, DOM nodes, circular refs, and huge objects do not flood the output.

```js
const info = await getReactComponentInfo({ locator: state.page.locator('[data-testid="submit-btn"]') })
// => { componentName, source, hierarchy, props } | null
```

**inspectPinnedElement** - inspect a Better Playwriter pinned element and print the element `outerHTML` plus React component info when available. Used by the right-click **Copy Better Playwriter Locator** flow.

```js
await inspectPinnedElement('https://example.com', 'globalThis.playwriterPinnedElem1')
```

**getStylesForLocator** - inspect CSS styles applied to an element, like browser DevTools "Styles" panel. Useful for debugging styling issues, finding where a CSS property is defined (file:line), and checking inherited styles. Returns selector, source location, and declarations for each matching rule. See the MCP resource `styles-api.md` or the bundled resource reference.

```js
const styles = await getStylesForLocator({
  locator: state.page.locator('.btn'),
  cdp: await getCDPSession({ page: state.page }),
})
console.log(formatStylesAsText(styles))
```

**createDebugger** - set breakpoints, step through code, inspect variables at runtime. Useful for debugging issues that only reproduce in browser, understanding code flow, and inspecting state at specific points. Can pause on exceptions, evaluate expressions in scope, and blackbox framework code. See the MCP resource `debugger-api.md` or the bundled resource reference.

```js
const cdp = await getCDPSession({ page: state.page })
const dbg = createDebugger({ cdp })
await dbg.enable()
const scripts = await dbg.listScripts({ search: 'app' })
await dbg.setBreakpoint({ file: scripts[0].url, line: 42 })
// when paused: dbg.inspectLocalVariables(), dbg.stepOver(), dbg.resume()
```

**createEditor** - view and live-edit page scripts and CSS at runtime. Edits are in-memory (persist until reload). Useful for testing quick fixes, searching page scripts with grep, and toggling debug flags. See the MCP resource `editor-api.md` or the bundled resource reference.

```js
const cdp = await getCDPSession({ page: state.page })
const editor = createEditor({ cdp })
await editor.enable()
const matches = await editor.grep({ regex: /console\.log/ })
await editor.edit({ url: matches[0].url, oldString: 'DEBUG = false', newString: 'DEBUG = true' })
```

## pinned elements

Users can right-click → "Copy Better Playwriter Locator" (works even on tabs not yet enabled; it enables them) to store elements in `globalThis.playwriterPinnedElem1` (increments for each pin). The reference is copied to clipboard:

```js
const el = await state.page.evaluateHandle(() => globalThis.playwriterPinnedElem1)
await el.click()
```

## network interception

To check recent failures after an action, call `getLatestRequests({ page: state.page, failedOnly: true, sinceLastCall: true })`. It returns recent HTTP errors and failed requests from that tab. Use `search` to narrow by method or URL.

For scraping or reverse-engineering APIs, intercept network requests instead of scrolling DOM. Store in `state` to analyze across calls:

```js
state.requests = []
state.responses = []
state.page.on('request', (req) => {
  if (req.url().includes('/api/')) state.requests.push({ url: req.url(), method: req.method(), headers: req.headers() })
})
state.page.on('response', async (res) => {
  if (res.url().includes('/api/')) {
    try {
      state.responses.push({ url: res.url(), status: res.status(), body: await res.json() })
    } catch {}
  }
})
```

Then trigger actions (scroll, click, navigate) and analyze captured data:

```js
console.log('Captured', state.responses.length, 'API calls')
state.responses.forEach((r) => console.log(r.status, r.url.slice(0, 80)))
```

Inspect a specific response to understand schema:

```js
const resp = state.responses.find((r) => r.url.includes('users'))
console.log(JSON.stringify(resp.body, null, 2).slice(0, 2000))
```

Replay API directly (useful for pagination):

```js
const { url, headers } = state.requests.find((r) => r.url.includes('feed'))
const data = await state.page.evaluate(
  async ({ url, headers }) => {
    const res = await fetch(url, { headers })
    return res.json()
  },
  { url, headers },
)
console.log(data)
```

Keep a reference to each handler you add and remove it with `state.page.off(event, handler)` when done.
