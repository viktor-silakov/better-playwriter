# Browser actions

## context variables

- `state` - object persisted between calls **within your session**. Each session has its own isolated state. Use to store pages, data, listeners (e.g., `state.page = await context.newPage()`)
- `context` - browser context, access all pages via `context.pages()`, create one with `context.newPage()`
- `require` - load Node.js modules (e.g., `const fs = require('node:fs')`)
- `import()` - use Node.js ESM to load local scripts, packages, and built-ins (e.g., `const helpers = await import('./scripts/helpers.js')`). Relative paths resolve from the session cwd
- `importModule` - restricted async import for allowlisted Node.js built-ins (e.g., `const fs = await importModule('node:fs')`)
- Node.js globals: `setTimeout`, `setInterval`, `fetch`, `URL`, `Buffer`, `crypto`, `process`, etc.

**Not available in the sandbox:** `__dirname`, `__filename`, and a default `page`. Reading `page` throws. Get your own page (see "working with pages").

Keep page data, screenshots, recordings, and logs private unless the user authorizes sharing.

### importing local scripts

Local modules use normal Node.js ESM. Export helper functions from a `.js` or `.mjs` file and pass Better Playwriter values such as `page` explicitly:

```js
// scripts/page-helpers.mjs
export async function getPageInfo({ page }) {
  return {
    title: await page.title(),
    url: page.url(),
  }
}
```

Load the module from the directory where the Better Playwriter session was created:

```js
const { getPageInfo } = await import('./scripts/page-helpers.mjs')
console.log(await getPageInfo({ page: state.page }))
```

Local modules can use static imports and package imports normally:

```js
// scripts/save-title.mjs
import fs from 'node:fs/promises'
import path from 'node:path'

export async function saveTitle({ page, outputPath }) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, await page.title())
}
```

**Security:** Modules loaded with `import()` run with normal Node.js permissions. Only import code you trust. Use sandboxed `require` or `importModule` when you need restricted built-ins and scoped filesystem writes.

**Important:** `state` is **session-isolated**. Tabs your session opens are visible only to your session; tabs the user enabled are shared. See "working with pages".

**Sandboxed `fs` write restrictions:** `require('node:fs')` is scoped. Writes (writeFileSync, mkdirSync, etc.) only succeed in:
- The **session's cwd**: where `better-playwriter session new` ran, or the MCP server's working directory
- `/tmp`
- The OS temp directory (`os.tmpdir()`)

Writing to any other path (e.g. `~/Downloads`, `~/Desktop`) throws `EPERM: operation not permitted, access outside allowed directories`. To save files elsewhere, write to a temp path first, then move the file using a shell command outside the sandbox.

## common mistakes to avoid

**1. Not verifying actions succeeded**
Always check page state after important actions (form submissions, uploads, typing). Your mental model can diverge from actual browser state:

```js
await state.page.keyboard.type('my text')
await snapshot({ page: state.page, search: /my text/ })
// If verifying visual layout specifically, use screenshotWithAccessibilityLabels instead
```

**2. Assuming paste/upload worked**
Clipboard paste (`Meta+v`) can silently fail. For file uploads, prefer file input:

```js
// Reliable: use file input
const fileInput = state.page.locator('input[type="file"]').first()
await fileInput.setInputFiles('/path/to/image.png')

// No file input until a dialog opens: catch the file chooser of the upload button
const chooser = state.page.waitForEvent('filechooser')
await state.page.getByRole('menuitem', { name: 'Upload from this device' }).click()
await (await chooser).setFiles('/path/to/image.png')

// Unreliable: clipboard paste may silently fail, need to focus textarea first for example
await state.page.keyboard.press('Meta+v') // always verify with screenshot!
```

**3. Using stale locators from old snapshots**
Locators (especially ones with `>> nth=`) can change when the page updates. A navigation invalidates refs for documents it replaces. Get a fresh snapshot when a ref no longer resolves. Legacy locators ending in `>> nth=N` reflect the order of elements when the snapshot was taken:

```js
await snapshot({ page: state.page, showDiffSinceLastCall: true })
// Use one of the refs from the new snapshot
```

**4. Wrong assumptions about current page/element**
Before destructive actions (delete, submit), verify you're targeting the right thing:

```js
// Before deleting, verify it's the right item
await screenshotWithAccessibilityLabels({ page: state.page })
// READ the screenshot to confirm, THEN proceed with delete
```

**5. Text concatenation without line breaks**
`keyboard.type()` doesn't insert newlines from `\n` in strings. Use `keyboard.press('Enter')` between lines:

