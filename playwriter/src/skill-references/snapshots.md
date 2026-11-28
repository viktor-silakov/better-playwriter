# Snapshots and page content

## Choose the smallest useful view

```js
return await snapshot({ page: state.page })
```

- `mode: 'interactive'` shows controls with accessibility context. This is the default.
- `mode: 'compact'` keeps meaningful text and controls while dropping empty structure.
- `mode: 'full'` requests the full accessibility snapshot with Playwright locator strings.
- `locator` scopes the snapshot to one subtree. Pass a locator and omit `page` if convenient. Use `frame` to inspect an iframe: a page snapshot ends with a note for each visible one.
- `search` accepts a case-insensitive string or a regular expression. It reads the compact view of the whole page and returns matching lines with their refs. Combine it with a `locator` to search within a known region.
- `maxDepth` caps the rendered depth. Prefer a locator when you need a control inside a deeply nested page.
- `maxChars` controls the text budget. The interactive and compact modes default to 4,000 characters. Give an integer of at least 100. A snapshot over the budget first drops disabled, repeated and empty lines, then reports what it omitted. If the control is missing, narrow the scope or search for it. In a large app the page chrome can use up the budget: take `mode: 'compact'` with a larger `maxChars`, or scope to the pane with `getByLabel('Message list')`. A locator that matches nothing fails after 2 seconds.

```js
const form = state.page.getByRole('form', { name: 'Lookup' })
return await snapshot({ locator: form, mode: 'compact', maxDepth: 4, maxChars: 1800 })
```

A snapshot taken within 5 seconds of a navigation first waits up to 4 seconds for the page to load its content. Pass `waitForLoad: false` to skip that.

Subsequent snapshots of the same scope can return a diff when it is shorter. Use `showDiffSinceLastCall: false` for a fresh view. Search uses a fresh view by default. A navigated document needs a fresh snapshot.

Existing calls with `interactiveOnly` or `format: 'raw'` use legacy locator output. Set `mode` explicitly to choose a view.

## Act on a ref

```js
const control = await elementForRef({ page: state.page, ref: '@e5' })
await control.click()
await state.page.getByRole('status').filter({ hasText: /^Saved$/ }).waitFor({ state: 'visible' })
return 'Saved'
```

Use the ref with the page that returned it. A surviving DOM node keeps its ref within the same document. If the element is removed or its document navigates, take a new snapshot. Hints on unnamed or repeated controls help distinguish them. For a legacy locator printed by a full snapshot, use the locator with Playwright. Positional locators ending in `>> nth=N` reflect the order of matching elements at capture time.

## Read the page text

**getCleanHTML** - get cleaned HTML from a locator or page, with search and diffing:

```js
await getCleanHTML({ locator, search?, showDiffSinceLastCall?, includeStyles? })
// Examples:
const html = await getCleanHTML({ locator: state.page.locator('body') })
const html = await getCleanHTML({ locator: state.page, search: /button/i })
const fullHtml = await getCleanHTML({ locator: state.page, showDiffSinceLastCall: false })  // disable diff
```

**Parameters:**

- `locator` - Playwright Locator or Page to get HTML from
- `ref` with `page` - read the element of a snapshot ref instead of a locator: `getCleanHTML({ ref: '@e12', page: state.page })`
- `search` - string/regex to filter results (returns first 10 matching lines with 5 lines context)
- `showDiffSinceLastCall` - returns diff since last call (default: `true`, but `false` when `search` is provided). Pass `false` to get full HTML.
- `includeStyles` - keep style and class attributes (default: false)

Cleans HTML automatically: removes script/style/svg/head tags, unwraps empty wrappers, removes empty elements, truncates long values. Keeps semantic attributes (`href`, `name`, `type`, `aria-*`, `data-*`).

**getPageMarkdown** - extract main page content as plain text using Mozilla Readability (same algorithm as Firefox Reader View). Strips navigation, ads, sidebars, and other clutter. Returns formatted text with title, author, and content:

```js
await getPageMarkdown({ page: state.page, search?, showDiffSinceLastCall? })
// Examples:
const content = await getPageMarkdown({ page: state.page, showDiffSinceLastCall: false })  // full article
const matches = await getPageMarkdown({ page: state.page, search: /API/i })  // search within content
```

**Output format:**

```
# Article Title

Site: example.com | Published: 2024-01-15

> Article excerpt or description

The main article content as plain text, with paragraphs preserved...
```

**Parameters:**

- `page` - Playwright Page to extract content from
- `search` - string/regex to filter content (returns first 10 matching lines with 5 lines context)
- `showDiffSinceLastCall` - returns diff since last call (default: `true`, but `false` when `search` is provided). Pass `false` to get full content.

## Screenshots

Use an annotated screenshot when the task needs visual or spatial context. The response includes the image and accessibility snapshot. Set `ifChanged: true` for repeated shots of the same view to skip an unchanged image:

```js
await screenshotWithAccessibilityLabels({ page: state.page, ifChanged: true })
```

Use a timeout of up to 20 seconds on complex pages if the default is too short. Label colors distinguish links, buttons, inputs, checkboxes, sliders, menus, and tabs.

Always use `scale: 'css'` to avoid 2-4x larger images on high-DPI displays:

```js
await state.page.screenshot({ path: '/absolute/path/to/shot.png', scale: 'css' })
```

If you want to read back the image file into context, resize it first so it consumes fewer tokens:

```js
await resizeImageForAgent({ input: './shot.png' })
```
