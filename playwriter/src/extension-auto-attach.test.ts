import { afterAll, beforeAll, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AUTO_ATTACH_STORAGE_KEY } from './auto-attach-rules.js'
import { getExtensionsStatus } from './relay-client.js'
import { cleanupTestContext, getExtensionServiceWorker, setupTestContext, type TestContext } from './test-utils.js'

const port = 20108
const site = createServer((_, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' })
  response.end('<!doctype html><title>Example</title>')
})
let context: TestContext | null = null
let origin: string

beforeAll(async () => {
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`
  context = await setupTestContext({ port, tempDirPrefix: 'pw-auto-attach-', rememberConnections: true })
}, 120_000)

afterAll(async () => {
  await cleanupTestContext(context, null)
  site.close()
})

it('remembers manual connections and uses editable URL masks for future tabs', async () => {
  const worker = await getExtensionServiceWorker(context!.browserContext)
  const activeTargets = async () => (await getExtensionsStatus(port))[0]?.activeTargets

  const manualTab = await context!.browserContext.newPage()
  await manualTab.goto(`${origin}/manual?private=example`)
  await manualTab.bringToFront()
  const toggle = () =>
    worker.evaluate(async () => {
      const browser = globalThis as typeof globalThis & {
        toggleExtensionForActiveTab(): Promise<{ isConnected: boolean }>
      }
      return (await browser.toggleExtensionForActiveTab()).isConnected
    })
  await expect(toggle()).resolves.toBe(true)
  await expect
    .poll(() => worker.evaluate(async (key) => (await chrome.storage.local.get(key))[key], AUTO_ATTACH_STORAGE_KEY))
    .toEqual({ masks: [`${origin}*`], remember: true })

  const automaticTab = await context!.browserContext.newPage()
  await automaticTab.goto(`${origin}/automatic`)
  await expect.poll(activeTargets).toBe(2)
  await automaticTab.goto('about:blank')
  await expect.poll(activeTargets).toBe(1)
  await automaticTab.goto(`${origin}/automatic`)
  await expect.poll(activeTargets).toBe(2)
  await automaticTab.bringToFront()
  await expect(toggle()).resolves.toBe(false)
  await automaticTab.goto(`${origin}/automatic-next`)

  const options = await context!.browserContext.newPage()
  await options.goto(new URL('src/profile-options.html', worker.url()).href)
  await expect.poll(() => options.locator('#masks').inputValue()).toBe(`${origin}*`)
  await options.locator('#masks').fill(`${origin}/chosen/*`)
  await options.locator('#remember').uncheck()
  await options.locator('#save-masks').click()
  await expect.poll(() => options.locator('#masks-status').textContent()).toContain('Saved')

  const newTab = await context!.browserContext.newPage()
  await newTab.goto(`${origin}/chosen/page`)
  // The original manual tab stays available. The manually disconnected tab
  // stays paused even after the new mask is installed.
  await automaticTab.goto(`${origin}/chosen/paused`)
  await expect.poll(activeTargets).toBe(2)
})
