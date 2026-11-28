import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'
import { createSimpleServer } from './test-utils.js'

describe('agent snapshot views', () => {
  let executor: PlaywrightExecutor

  beforeAll(() => {
    executor = new PlaywrightExecutor({
      cdpConfig: { headless: true },
      logger: { log() {}, error() {} },
    })
  })

  afterAll(async () => {
    await executor.dispose()
  })

  it('limits the default view, keeps late status text, and resolves a reference after an identical control is inserted', async () => {
    const buttons = Array.from({ length: 250 }, (_, index) => `<button>Item ${index}</button>`).join('')
    const fixture = `
      <main>
        <p>Visible reading text</p>
        <button id="original" onclick="document.body.dataset.clicked = 'original'">Test card</button>
        ${buttons}
        <div role="status">Ready for lookup</div>
      </main>
    `
    const first = await executor.execute(`
      state.page = await context.newPage()
      await state.page.setContent(${JSON.stringify(fixture)})
      return await snapshot({ page: state.page })
    `)
    expect(first.isError).toBe(false)
    expect(first.text.length).toBeLessThan(4200)
    expect(first.text).toContain('Ready for lookup')
    expect(first.text).toContain('snapshot lines omitted')
    expect(first.text).not.toContain('Visible reading text')
    const ref = first.text.match(/button "Test card" (@e\d+)/)?.[1]
    expect(ref).toBeDefined()

    const afterInsert = await executor.execute(`
      await state.page.locator('#original').evaluate((element) => {
        element.insertAdjacentHTML('beforebegin', '<button>Test card</button>')
      })
      const refreshed = await snapshot({ page: state.page, showDiffSinceLastCall: false })
      const target = await elementForRef({ page: state.page, ref: ${JSON.stringify(ref)} })
      await target.click()
      return { sameRef: refreshed.includes('Test card" ' + ${JSON.stringify(ref)}), clicked: await state.page.locator('body').getAttribute('data-clicked') }
    `)
    expect(afterInsert.isError).toBe(false)
    expect(afterInsert.text).toContain('sameRef: true')
    expect(afterInsert.text).toContain("clicked: 'original'")

    const compact = await executor.execute(`snapshot({ locator: state.page.locator('main'), mode: 'compact' })`)
    expect(compact.isError).toBe(false)
    expect(compact.text).toContain('Visible reading text')

    const stale = await executor.execute(`
      await state.page.goto('data:text/html,%3Cbutton%3ETest%20card%3C%2Fbutton%3E')
      const next = await snapshot({ page: state.page })
      if (next.includes('Test card" ' + ${JSON.stringify(ref)})) throw new Error('Old reference was reused')
      await elementForRef({ page: state.page, ref: ${JSON.stringify(ref)} })
    `)
    expect(stale.isError).toBe(true)
    expect(stale.text).toContain('Take a fresh snapshot.')
  })

  it('snapshots a page that keeps changing and leaves no DOM events behind', async () => {
    const result = await executor.execute(`
      state.busyPage = await context.newPage()
      await state.busyPage.setContent('<main><button>Busy action</button>' + '<span>cell</span>'.repeat(500) + '</main>')
      await state.busyPage.evaluate(() => {
        const cells = [...document.querySelectorAll('span')]
        let turn = 0
        const tick = () => {
          for (const cell of cells) { cell.textContent = 'cell ' + turn; cell.setAttribute('data-turn', String(turn)) }
          turn++
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      const cdp = await getCDPSession({ page: state.busyPage })
      let domEvents = 0
      const count = () => { domEvents++ }
      cdp.on('DOM.attributeModified', count)
      cdp.on('DOM.characterDataModified', count)
      cdp.on('DOM.childNodeInserted', count)
      const first = await snapshot({ page: state.busyPage, showDiffSinceLastCall: false })
      const second = await snapshot({ page: state.busyPage, showDiffSinceLastCall: false })
      await state.busyPage.waitForTimeout(500)
      const turns = await state.busyPage.evaluate(() => Number(document.querySelector('span').getAttribute('data-turn')))
      await state.busyPage.close()
      return { found: first.includes('Busy action') && second.includes('Busy action'), domEvents, pageKeptChanging: turns > 5 }
    `, { timeout: 30000 })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('found: true')
    expect(result.text).toContain('pageKeptChanging: true')
    // A few events can slip in while Chrome handles the disable right behind the document request
    const domEvents = Number(result.text.match(/domEvents: (\d+)/)?.[1])
    expect(domEvents).toBeLessThan(2000)
  })

  it('waits for a single-page app to stop fetching before calling the page loaded', async () => {
    const fetching = (script: string) => `<title>App</title><div id="root"></div><script>${script}</script>`
    const server = await createSimpleServer({
      routes: {
        '/data': 'ok',
        // The shell fires load at once, then fetches for about a second before it shows anything.
        '/app': fetching(`
          let left = 7
          const next = () => fetch('/data?' + left).then(() => {
            if (--left > 0) return setTimeout(next, 150)
            document.querySelector('#root').innerHTML = '<button>Loaded</button>'
          })
          next()
        `),
        // Content is on screen at once, and the app keeps fetching in the background for good.
        '/busy': fetching(`document.querySelector('#root').innerHTML = '<button>Inbox</button>'; setInterval(() => fetch('/data?' + Date.now()), 100)`),
        // A shell with a menu, whose rows arrive 600 ms later while it keeps fetching.
        '/shell': fetching(`
          document.querySelector('#root').innerHTML = '<nav><a href="#m">Mail</a></nav><ul></ul>'
          setInterval(() => fetch('/data?' + Date.now()), 100)
          setTimeout(() => { document.querySelector('ul').innerHTML = Array.from({ length: 20 }, (_, i) => '<li><a href="#' + i + '">Message ' + i + '</a></li>').join('') }, 600)
        `),
        // A splash that fetches nothing for almost two seconds while the app's scripts start.
        '/splash': fetching(`document.querySelector('#root').insertAdjacentHTML('beforebegin', '<div style="display:none"><button>Hidden</button></div>'); setTimeout(() => { document.querySelector('#root').innerHTML = '<button>Chats</button>' }, 1800)`),
        '/heartbeat': fetching(`setInterval(() => fetch('/data?' + Date.now()), 100)`),
        // A sign-in hop: the first document is complete and quiet, then leaves for the real app.
        '/hop': '<title>Hop</title><script>setTimeout(() => location.replace("/app"), 300)</script>',
      },
    })
    try {
      const result = await executor.execute(`
        const appPage = await context.newPage()
        const loadedButtons = () => appPage.getByRole('button', { name: 'Loaded' }).count()
        await appPage.goto(${JSON.stringify(server.baseUrl)} + '/app')
        const shell = await waitForPageLoad({ page: appPage, quietMs: 0 })
        const shellButtons = await loadedButtons()
        await appPage.goto(${JSON.stringify(server.baseUrl)} + '/app')
        const app = await waitForPageLoad({ page: appPage })
        const appButtons = await loadedButtons()
        // The first example of the skill: go to the page, take a snapshot. It has to show the app.
        await appPage.goto(${JSON.stringify(server.baseUrl)} + '/app', { waitUntil: 'domcontentloaded' })
        const early = await snapshot({ page: appPage, waitForLoad: false })
        await appPage.goto(${JSON.stringify(server.baseUrl)} + '/app', { waitUntil: 'domcontentloaded' })
        const settled = await snapshot({ page: appPage })
        await appPage.goto(${JSON.stringify(server.baseUrl)} + '/busy', { waitUntil: 'domcontentloaded' })
        const busyStart = Date.now()
        const busy = await snapshot({ page: appPage })
        const busyMs = Date.now() - busyStart
        await appPage.goto(${JSON.stringify(server.baseUrl)} + '/shell', { waitUntil: 'domcontentloaded' })
        const rows = await snapshot({ page: appPage })
        await appPage.goto(${JSON.stringify(server.baseUrl)} + '/splash', { waitUntil: 'domcontentloaded' })
        const splash = await snapshot({ page: appPage })
        await appPage.goto(${JSON.stringify(server.baseUrl)} + '/hop')
        const hop = await waitForPageLoad({ page: appPage })
        const hopButtons = await loadedButtons()
        await appPage.goto(${JSON.stringify(server.baseUrl)} + '/heartbeat')
        const heartbeat = await waitForPageLoad({ page: appPage, timeout: 20000 })
        await appPage.close()
        return JSON.stringify({ shell, shellButtons, app, appButtons, early, settled, busy, busyMs, rows, splash, hop, hopButtons, heartbeat })
      `, { timeout: 40000 })
      expect(result.isError).toBe(false)
      const { shell, shellButtons, app, appButtons, early, settled, busy, busyMs, rows, splash, hop, hopButtons, heartbeat } = JSON.parse(result.text.replace('[return value] ', ''))
      expect(early).not.toContain('Loaded')
      expect(settled).toContain('button "Loaded"')
      // Content that holds still is enough: the snapshot does not wait out the background fetching.
      expect(busy).toContain('button "Inbox"')
      expect(busyMs).toBeLessThan(2500)
      // A shell that is still fetching gets time for its rows.
      expect(rows).toContain('Message 19')
      expect(splash).toContain('button "Chats"')
      // Without the quiet wait the page counts as loaded while it is still empty.
      expect({ success: shell.success, shellButtons }).toEqual({ success: true, shellButtons: 0 })
      expect({ success: app.success, appButtons }).toEqual({ success: true, appButtons: 1 })
      // A redirect in the middle of the wait leads to the page that counts.
      expect({ success: hop.success, hopButtons }).toEqual({ success: true, hopButtons: 1 })
      // A page that never stops fetching is still reported as loaded, after a bounded wait.
      expect(heartbeat).toMatchObject({ success: true, timedOut: false })
      expect(heartbeat.waitTimeMs).toBeGreaterThan(4000)
      expect(heartbeat.waitTimeMs).toBeLessThan(9000)
    } finally {
      await server.close()
    }
  }, 60000)

  it('notes a list that scrolls inside the page and explains an index past the last row', async () => {
    const result = await executor.execute(`
      const listPage = await context.newPage()
      const rows = Array.from({ length: 40 }, (_, i) => '<div role="option" style="height:30px">Row ' + (i + 1) + '</div>').join('')
      await listPage.setContent('<main><div style="height:120px;overflow-y:auto"><div role="listbox" aria-label="Rows">' + rows + '</div></div><ul><li>One</li><li>Two</li></ul></main>')
      state.listPage = listPage
      const whole = await snapshot({ page: listPage, mode: 'compact', showDiffSinceLastCall: false })
      const scoped = await snapshot({ locator: listPage.getByRole('listbox'), mode: 'compact', showDiffSinceLastCall: false })
      return JSON.stringify({ whole: whole.split('\\n').filter((line) => line.startsWith('[scrolls')), scoped: scoped.split('\\n').filter((line) => line.startsWith('[scrolls')) })
    `, { timeout: 30000 })
    expect(result.isError).toBe(false)
    const { whole, scoped } = JSON.parse(result.text.replace('[return value] ', ''))
    expect(whole).toMatchInlineSnapshot(`
      [
        "[scrolls: listbox "Rows" has 40 rows in the page and shows 10% of its height. More rows load as it scrolls: await scrollRegion({ locator: page.getByLabel('Rows', { exact: true }).first(), by: -1500 }), negative is up. Recipe: skill --ref actions, "Collect a list".]",
      ]
    `)
    expect(scoped).toEqual(whole)
    // The scroller is the wrapper above the listbox, and a plain labelled div counts as a list too.
    const scrolled = await executor.execute(`
      const down = await scrollRegion({ locator: state.listPage.getByRole('listbox'), by: 300 })
      const again = await scrollRegion({ locator: state.listPage.getByRole('option').first(), by: 100000 })
      await state.listPage.setContent('<div aria-label="Thread" style="height:100px;overflow-y:auto"><div>' + Array.from({ length: 30 }, (_, i) => '<div style="height:30px">Message ' + i + '</div>').join('') + '</div></div>')
      const plain = await snapshot({ page: state.listPage, mode: 'compact', showDiffSinceLastCall: false })
      return JSON.stringify({ down, again, plain: plain.split('\\n').filter((line) => line.startsWith('[scrolls')) })
    `, { timeout: 30000 })
    expect(scrolled.isError).toBe(false)
    const { down, again, plain } = JSON.parse(scrolled.text.replace('[return value] ', ''))
    expect(down).toMatchObject({ scrolled: true, top: 300, atStart: false, atEnd: false })
    expect(again).toMatchObject({ scrolled: true, atEnd: true })
    expect(plain).toMatchInlineSnapshot(`
      [
        "[scrolls: div "Thread" has 30 rows in the page and shows 11% of its height. More rows load as it scrolls: await scrollRegion({ locator: page.getByLabel('Thread', { exact: true }).first(), by: -1500 }), negative is up. Recipe: skill --ref actions, "Collect a list".]",
      ]
    `)
    await executor.execute(`
      const rows = Array.from({ length: 40 }, (_, i) => '<div role="option" style="height:30px">Row ' + (i + 1) + '</div>').join('')
      await state.listPage.setContent('<main><div style="height:120px;overflow-y:auto"><div role="listbox" aria-label="Rows">' + rows + '</div></div></main>')
    `)
    const miss = await executor.execute(`await state.listPage.getByRole('option').nth(60).click({ timeout: 500 })`, { timeout: 10000 })
    expect(miss.isError).toBe(true)
    expect(miss.text).toContain('check count() first')
  }, 60000)

  it('searches with refs, fails fast on an empty scope, and points to the ref when a role finds nothing', async () => {
    const result = await executor.execute(`
      const formPage = await context.newPage()
      await formPage.setContent('<main><p>Quarterly report is ready</p><div contenteditable aria-label="To"></div><button>Send</button></main>')
      const found = await snapshot({ page: formPage, search: 'send' })
      const text = await snapshot({ page: formPage, search: /quarterly/i })
      const started = Date.now()
      const empty = await snapshot({ locator: formPage.getByRole('navigation') }).catch((error) => error.message)
      const emptyMs = Date.now() - started
      state.formPage = formPage
      return JSON.stringify({ found, text, empty, emptyMs })
    `, { timeout: 30000 })
    expect(result.isError).toBe(false)
    const { found, text, empty, emptyMs } = JSON.parse(result.text.replace('[return value] ', ''))
    expect(found).toMatch(/button "Send" @e\d+/)
    expect(found).not.toContain('role=')
    expect(text).toContain('Quarterly report is ready')
    expect(empty).toContain('snapshot: the locator matched 0 elements')
    expect(emptyMs).toBeLessThan(4000)
    const miss = await executor.execute(`await state.formPage.getByRole('textbox', { name: 'Recipient' }).click({ timeout: 500 })`, { timeout: 10000 })
    expect(miss.isError).toBe(true)
    expect(miss.text).toContain('act on its ref instead')
    expect(miss.text).toContain('page.getByLabel(name, { exact: true })')
    // A search in between does not count as having seen the page: the next snapshot still shows what changed.
    const afterSearch = await executor.execute(`
      await state.formPage.setContent('<button aria-expanded="false" onclick="this.setAttribute(\\'aria-expanded\\', \\'true\\')">Apps</button><p>Text</p>')
      await snapshot({ page: state.formPage, mode: 'compact', showDiffSinceLastCall: false })
      await state.formPage.getByRole('button', { name: 'Apps' }).click()
      await snapshot({ page: state.formPage, search: 'no such thing' })
      const next = await snapshot({ page: state.formPage, mode: 'compact' })
      await state.formPage.setContent('<main><p>Quarterly report is ready</p><div contenteditable aria-label="To"></div><button>Send</button></main>')
      return next
    `, { timeout: 10000 })
    expect(afterSearch.text).toContain('[expanded]')
    // A panel the page hides from assistive technology while showing it: the snapshot says where it is.
    const hidden = await executor.execute(`
      await state.formPage.setContent('<button>Apps</button><div role="dialog" aria-hidden="true"><button>Files</button><button>Mail</button></div><div aria-hidden="true" style="display:none"><button>A</button><button>B</button></div>')
      const withPanel = await snapshot({ page: state.formPage, showDiffSinceLastCall: false })
      const panel = await getCleanHTML({ locator: state.formPage.locator('div[role="dialog"][aria-hidden="true"]'), showDiffSinceLastCall: false })
      await state.formPage.setContent('<main><p>Quarterly report is ready</p><div contenteditable aria-label="To"></div><button>Send</button></main>')
      return JSON.stringify({ withPanel, panel })
    `, { timeout: 10000 })
    const { withPanel, panel } = JSON.parse(hidden.text.replace('[return value] ', ''))
    expect(withPanel).not.toContain('"Files"')
    expect(withPanel.match(/visible region not included/g)).toHaveLength(1)
    expect(withPanel).toContain(`getCleanHTML({ locator: page.locator('div[role="dialog"][aria-hidden="true"]') })`)
    expect(panel).toContain('Mail')
    // A styled checkbox: the input sits under its own drawn mark.
    const styled = await executor.execute(`
      await state.formPage.setContent('<label style="position:relative;display:block;width:24px;height:24px"><input type="checkbox" aria-label="Select row" style="position:absolute;inset:0;margin:0;opacity:0"><span style="position:absolute;inset:0;background:#ccc"></span></label><button>Other</button>')
      const ref = /checkbox "Select row"[^@]*(@e\\d+)/.exec(await snapshot({ page: state.formPage, showDiffSinceLastCall: false }))[1]
      const box = await elementForRef({ ref, page: state.formPage })
      await box.click({ timeout: 2000 })
      const checked = await state.formPage.getByLabel('Select row').isChecked()
      await state.formPage.setContent('<main><p>Quarterly report is ready</p><div contenteditable aria-label="To"></div><button>Send</button></main>')
      return checked
    `, { timeout: 15000 })
    expect(styled.text).toContain('true')
    // A file list: the row's selection cell lies over its own checkbox and toggles it.
    const cell = await executor.execute(`
      await state.formPage.setContent('<div role="row"><div role="gridcell" onclick="this.querySelector(\\'input\\').checked = true" style="width:32px;height:32px"><input type="checkbox" aria-label="Select file" style="pointer-events:none"></div><div role="gridcell"><button>report.txt</button></div></div>')
      const ref = /checkbox "Select file"[^@]*(@e\\d+)/.exec(await snapshot({ page: state.formPage, showDiffSinceLastCall: false }))[1]
      await (await elementForRef({ ref, page: state.formPage })).click({ timeout: 2000 })
      const checked = await state.formPage.getByLabel('Select file').isChecked()
      await state.formPage.setContent('<main><p>Quarterly report is ready</p><div contenteditable aria-label="To"></div><button>Send</button></main>')
      return checked
    `, { timeout: 15000 })
    expect(cell.text).toContain('true')
    const html = await executor.execute(`
      const ref = /button "Send" (@e\\d+)/.exec(await snapshot({ page: state.formPage, showDiffSinceLastCall: false }))[1]
      return await getCleanHTML({ ref, page: state.formPage, showDiffSinceLastCall: false })
    `, { timeout: 10000 })
    expect(html.text).toContain('<button>Send</button>')
    // Covered with no dialog open: a hover-only control, reachable from the keyboard.
    const hover = await executor.execute(`
      await state.formPage.setContent('<button>More</button><div role="dialog" aria-label="Details" style="position:fixed;inset:0"></div><div role="dialog" aria-modal="true" aria-label="Closed" style="visibility:hidden;position:fixed;inset:0"></div>')
      await state.formPage.getByRole('button', { name: 'More' }).click({ timeout: 800 })
    `, { timeout: 10000 })
    // A side panel with the dialog role is not a modal: the hint must not blame it.
    expect(hover.text).not.toContain('covered by the dialog')
    expect(hover.text).toContain("await page.keyboard.press('Enter')")
    // A click under an open dialog names the dialog, not only the backdrop's markup.
    const covered = await executor.execute(`
      await state.formPage.setContent('<button>Save</button><div role="dialog" aria-modal="true" aria-label="Discard draft?" style="position:fixed;inset:0;background:#fff"><button>Cancel</button></div>')
      await state.formPage.getByRole('button', { name: 'Save' }).click({ timeout: 800 })
    `, { timeout: 10000 })
    expect(covered.text).toContain('covered by the dialog "Discard draft?"')
    expect(covered.text).not.toContain('\u001b[')
    await executor.execute('await state.formPage.close()')
  }, 60000)

  it('names visible iframes that a page snapshot does not include', async () => {
    const server = await createSimpleServer({
      routes: {
        '/host': '<button>Host action</button><iframe src="/calendar" width="600" height="400"></iframe><iframe src="/pixel" width="1" height="1"></iframe>',
        '/calendar': '<button>Embedded event</button>',
        '/pixel': '<p>tracker</p>',
      },
    })
    try {
      const result = await executor.execute(`
        const framePage = await context.newPage()
        await framePage.goto(${JSON.stringify(server.baseUrl)} + '/host')
        await framePage.frameLocator('iframe').first().getByRole('button').waitFor()
        const pageSnapshot = await snapshot({ page: framePage })
        const index = Number(pageSnapshot.match(/page\\.frames\\(\\)\\[(\\d+)\\]/)[1])
        const frameSnapshot = await snapshot({ page: framePage, frame: framePage.frames()[index] })
        await framePage.close()
        return JSON.stringify({ pageSnapshot, frameSnapshot })
      `)
      expect(result.isError).toBe(false)
      const { pageSnapshot, frameSnapshot } = JSON.parse(result.text.replace('[return value] ', '')) as { pageSnapshot: string; frameSnapshot: string }
      expect(pageSnapshot).toContain('Host action')
      expect(pageSnapshot).not.toContain('Embedded event')
      expect(pageSnapshot).toContain(`[iframe not included: ${server.baseUrl}/calendar. Read it with snapshot({ page, frame: page.frames()[`)
      expect(pageSnapshot).not.toContain('/pixel')
      expect(frameSnapshot).toContain('Embedded event')
      expect(frameSnapshot).not.toContain('iframe not included')
    } finally {
      await server.close()
    }
  })

  it('emits annotated screenshots only when the viewport changes', async () => {
    const paths: string[] = []
    const screenshot = 'screenshotWithAccessibilityLabels({ page: state.shotPage, ifChanged: true })'
    try {
      const first = await executor.execute(`
        state.shotPage = await context.newPage()
        await state.shotPage.setContent('<button>Capture</button>')
        await ${screenshot}
      `)
      paths.push(...first.screenshots.map((shot) => shot.path))
      expect(first.isError).toBe(false)
      expect(first.images.length).toBe(1)

      // The label on the image, the ref in the text and elementForRef name the button the same way.
      const ref = first.screenshots[0]!.snapshot.match(/button "Capture" (@e\d+)/)?.[1]
      expect(ref).toBeDefined()
      const resolved = await executor.execute(`
        const button = await elementForRef({ page: state.shotPage, ref: ${JSON.stringify(ref)} })
        return await button.evaluate((element) => element.textContent)
      `)
      expect(resolved).toMatchObject({ isError: false, text: expect.stringContaining('Capture') })

      const unchanged = await executor.execute(screenshot)
      paths.push(...unchanged.screenshots.map((shot) => shot.path))
      expect(unchanged.isError).toBe(false)
      expect(unchanged.images.length).toBe(0)
      expect(unchanged.screenshots.length).toBe(0)
      expect(unchanged.text).toContain('Screenshot unchanged.')

      const changed = await executor.execute(`
        await state.shotPage.locator('button').evaluate((button) => { button.style.backgroundColor = 'orange' })
        await ${screenshot}
      `)
      paths.push(...changed.screenshots.map((shot) => shot.path))
      expect(changed.isError).toBe(false)
      expect(changed.images.length).toBe(1)
    } finally {
      for (const path of paths) {
        fs.rmSync(path, { force: true })
      }
    }
  })
})
