import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium } from '@xmorse/playwright-core'
import { cleanupTestContext, getExtensionServiceWorker, setupTestContext, type TestContext } from './test-utils.js'
import { getExtensionsStatus } from './relay-client.js'
import { getCdpUrl } from './utils.js'

const port = 19996
let context: TestContext | null = null

beforeAll(async () => {
  context = await setupTestContext({ port, tempDirPrefix: 'pw-tab-creation-' })
}, 120_000)

afterAll(async () => {
  await cleanupTestContext(context, null)
})

it.each([false, true])('reports debugger cancellation during tab creation (user activated: %s)', async (activate) => {
  const worker = await getExtensionServiceWorker(context!.browserContext)
  await expect.poll(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/extension/status`)
    const status = (await response.json()) as { inventoryReady?: boolean }
    return status.inventoryReady
  }).toBe(true)
  const browser = await chromium.connectOverCDP(getCdpUrl({ port }))
  const before = await worker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => tab.id))

  await worker.evaluate((activate) => {
    const original = chrome.debugger.sendCommand
    Object.defineProperty(chrome.debugger, 'sendCommand', {
      configurable: true,
      value: async (debuggee: chrome.debugger.DebuggerSession, method: string, params?: object) => {
        if (method === 'Page.enable' && debuggee.tabId !== undefined) {
          Object.defineProperty(chrome.debugger, 'sendCommand', { value: original, configurable: true })
          if (activate) await chrome.tabs.update(debuggee.tabId, { active: true })
          const test = globalThis as typeof globalThis & { simulateDebuggerCancellation(tabId: number): void }
          test.simulateDebuggerCancellation(debuggee.tabId)
          throw new Error('Debugger is not attached to the tab.')
        }
        return original(debuggee, method, params)
      },
    })
  }, activate)

  await expect(browser.contexts()[0].newPage()).rejects.toThrow('Chrome canceled debugging')
  const after = await worker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => tab.id))
  expect(after).toEqual(expect.arrayContaining(before))
  const newTabs = after.filter((tabId) => !before.includes(tabId))
  expect(newTabs).toHaveLength(activate ? 1 : 0)
  expect((await getExtensionsStatus(port))[0]?.activeTargets).toBe(0)
  await worker.evaluate(async (ids) => {
    for (const tabId of ids) {
      if (tabId !== undefined) await chrome.tabs.remove(tabId)
    }
  }, newTabs)

  const page = await browser.contexts()[0].newPage()
  try {
    expect(await page.evaluate(() => 2 + 3)).toBe(5)
  } finally {
    await page.close()
  }
})