```js
await state.page.keyboard.type('Line 1')
await state.page.keyboard.press('Enter')
await state.page.keyboard.type('Line 2')
```

**6. Using screenshots when snapshots suffice**
Screenshots + image analysis is expensive and slow. Only use screenshots for visual/CSS issues. Use snapshot for text checks:

```js
await snapshot({ page: state.page, search: /expected text/i })
```

**7. Assuming page content loaded**
Even after `goto()`, dynamic content may not be ready:

```js
await state.page.goto('https://example.com')
// Content may still be loading via JavaScript!
await state.page.waitForSelector('article', { timeout: 10000 })
// Or use waitForPageLoad utility
await waitForPageLoad({ page: state.page, timeout: 5000 })
```

Actions and waits give up after half the execute timeout (5 seconds by default). For slow content pass `timeout` to the action or raise the execute timeout.

**8. Not using better-playwriter for JS-rendered sites**
Use the rendered page for single-page apps:

```js
state.page = await context.newPage()
await state.page.goto('https://example.com/gallery/abc123/', { waitUntil: 'domcontentloaded' })
await waitForPageLoad({ page: state.page, timeout: 8000 })
await snapshot({ page: state.page, search: /cookie|consent|accept/i }).then(console.log)
```

**9. Login buttons that open popups**
Popup windows (`window.open` with features, OAuth buttons) are auto-relocated to tabs in the main window by the Better Playwriter extension. The new tab appears in `context.pages()` and is fully controllable. You will receive a `[WARNING] New page opened from current page (index N, initial url: ...)` message pointing to the new tab — the `initial url` may be `about:blank` for blank-then-scripted popups, so check `context.pages()[N].url()` for the final URL:

```js
await state.page.locator('button:has-text("Continue with identity provider")').click()
await state.page.waitForTimeout(1000)

// New tab is the last page in the context
const pages = context.pages()
const loginPage = pages[pages.length - 1]

// Complete login flow in loginPage, cookies are shared with original page
await loginPage.getByText('me@example.com').click()
await loginPage.waitForURL('**/callback**')
// Original page should now be authenticated
```

**10. Click times out or does nothing — snapshot to find the blocker**
When a click times out, a **modal or overlay** is likely intercepting pointer events. Do not retry with different selectors or `{ force: true }` — snapshot to find the blocker:

```js
// click timed out → don't retry blindly, find what's blocking
await snapshot({ page: state.page, search: /dialog|modal/i })
// Found modal → interact with it properly (don't just close via X, it may reappear)
await state.page.getByRole('radio', { name: 'Nope, Vanilla' }).click()
```

**11. Never use `dispatchEvent` or `{ force: true }` to bypass blockers**
`dispatchEvent(new MouseEvent(...))`, `{ force: true }`, and `element.click()` inside `page.evaluate()` bypass Playwright checks but **do not trigger React/Vue/Svelte handlers** — state won't update. Use snapshot to find the real interactive element:

```js
await state.page.getByRole('radio', { name: 'Node.js' }).click()
```

**12. Over-investigating instead of just interacting**
When something doesn't respond to a click, do NOT start inspecting CDP event listeners, React fibers, canvas pixel data, or writing `page.evaluate()` to read class names and bounding boxes. This wastes massive context. Instead:

1. Take a `snapshot({ page: state.page })` — it shows every interactive element and what to click
2. Try a different interaction pattern if `click()` didn't work:
   - **Drawing/annotation tools, canvas paint** → `mouse.down`, move with steps, `mouse.up` (see drag section)
   - **Keyboard-activated modes** → press the shortcut key (snapshot shows tooltip text like "Draw mode D")
   - **Sliders, timeline scrubbers** → drag pattern
   - **Collapsed/toggled toolbars** → click the toggle first, wait, then interact
3. Take another `snapshot({ page: state.page })` to see what changed
4. Only investigate DOM internals if correct interaction patterns produce zero response after 2–3 attempts

## selector best practices

**For unknown websites**: use `snapshot({ page: state.page })` - it shows what's actually interactive with stable locators.

**For development** (when you have source code access), prefer stable selectors in this order:

1. **Best**: `[data-testid="submit"]` - explicit test attributes, never change accidentally
2. **Good**: `getByRole('button', { name: 'Save' })` - accessible, semantic
3. **Good**: `getByText('Sign in')`, `getByLabel('Email')` - readable, user-facing
4. **OK**: `input[name="email"]`, `button[type="submit"]` - semantic HTML
5. **Avoid**: `.btn-primary`, `#submit` - classes/IDs change frequently
6. **Last resort**: `div.container > form > button` - fragile, breaks easily

