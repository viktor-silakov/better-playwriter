import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromium, type BrowserContext } from '@xmorse/playwright-core'
import { getAriaSnapshot, resolveSnapshotReference, type SnapshotReference } from './aria-snapshot.js'
import { getCDPSessionForPage } from './cdp-session.js'

let context: BrowserContext
beforeAll(async () => {
  context = await chromium.launchPersistentContext('', { headless: true, executablePath: process.env.PLAYWRITER_TEST_BROWSER })
})
afterAll(async () => {
  await context?.close()
})

describe('compact accessibility snapshots', () => {
  it('takes a shadow DOM subtree and preserves status text', async () => {
    const page = await context.newPage()
    try {
      await page.setContent(`
        <button>Unrelated outside control</button>
        <div id="host"></div>
        <script>
          document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = \`
            <form aria-label="Lookup">
              <p>Ordinary description</p>
              <button>Submit lookup</button>
              <p role="status">Lookup ready</p>
              <div aria-live="polite">Local validation</div>
            </form>
          \`;
        </script>
      `)
      const cdp = await getCDPSessionForPage({ page })
      const commands = vi.spyOn(cdp, 'send')
      const locator = page.getByRole('form', { name: 'Lookup' })
      const interactive = await getAriaSnapshot({ page, locator, cdp, mode: 'interactive' })
      expect(interactive.snapshot).toContain('Lookup ready')
      expect(interactive.snapshot).toContain('Local validation')
      expect(interactive.snapshot).not.toContain('Ordinary description')
      expect(interactive.snapshot).not.toContain('Unrelated outside')
      const compact = await getAriaSnapshot({ page, locator, cdp, mode: 'compact' })
      expect(compact.snapshot).toContain('Ordinary description')
      const shallow = await getAriaSnapshot({ page, locator, cdp, mode: 'compact', maxDepth: 0 })
      expect(shallow.snapshot).toContain('form "Lookup"')
      expect(shallow.snapshot).not.toContain('Submit lookup')
      expect(commands.mock.calls.map(([method]) => method)).toContain('DOM.describeNode')
      expect(commands.mock.calls.map(([method]) => method)).not.toContain('DOM.getFlattenedDocument')
    } finally {
      await page.close()
    }
  })

  it('keeps one line for nested nodes with the same name and aligns siblings', async () => {
    const page = await context.newPage()
    try {
      await page.setContent(`
        <div role="navigation" aria-label="Apps">
          <div aria-label="Calendar" role="group"><button aria-label="Calendar"><img alt="Calendar" src="data:,"></button></div>
          <div><div><button>Mail</button></div></div>
        </div>
        <table>
          <tr><td>Quarterly numbers</td></tr>
          <tr><td><a href="#">Open report</a></td></tr>
        </table>
        <div role="group" aria-label="Ada: Quoting Bo, the build is red. It is fixed now">
          <div aria-label="Quoting Bo, the build is red. It is fixed now" role="group">
            <div aria-label="Quoting Bo, the build is red" role="group"><p>the build is red</p></div>
            <p>It is fixed now</p>
          </div>
          <button aria-label="More message options"></button>
        </div>
      `)
      const { snapshot } = await getAriaSnapshot({ page, mode: 'compact' })
      expect(snapshot).toMatchInlineSnapshot(`
        "- navigation "Apps":
          - role=button[name="Calendar"i]
          - role=button[name="Mail"i]
        - layouttablecell "Quarterly numbers"
        - role=link[name="Open report"i]
        - group "Ada: Quoting Bo, the build is red. It is fixed now":
          - role=button[name="More message options"i]"
      `)
    } finally {
      await page.close()
    }
  })

  it('uses refs for original elements and rejects replacements and frame navigations', async () => {
    const page = await context.newPage()
    try {
      await page.setContent(`
        <main>
          <section id="a"><h2>Alpha item</h2><button onclick="document.title = 'Alpha'">Open</button></section>
          <section id="b"><h2>Beta item</h2><button onclick="document.title = 'Beta'">Open</button></section>
        </main>
        <iframe srcdoc="<button>Child action</button>"></iframe>
      `)
      const byId = new Map<string, SnapshotReference>()
      const names = new Map<string, string>()
      function reference(node: SnapshotReference) {
        const key = `${node.frame.frameId()}:${node.documentId}:${node.backendNodeId}`
        let name = names.get(key)
        if (!name) {
          name = `e${names.size + 1}`
          names.set(key, name)
          byId.set(name, node)
        }
        return name
      }
      const first = await getAriaSnapshot({ page, mode: 'interactive', reference })
      const alphaRow = first.snapshot.split('\n').find((line) => line.includes('Alpha item'))!
      const alpha = alphaRow.match(/@(e\d+)/)?.[1]
      expect(alpha).toBeDefined()
      expect(first.snapshot).toMatch(/button "Open" @e\d+ \(in "Beta item"\)/)
      await page.evaluate(() => document.querySelector('main').appendChild(document.querySelector('#a')))
      const afterReorder = await getAriaSnapshot({ page, mode: 'interactive', reference })
      expect(afterReorder.snapshot).toContain(`@${alpha} (in "Alpha item")`)
      const handle = await resolveSnapshotReference({ page, reference: byId.get(alpha!)! })
      await handle.click()
      await handle.dispose()
      expect(await page.title()).toBe('Alpha')
      await page.evaluate(() => {
        const button = document.querySelector('#a button')
        button.replaceWith(button.cloneNode(true))
      })
      await expect(resolveSnapshotReference({ page, reference: byId.get(alpha!)! })).rejects.toThrow('fresh snapshot')

      const frame = page.frameLocator('iframe')
      const child = await getAriaSnapshot({ page, frame, mode: 'interactive', reference })
      expect(child.snapshot).toContain('Child action')
      const childRef = child.refs.find((entry) => entry.name === 'Child action')!
      const childHandle = await resolveSnapshotReference({ page, reference: byId.get(childRef.shortRef)! })
      expect(await childHandle.textContent()).toBe('Child action')
      await childHandle.dispose()
      await page.locator('iframe').evaluate((iframe) => iframe.setAttribute('srcdoc', '<button>Child action</button>'))
      await page.frames()[1].waitForLoadState()
      await expect(resolveSnapshotReference({ page, reference: byId.get(childRef.shortRef)! })).rejects.toThrow('fresh snapshot')
    } finally {
      await page.close()
    }
  })
})
