import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightExecutor } from './executor.js'

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