Combine locators for precision:

```js
state.page.locator('tr').filter({ hasText: 'Blue mug' }).locator('button').click()
```

`filter({ hasText: '' })` or `null`/`undefined` applies no filter at all. Check computed values before using them in locators.

## working with pages

**Your tabs are yours.** `context.pages()` returns the tabs your session opened (and their popups) plus tabs the user enabled with the extension icon. Other sessions never see your tabs, but user-enabled tabs are shared, so another agent may navigate or close them. To avoid interference, **get your own page**.

There is **no default `page`** in the sandbox. Reading `page` throws. Helpers that take `page` (`snapshot`, `getLatestLogs`, `waitForPageLoad`, `recording`, `ghostCursor`, `refToLocator`) need `{ page: state.page }`. `snapshot` also accepts a `locator` or `frame` from your tab.

**New task: create your own tab (first call):**

Create a tab, store it in `state`, and navigate it **in the same execute call**. Use `state.page` for all later operations:

```js
state.page = await context.newPage()
await state.page.goto('https://example.com')
```

**User points to an existing tab:**

Use a page from `context.pages()` only if the user asks you to control a tab they already opened (e.g., they're logged into an app, or they mention its URL or content). Find it by URL and take the **last** match. `context.pages()` is ordered oldest first, so the last match is the most recently opened tab:

```js
state.page = context.pages().findLast((p) => p.url().includes('example.com'))
if (!state.page) throw new Error('No example.com tab found. Ask the user to enable better-playwriter on it.')
```

**Handle page closures gracefully:**

The user may close your page by accident (e.g., closing a tab in Chrome). Check before using it and recreate if needed:

```js
if (!state.page || state.page.isClosed()) state.page = await context.newPage()
await state.page.goto('https://example.com')
```

**List all available pages:**

```js
context.pages().map((p) => p.url())
```

**Popup windows become tabs automatically:**

The extension intercepts Chrome popup windows (`window.open(url, '', 'width=...')`, OAuth login flows) and relocates them into the main window as regular tabs. You don't need cmd+click or `{ modifiers: ['Meta'] }` to avoid popups. When a page opens another, you receive a `[WARNING] New page opened from current page (index N, initial url: ...)` and can access it via `context.pages()[N]`.

## navigation

**Use `domcontentloaded`** for `page.goto()`:

```js
await state.page.goto('https://example.com', { waitUntil: 'domcontentloaded' })
await waitForPageLoad({ page: state.page, timeout: 5000 })
```

## common patterns

**Authenticated fetches** - fetch from within page context to include session cookies automatically:

```js
const data = await state.page.evaluate(async (url) => {
  const resp = await fetch(url)
  return await resp.text()
}, 'https://example.com/protected/resource')
```

**Read and set cookies** - `context.cookies(url)`, `context.addCookies()` and `route.fetch()` work. Always pass a URL to `context.cookies()`: without one it returns every cookie in the user profile. `context.clearCookies()` throws, because it would delete cookies for every site.

```js
const cookies = await context.cookies(state.page.url())
```

**NEVER use `Network.clearBrowserCookies` or `Network.clearBrowserCache`** — these CDP commands are **profile-wide destructive operations** that wipe ALL cookies/cache across every domain in the user's Chrome profile. They can log the user out of every site.

**Clear cookies for a specific domain** — use `Network.getCookies` to fetch cookies scoped to URLs, then delete them individually with `Network.deleteCookies`:

```js
const cdp = await getCDPSession({ page: state.page })
const { cookies } = await cdp.send('Network.getCookies', {
  urls: ['https://example.com', 'https://www.example.com'],
})
for (const cookie of cookies) {
  await cdp.send('Network.deleteCookies', { name: cookie.name, domain: cookie.domain })
}
```

A long string inside a returned object is cut (`... 47 more characters`): return the string itself to see all of it.

**Downloading large data** - console output truncates large strings. Trigger a browser download instead:

```js
// Fetch protected data and trigger download to user's Downloads folder
await state.page.evaluate(async (url) => {
  const resp = await fetch(url)
  const data = await resp.text()
  const blob = new Blob([data], { type: 'application/octet-stream' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'data.json'
  a.click()
}, 'https://example.com/protected/large-file')
// File saves to ~/Downloads - read it from there
```

**Avoid permission-gated browser APIs** - some APIs require user permission prompts or special browser flags. These often fail silently or hang. Examples to avoid:

- `navigator.clipboard.writeText()` - requires permission
- Multiple concurrent downloads - browser may block
- `window.showSaveFilePicker()` - requires user gesture
- Geolocation, camera, microphone APIs

Instead, use simpler alternatives (single download via `a.click()`, store data in `state`, etc).

**Downloads** - capture and save:

```js
const [download] = await Promise.all([state.page.waitForEvent('download'), state.page.click('button.download')])
await download.saveAs(`/absolute/path/${download.suggestedFilename()}`)
```

**iFrames** - two approaches depending on what you need:

```js
// frameLocator: for chaining locator operations (click, fill, etc.)
const frame = state.page.frameLocator('#my-iframe')
await frame.locator('button').click()

// contentFrame: returns a Frame object, needed for snapshot({ frame })
const frame2 = await state.page.locator('iframe').contentFrame()
await snapshot({ page: state.page, frame: frame2 })
```

**Dialogs** - handle alerts/confirms/prompts:

```js
state.page.on('dialog', async (dialog) => {
  console.log(dialog.message())
  await dialog.accept()
})
await state.page.click('button.trigger-alert')
```

**Handling page obstacles (cookie modals, login walls, age gates)** - most major websites show blocking overlays. Always check for these with `snapshot({ page: state.page })` right after navigation and dismiss them before doing anything else:

```js
// After navigating, check for common obstacles
await waitForPageLoad({ page: state.page, timeout: 5000 })
const snap = await snapshot({
  page: state.page,
  search: /cookie|consent|accept|reject|decline|allow|age|verify|login|sign.in/i,
})
console.log(snap)
// Look for dismiss/accept/decline buttons in the snapshot, then click them:
// await state.page.locator('button:has-text("Accept")').click();
// await state.page.locator('button:has-text("Decline optional")').click();
// Then re-snapshot to confirm the modal is gone before proceeding
```

If the page requires login and the user is already logged into Chrome, their session cookies are available — just navigate and the page should load authenticated. If not, hand the tab to the user with `handoff` to sign in, or use their existing logged-in tab via `context.pages()`.

**Extracting and downloading media (images, videos)** - use `page.evaluate()` to extract URLs from the rendered DOM, then download via Node.js in the sandbox. This is far more reliable than parsing raw HTML:

```js
// Extract all image URLs from rendered DOM
const images = await state.page.evaluate(() =>
  Array.from(document.querySelectorAll('img[src]')).map((img) => ({
    src: img.src,
    alt: img.alt,
    width: img.naturalWidth,
  })),
)
console.log(JSON.stringify(images, null, 2))

// Download a specific image to disk
const fs = require('node:fs')
const resp = await fetch(images[0].src)
const buf = Buffer.from(await resp.arrayBuffer())
fs.writeFileSync('./downloaded-image.jpg', buf)
console.log('Saved', buf.length, 'bytes')
```

For carousels or lazy-loaded galleries, you may need to click navigation arrows or scroll first, then re-extract. Use network interception (see "network interception" section) to capture high-resolution CDN URLs that may differ from the `img.src` thumbnails.

**handoff / waitForHandoff** - hand the tab to the user for a step only they can do. The tab comes to the front with a Better Playwriter card showing your one-line ask, and `waitForHandoff` returns once the page shows the step is done:

```js
await handoff({ page: state.page, message: 'Sign in with your account.' })
// ring one element and put the card beside it
await handoff({ page: state.page, message: 'Enter the 6-digit code.', target: state.page.locator('#otp') })
// nothing on the page shows it's done: the card gets a Done button
await handoff({ page: state.page, message: 'Approve the sign-in on your phone.', manual: true })
```

Wait in a separate execute with a long timeout, in the background if you can. It holds the session until it returns; on timeout the card stays, so wait again:

```js
await waitForHandoff({ page: state.page, until: /\/channels\/@me/ }) // URL RegExp, or a function run in the page
await waitForHandoff({ page: state.page }) // manual handoff: waits for Done
await clearHandoff({ page: state.page }) // remove the card without waiting
```

## page.evaluate

Code inside `page.evaluate()` runs in the browser - use plain JavaScript only, no TypeScript syntax. Return values and log outside (console.log inside evaluate runs in browser, not visible):

```js
const title = await state.page.evaluate(() => document.title)
console.log('Title:', title)

const info = await state.page.evaluate(() => ({
  url: location.href,
  buttons: document.querySelectorAll('button').length,
}))
console.log(info)
```

## loading files

Fill inputs with file content:

```js
const fs = require('node:fs')
const content = fs.readFileSync('./data.txt', 'utf-8')
await state.page.locator('textarea').fill(content)
```
