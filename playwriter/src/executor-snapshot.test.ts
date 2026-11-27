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
