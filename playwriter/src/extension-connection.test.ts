import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMCPClient } from './mcp-client.js'
import { describe, it, expect, beforeAll, afterAll, onTestFinished } from 'vitest'
import { chromium, type Browser, type Page } from '@xmorse/playwright-core'
import { getCdpUrl } from './utils.js'
import { setupTestContext, cleanupTestContext, getExtensionServiceWorker, type TestContext, js } from './test-utils.js'
import { getExtensionsStatus } from './relay-client.js'
import { startPlayWriterCDPRelayServer } from './cdp-relay.js'
import { createFileLogger } from './create-logger.js'
import './test-declarations.js'

const TEST_PORT = 19990
const remoteServiceUrl = process.env.BETTER_PLAYWRITER_REMOTE_URL || process.env.PLAYWRITER_REMOTE_URL

describe('Extension Connection Tests', () => {
  let client: Awaited<ReturnType<typeof createMCPClient>>['client']
  let cleanup: (() => Promise<void>) | null = null
  let testCtx: TestContext | null = null

  beforeAll(async () => {
    testCtx = await setupTestContext({ port: TEST_PORT, tempDirPrefix: 'pw-conn-test-', toggleExtension: true })

    const result = await createMCPClient({ port: TEST_PORT })
    client = result.client
    cleanup = result.cleanup
  }, 600000)

  afterAll(async () => {
    await cleanupTestContext(testCtx, cleanup)
    cleanup = null
    testCtx = null
  })

  const getBrowserContext = () => {
    if (!testCtx?.browserContext) throw new Error('Browser not initialized')
    return testCtx.browserContext
  }

  it('completes the additive extension inventory handshake', async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/extension/status`)
    const status = await response.json()

    expect(status).toMatchObject({
      connected: true,
      browser: expect.any(String),
      inventoryReady: true,
    })
  })

  it('releases session tabs without closing them or touching other tabs', async () => {
    const browserContext = getBrowserContext()
    const worker = await getExtensionServiceWorker(browserContext)
    const otherTabIds = await worker.evaluate(() => [...globalThis.getExtensionState().tabs.keys()])
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/cli/session/new`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: os.tmpdir(), tabGroup: 'cleanup-test' }),
    })
    const session = await response.json() as { id: string; extensionId: string }
    const listed = await (await fetch(`http://127.0.0.1:${TEST_PORT}/cli/sessions`)).json() as { sessions: Array<{ id: string; idleMs: number }> }
    expect(listed.sessions.find((entry) => entry.id === session.id)?.idleMs).toEqual(expect.any(Number))
    const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT, extensionId: session.extensionId, sessionId: session.id, tabGroup: 'cleanup-test' }))
    try {
      const page = await browser.contexts()[0].newPage()
      await page.evaluate(() => { document.title = 'cleanup-marker' })
      const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ title: 'cleanup-marker' }))[0]?.id)
      expect(tabId).toBeDefined()
      await expect.poll(async () => worker.evaluate(async (id) => (await chrome.tabs.get(id!)).groupId, tabId)).not.toBe(-1)
      const deletion = await fetch(`http://127.0.0.1:${TEST_PORT}/cli/session/delete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, releaseCreatedTabs: true }),
      })
      expect(await deletion.json()).toMatchObject({ success: true })
      await expect.poll(async () => worker.evaluate(async (id) => {
        const tab = await chrome.tabs.get(id!).catch(() => null)
        return tab ? { groupId: tab.groupId, attached: globalThis.getExtensionState().tabs.has(id!) } : null
      }, tabId)).toEqual({ groupId: -1, attached: false })
      expect(await worker.evaluate((ids) => ids.every((id) => globalThis.getExtensionState().tabs.has(id)), otherTabIds)).toBe(true)
      await worker.evaluate((id) => chrome.tabs.remove(id!), tabId)
    } finally {
      await browser.close().catch(() => {})
    }
  }, 60_000)

  it('should handle new pages and toggling with new connections', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    // 1. Create a new page
    const page = await browserContext.newPage()
    const testUrl = 'https://example.com/'
    await page.goto(testUrl)

    await page.bringToFront()

    // 2. Enable extension on this new tab
    const result = await serviceWorker.evaluate(async () => {
      return await globalThis.toggleExtensionForActiveTab()
    })
    expect(result.isConnected).toBe(true)

    // 3. Verify we can connect via direct CDP and see the page
    let directBrowser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT }))
    let contexts = directBrowser.contexts()
    let pages = contexts[0].pages()

    let foundPage = pages.find((p) => p.url() === testUrl)
    expect(foundPage).toBeDefined()
    expect(foundPage?.url()).toBe(testUrl)

    const sum1 = await foundPage?.evaluate(() => 1 + 1)
    expect(sum1).toBe(2)

    await directBrowser.close()

    // 4. Disable extension on this tab
    const resultDisabled = await serviceWorker.evaluate(async () => {
      return await globalThis.toggleExtensionForActiveTab()
    })
    expect(resultDisabled.isConnected).toBe(false)

    // 5. Connect again - page should NOT be visible
    directBrowser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT }))
    contexts = directBrowser.contexts()
    pages = contexts[0].pages()

    foundPage = pages.find((p) => p.url() === testUrl)
    expect(foundPage).toBeUndefined()

    await directBrowser.close()

    // 6. Re-enable extension
    const resultEnabled = await serviceWorker.evaluate(async () => {
      return await globalThis.toggleExtensionForActiveTab()
    })
    expect(resultEnabled.isConnected).toBe(true)

    // 7. Verify page is back
    directBrowser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT }))
    await new Promise((r) => setTimeout(r, 100))

    contexts = directBrowser.contexts()
    if (contexts[0].pages().length === 0) {
      await new Promise((r) => setTimeout(r, 100))
    }
    pages = contexts[0].pages()

    foundPage = pages.find((p) => p.url() === testUrl)
    expect(foundPage).toBeDefined()
    expect(foundPage?.url()).toBe(testUrl)

    const sum2 = await foundPage?.evaluate(() => 2 + 2)
    expect(sum2).toBe(4)

    await directBrowser.close()
    await page.close()
  }, 120000)

  it('does not let page scripts trigger isolated toolbar actions', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    const page = await browserContext.newPage()
    await page.goto('https://example.com/')
    await page.bringToFront()
    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })
    await page.locator('[data-playwriter-toolbar="1"]').first().waitFor()
    await new Promise((resolve) => setTimeout(resolve, 100))

    const pageCallbacks = await page.evaluate(() => {
      return {
        recorder: typeof window.__playwriterToolbarStartRecording,
        startRemote: typeof window.__playwriterToolbarStartRemote,
        stopRemote: typeof window.__playwriterToolbarStopRemote,
        toggleRemote: typeof Reflect.get(window, '__playwriterToolbarToggleRemote'),
      }
    })
    const isolatedCallbacks = await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) {
        throw new Error('No active tab')
      }
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        world: 'ISOLATED',
        func: () => {
          return {
            startRemote: typeof window.__playwriterToolbarStartRemote,
            stopRemote: typeof window.__playwriterToolbarStopRemote,
            toggleRemote: typeof Reflect.get(window, '__playwriterToolbarToggleRemote'),
          }
        },
      })
      return result.result
    })
    await page.evaluate(() => {
      window.postMessage({ __playwriter: 'remote_toggle' }, '*')
      window.postMessage({ __playwriter: 'recorder_start' }, '*')
    })
    await new Promise((resolve) => setTimeout(resolve, 250))

    const remoteState = await serviceWorker.evaluate(() => {
      return globalThis.getRemoteControlState()
    })
    if (remoteState) {
      await serviceWorker.evaluate(() => {
        globalThis.stopRemoteControl()
      })
    }

    // chrome.runtime.sendMessage broadcasts to every extension context, so the
    // offscreen document must ignore actions it does not own. Keep the pin check
    // below while this document is alive: an unfiltered offscreen listener answers
    // 'pinToolbarElement' before the service worker and silently breaks pinning.
    const clipboard = await serviceWorker.evaluate(async () => {
      const offscreenUrl = chrome.runtime.getURL('src/offscreen.html')
      const existing = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
        documentUrls: [offscreenUrl],
      })
      const created = existing.length === 0
      if (created) {
        await chrome.offscreen.createDocument({
          url: 'src/offscreen.html',
          reasons: [chrome.offscreen.Reason.CLIPBOARD],
          justification: 'Test isolated clipboard and message routing',
        })
      }
      const result = await chrome.runtime.sendMessage({ action: 'copyText', text: 'isolated toolbar test' })
      return { result, created }
    })

    const pinResult = await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) {
        throw new Error('No active tab')
      }
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        world: 'ISOLATED',
        func: async () => {
          const target = document.querySelector('p')
          if (!target) {
            return null
          }
          const markerBytes = new Uint8Array(16)
          crypto.getRandomValues(markerBytes)
          const marker = Array.from(markerBytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
          target.setAttribute('data-playwriter-pin-target', marker)
          try {
            return await chrome.runtime.sendMessage({ action: 'pinToolbarElement', marker })
          } finally {
            target.removeAttribute('data-playwriter-pin-target')
          }
        },
      })
      return result.result
    })
    if (clipboard.created) {
      await serviceWorker.evaluate(async () => {
        await chrome.offscreen.closeDocument()
      })
    }
    const pinnedText = await page.evaluate(() => {
      return window.playwriterPinnedElem1?.textContent
    })
    await page.close()

    expect(pageCallbacks).toEqual({
      recorder: 'undefined',
      startRemote: 'undefined',
      stopRemote: 'undefined',
      toggleRemote: 'undefined',
    })
    expect(isolatedCallbacks).toEqual({
      startRemote: 'function',
      stopRemote: 'function',
      toggleRemote: 'undefined',
    })
    expect(remoteState).toBeNull()
    expect(clipboard.result).toEqual({ success: true })
    expect(pinResult).toEqual({ pinNumber: 1 })
    expect(pinnedText).toContain('documentation examples')
  }, 120000)

  // Right-click "Copy Playwriter Locator" must work before the tab is attached:
  // the isolated content script remembers the target, the service worker pins it
  // in the MAIN world, then attaches the tab so the agent can inspect the pin.
  it('copies a locator from the context menu on a tab that is not attached', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    const page = await browserContext.newPage()
    await page.goto('https://example.com/?context-menu-pin')
    await page.evaluate(() => {
      const host = document.createElement('div')
      host.style.cssText = 'position:fixed;top:10px;left:10px;z-index:2147483647'
      const button = document.createElement('button')
      button.textContent = 'Pin target'
      host.attachShadow({ mode: 'open' }).appendChild(button)
      document.body.prepend(host)
    })
    await page.bringToFront()
    try {
      await page.getByRole('button', { name: 'Pin target' }).click({ button: 'right' })
      await serviceWorker.evaluate(async () => {
        await globalThis.runMenuItemForActiveTab('playwriter-pin-element')
      })
      await expect
        .poll(async () => {
          return serviceWorker.evaluate(async () => {
            const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
            return globalThis.getExtensionState().tabs.get(tab.id!)?.state
          })
        })
        .toBe('connected')
      const pinned = await page.evaluate(() => {
        return {
          text: window.playwriterPinnedElem1?.textContent,
          markers: document.querySelectorAll('[data-playwriter-pin-target]').length,
          // isolated-world globals never leak into the page
          leakedTarget: typeof window.__playwriterContextTarget,
        }
      })
      expect(pinned).toMatchInlineSnapshot(`
        {
          "leakedTarget": "undefined",
          "markers": 0,
          "text": "Pin target",
        }
      `)
    } finally {
      await serviceWorker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
        if (globalThis.getExtensionState().tabs.has(tab.id!)) {
          await globalThis.toggleExtensionForActiveTab()
        }
      })
      await page.close()
    }
  }, 60_000)

  // Start is idempotent, the icon menu Stop sharing closes the tunnel.
  it.skipIf(!remoteServiceUrl)('starts Remote control twice with one tunnel and stops it from the icon menu', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    const page = await browserContext.newPage()
    await page.goto('https://example.com/?share')
    await page.bringToFront()
    const tabId = await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      return tab.id!
    })

    try {
      await serviceWorker.evaluate(() => globalThis.startRemoteControlForActiveTab())
      const firstShare = await serviceWorker.evaluate(() => globalThis.getRemoteControlState())
      await serviceWorker.evaluate(() => globalThis.startRemoteControlForActiveTab())
      const secondShare = await serviceWorker.evaluate(() => globalThis.getRemoteControlState())
      expect({
        anchorIsTab: firstShare?.anchorTabId === tabId,
        sameUrl: firstShare?.url === secondShare?.url,
      }).toEqual({ anchorIsTab: true, sameUrl: true })

      await page.bringToFront()
      await serviceWorker.evaluate(async () => {
        await globalThis.runMenuItemForActiveTab('playwriter-stop-sharing')
      })
      expect(await serviceWorker.evaluate(() => globalThis.getRemoteControlState())).toBeNull()
    } finally {
      await serviceWorker.evaluate(() => {
        globalThis.stopRemoteControl()
      })
      await page.close()
    }
  }, 60_000)

  // Full Remote control flow through the configured tunnel: the remote
  // relay sees every attached tab, opens new tabs, and loses access on Stop sharing.
  it.skipIf(!remoteServiceUrl)('lets a Remote control relay use every tab and open new ones', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    const toggleActiveTab = async (page: Page) => {
      await page.bringToFront()
      await serviceWorker.evaluate(async () => {
        await globalThis.toggleExtensionForActiveTab()
      })
    }
    const anchor = await browserContext.newPage()
    await anchor.goto('https://example.com/?anchor')
    await toggleActiveTab(anchor)
    const other = await browserContext.newPage()
    await other.goto('https://example.com/?other')
    await toggleActiveTab(other)
    await anchor.bringToFront()

    const { url } = await serviceWorker.evaluate(() => {
      return globalThis.startRemoteControlForActiveTab()
    })
    const tunnelId = new URL(url).hash.slice(1)
    let remoteBrowser: Browser | null = null
    let sessionId: string | undefined
    try {
      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/cli/session/new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remoteControlUrl: tunnelId, cwd: os.tmpdir() }),
      })
      const session = (await response.json()) as { id?: string; mode?: string; extensionId?: string; error?: string }
      expect(session.error, JSON.stringify(session)).toBeUndefined()
      expect(session.mode).toBe('remote')
      sessionId = session.id

      remoteBrowser = await chromium.connectOverCDP(
        getCdpUrl({ port: TEST_PORT, extensionId: session.extensionId, sessionId: session.id, tabGroup: 'remote' }),
      )
      const remoteContext = remoteBrowser.contexts()[0]
      const remoteUrls = remoteContext.pages().map((page) => {
        return page.url()
      })
      // The anchor tab is announced first, so it is context.pages()[0]
      expect(remoteUrls[0]).toBe('https://example.com/?anchor')
      expect(remoteUrls).toContain('https://example.com/?other')

      const remoteOther = remoteContext.pages().find((page) => {
        return page.url() === 'https://example.com/?other'
      })
      expect(await remoteOther?.evaluate(() => window.location.search)).toBe('?other')

      const created = await remoteContext.newPage()
      await created.goto('https://example.com/?created')
      expect(await created.title()).toBe('Example Domain')

      const cdp = await remoteContext.getExistingCDPSession(created)
      await expect(cdp.send('Network.clearBrowserCookies')).rejects.toThrow(/not allowed over Remote control/)

      const shared = await serviceWorker.evaluate(() => {
        return globalThis.getRemoteControlState()
      })
      expect(shared?.remoteTabIds).toHaveLength(1)
      const createdTabId = shared!.remoteTabIds[0]
      // New tabs join the remote session group; its key never collides with local session ids
      const createdGroup = await serviceWorker.evaluate(async (tabId) => {
        const info = globalThis.getExtensionState().tabs.get(tabId)
        const tab = await chrome.tabs.get(tabId)
        return { groupTitle: info?.groupTitle, groupKey: info?.groupKey, active: tab.active }
      }, createdTabId)
      expect(createdGroup).toEqual({
        groupTitle: 'remote',
        // relay ownership key is `<relay instance uuid>:<session id>`
        groupKey: expect.stringMatching(new RegExp(`^remote:[0-9a-f-]{36}:${sessionId}$`)),
        active: false,
      })

      await serviceWorker.evaluate(() => {
        globalThis.stopRemoteControl()
      })
      await remoteBrowser.close().catch(() => {})
      remoteBrowser = null

      // Stop sharing detaches tabs the remote opened but leaves them open
      const afterStop = await serviceWorker.evaluate(async (tabId) => {
        const state = globalThis.getExtensionState()
        const tab = await chrome.tabs.get(tabId).catch(() => {
          return null
        })
        return { attached: state.tabs.has(tabId), open: tab !== null }
      }, createdTabId)
      expect(afterStop).toEqual({ attached: false, open: true })
    } finally {
      await remoteBrowser?.close().catch(() => {})
      await serviceWorker.evaluate(() => {
        globalThis.stopRemoteControl()
      })
      if (sessionId) {
        await fetch(`http://127.0.0.1:${TEST_PORT}/cli/session/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
      }
      const createdPages = browserContext.pages().filter((page) => {
        return page.url() === 'https://example.com/?created'
      })
      await Promise.all(
        [anchor, other, ...createdPages].map((page) => {
          return page.close()
        }),
      )
    }
  }, 120_000)

  // Clicks the real button instead of calling the handler, so the trusted-click guard
  // stays covered. Page CSS like `div{opacity:0.8}` once matched the toolbar host and
  // disabled Record Skill and Remote control on every page.
  it('starts and stops Record Skill from a real toolbar click', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    const page = await browserContext.newPage()
    // A tab left open here is picked up by later tests that look for example.com.
    onTestFinished(async () => {
      await page.close().catch(() => {})
    })
    await page.goto('https://example.com/')
    await page.bringToFront()
    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })
    const toolbar = page.locator('[data-playwriter-toolbar="1"]').first()
    await toolbar.waitFor()
    const tabBox = await toolbar.boundingBox()
    if (!tabBox) {
      throw new Error('Toolbar tab is not visible')
    }
    const recordingCount = async () => {
      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/recorder/status`)
      const status = (await response.json()) as { recordings: Array<{ recordingId: string }> }
      return status.recordings.length
    }
    const toolbarWidth = async () => {
      return (await toolbar.boundingBox())?.width || 0
    }
    // Record Skill sits right after the labeled Copy Locator button.
    const clickRecord = async () => {
      const box = await toolbar.boundingBox()
      if (!box) {
        throw new Error('Expanded toolbar is not visible')
      }
      await page.mouse.click(box.x + 155, box.y + box.height / 2)
    }

    // The toolbar follows the recorder through the extension, which takes over a second on a busy machine.
    const SLOW_POLL = { timeout: 10000 }
    // The toolbar starts as a small tab at the top edge. Click it to expand.
    await page.mouse.click(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2)
    await expect.poll(toolbarWidth, SLOW_POLL).toBeGreaterThan(tabBox.width)
    const idleWidth = await toolbarWidth()

    await clickRecord()
    await expect.poll(recordingCount, SLOW_POLL).toBe(1)
    await clickRecord()
    await expect.poll(recordingCount, SLOW_POLL).toBe(0)

    // Toolbar start, CLI stop: the toolbar goes back to idle.
    const relayPost = async (route: string) => {
      const response = await fetch(`http://127.0.0.1:${TEST_PORT}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      expect({ route, status: response.status, body: await response.text() }).toMatchObject({ status: 200 })
    }
    await expect.poll(toolbarWidth, SLOW_POLL).toBe(idleWidth)
    await clickRecord()
    await expect.poll(recordingCount, SLOW_POLL).toBe(1)
    // This stop sometimes lands while the recording is still starting. The start then fails, and the
    // toolbar must leave "Starting…" all the same.
    await relayPost('/recorder/stop')
    await expect.poll(toolbarWidth, SLOW_POLL).toBe(idleWidth)
    // A recording started from the CLI covers the whole context. The toolbar shows only the
    // recording of its own tab, so it stays idle.
    await relayPost('/recorder/start')
    await expect.poll(recordingCount, SLOW_POLL).toBe(1)
    expect(await toolbarWidth()).toBe(idleWidth)
    await relayPost('/recorder/stop')
    await expect.poll(recordingCount, SLOW_POLL).toBe(0)
  }, 120000)

  // Agent clicks used to fail with "<div data-playwriter-toolbar> intercepts pointer
  // events". The Playwright fork marks the toolbar host before each hit-target check
  // (data-playwriter-agent), the toolbar CSS goes pass-through, then restores after 1s.
  it('lets agent clicks and keys pass through the toolbar', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    const page = await browserContext.newPage()
    const testUrl = 'https://example.com/?toolbar-pass-through'
    await page.goto(testUrl)
    await page.bringToFront()
    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })
    const toolbar = page.locator('[data-playwriter-toolbar="1"]').first()
    await toolbar.waitFor()
    const box = await toolbar.boundingBox()
    if (!box) {
      throw new Error('Toolbar is not visible')
    }
    await page.evaluate((rect) => {
      const button = document.createElement('button')
      button.id = 'under-toolbar'
      button.textContent = 'under'
      button.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;z-index:1;`
      button.addEventListener('click', () => {
        Reflect.set(window, '__underClicks', Number(Reflect.get(window, '__underClicks') || 0) + 1)
      })
      document.body.appendChild(button)
    }, box)

    const directBrowser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT }))
    try {
      const agentPage = directBrowser
        .contexts()[0]
        .pages()
        .find((p) => {
          return p.url() === testUrl
        })
      if (!agentPage) {
        throw new Error('Agent page not found')
      }

      // Clicks land on the button under the collapsed tab, so the tab must not expand.
      await agentPage.locator('#under-toolbar').click({ timeout: 5000 })
      await agentPage.locator('#under-toolbar').click({ position: { x: 4, y: box.height / 2 }, timeout: 5000 })
      const focusedToolbar: boolean[] = []
      for (let i = 0; i < 4; i++) {
        await agentPage.keyboard.press('Tab')
        focusedToolbar.push(
          await agentPage.evaluate(() => {
            return Boolean(document.activeElement?.hasAttribute('data-playwriter-toolbar'))
          }),
        )
      }

      const recorderResponse = await fetch(`http://127.0.0.1:${TEST_PORT}/recorder/status`)
      const recorderStatus = (await recorderResponse.json()) as { recordings: unknown[] }
      expect({
        underClicks: await page.evaluate(() => {
          return Reflect.get(window, '__underClicks')
        }),
        recordings: recorderStatus.recordings.length,
        focusedToolbar: focusedToolbar.includes(true),
        stillCollapsed: (await toolbar.boundingBox())?.width === box.width,
      }).toMatchInlineSnapshot(`
        {
          "focusedToolbar": false,
          "recordings": 0,
          "stillCollapsed": true,
          "underClicks": 2,
        }
      `)

      // Once the agent goes idle the toolbar takes pointer input again for the user.
      await expect
        .poll(
          async () => {
            return await page.evaluate((point) => {
              return Boolean(document.elementFromPoint(point.x, point.y)?.hasAttribute('data-playwriter-toolbar'))
            }, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
          },
          { timeout: 5000 },
        )
        .toBe(true)
    } finally {
      await directBrowser.close()
      await page.close()
    }
  }, 120000)

  it('should handle new pages and toggling with persistent connection', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const directBrowser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT }))
    await new Promise((r) => setTimeout(r, 100))

    // 1. Create a new page
    const page = await browserContext.newPage()
    const testUrl = 'https://example.com/persistent'
    await page.goto(testUrl)
    await page.bringToFront()

    // 2. Enable extension
    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })

    // 3. Verify page appears (polling)
    let foundPage
    for (let i = 0; i < 50; i++) {
      const pages = directBrowser.contexts()[0].pages()
      foundPage = pages.find((p) => p.url() === testUrl)
      if (foundPage) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(foundPage).toBeDefined()
    expect(foundPage?.url()).toBe(testUrl)

    const sum1 = await foundPage?.evaluate(() => 10 + 20)
    expect(sum1).toBe(30)

    // 4. Disable extension
    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })

    // 5. Verify page disappears (polling)
    for (let i = 0; i < 50; i++) {
      const pages = directBrowser.contexts()[0].pages()
      foundPage = pages.find((p) => p.url() === testUrl)
      if (!foundPage) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(foundPage).toBeUndefined()

    // 6. Re-enable extension
    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })

    // 7. Verify page reappears (polling)
    for (let i = 0; i < 50; i++) {
      const pages = directBrowser.contexts()[0].pages()
      foundPage = pages.find((p) => p.url() === testUrl)
      if (foundPage) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(foundPage).toBeDefined()
    expect(foundPage?.url()).toBe(testUrl)

    const sum2 = await foundPage?.evaluate(() => 30 + 40)
    expect(sum2).toBe(70)

    await page.close()
    await directBrowser.close()
  })

  it('should maintain connection across reloads and navigation', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    // 1. Setup page
    const page = await browserContext.newPage()
    const initialUrl = 'https://example.com/'
    await page.goto(initialUrl)
    await page.bringToFront()

    // 2. Enable extension
    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })

    // 3. Connect via CDP
    const cdpUrl = getCdpUrl({ port: TEST_PORT })
    const directBrowser = await chromium.connectOverCDP(cdpUrl)
    const connectedPage = directBrowser
      .contexts()[0]
      .pages()
      .find((p) => p.url() === initialUrl)
    expect(connectedPage).toBeDefined()

    expect(await connectedPage?.evaluate(() => 1 + 1)).toBe(2)

    // 4. Reload
    await connectedPage?.reload()
    await connectedPage?.waitForLoadState('domcontentloaded')
    expect(await connectedPage?.title()).toBe('Example Domain')

    expect(await connectedPage?.evaluate(() => 2 + 2)).toBe(4)

    // 5. Navigate to new URL
    const newUrl = 'https://example.org/'
    await connectedPage?.goto(newUrl)
    await connectedPage?.waitForLoadState('domcontentloaded')

    expect(connectedPage?.url()).toBe(newUrl)
    expect(await connectedPage?.title()).toContain('Example Domain')

    expect(await connectedPage?.evaluate(() => 3 + 3)).toBe(6)

    await directBrowser.close()
    await page.close()
  })

  it('should support multiple concurrent tabs', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Tab A
    const pageA = await browserContext.newPage()
    await pageA.goto('https://example.com/tab-a')
    await pageA.bringToFront()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })

    // Tab B
    const pageB = await browserContext.newPage()
    await pageB.goto('https://example.com/tab-b')
    await pageB.bringToFront()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })

    // Get target IDs for both
    const targetIds = await serviceWorker.evaluate(async () => {
      const state = globalThis.getExtensionState()
      const chrome = globalThis.chrome
      const tabs = await chrome.tabs.query({})
      const tabA = tabs.find((t: any) => t.url?.includes('tab-a'))
      const tabB = tabs.find((t: any) => t.url?.includes('tab-b'))
      return {
        idA: state.tabs.get(tabA?.id ?? -1)?.targetId,
        idB: state.tabs.get(tabB?.id ?? -1)?.targetId,
      }
    })

    expect(targetIds).toMatchInlineSnapshot(
      {
        idA: expect.any(String),
        idB: expect.any(String),
      },
      `
          {
            "idA": Any<String>,
            "idB": Any<String>,
          }
        `,
    )
    expect(targetIds.idA).not.toBe(targetIds.idB)

    // Verify independent connections
    const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT }))

    const pages = browser.contexts()[0].pages()

    const results = await Promise.all(
      pages.map(async (p) => ({
        url: p.url(),
        title: await p.title(),
      })),
    )

    expect(results).toMatchInlineSnapshot(`
      [
        {
          "title": "",
          "url": "about:blank",
        },
        {
          "title": "Example Domain",
          "url": "https://example.com/tab-a",
        },
        {
          "title": "Example Domain",
          "url": "https://example.com/tab-b",
        },
      ]
    `)

    // Verify execution on both pages
    const pageA_CDP = pages.find((p) => p.url().includes('tab-a'))
    const pageB_CDP = pages.find((p) => p.url().includes('tab-b'))

    expect(await pageA_CDP?.evaluate(() => 10 + 10)).toBe(20)
    expect(await pageB_CDP?.evaluate(() => 20 + 20)).toBe(40)

    await browser.close()
    await pageA.close()
    await pageB.close()
  })

  it('should warn only when a page stored in state closes', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const pageA = await browserContext.newPage()
    await pageA.goto('https://example.com/close-warning-a')
    await pageA.bringToFront()
    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })

    const pageB = await browserContext.newPage()
    await pageB.goto('https://example.com/close-warning-b')
    await pageB.bringToFront()
    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })

    const storedCloseResult = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          state.page = context.pages().findLast((p) => p.url().includes('close-warning-a'));
          await state.page.close();
        `,
      },
    })
    expect((storedCloseResult as any).isError).not.toBe(true)
    expect((storedCloseResult as any).content[0].text).toMatchInlineSnapshot(`"[WARNING] Page closed (url: https://example.com/close-warning-a) for state.page. Assign a new open page to state.page before reusing it, e.g. state.page = await context.newPage()."`)
    const stale = await client.callTool({
      name: 'execute',
      arguments: { code: js`await state.page.evaluate(() => 1)` },
    })
    expect(JSON.stringify(stale)).toContain('Do not reset the whole session')

    const unstoredCloseResult = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          await context.pages().findLast((p) => p.url().includes('close-warning-b')).close();
        `,
      },
    })
    expect((unstoredCloseResult as any).isError).not.toBe(true)
    expect((unstoredCloseResult as any).content[0].text).toMatchInlineSnapshot(`"Code executed successfully (no output)"`)

    if (!pageA.isClosed()) {
      await pageA.close()
    }
    if (!pageB.isClosed()) {
      await pageB.close()
    }
  })

  it('explains how to recover a crashed state page without resetting or replaying actions', async () => {
    const crashed = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          state.crashed = await context.newPage();
          const cdp = await getCDPSession({ page: state.crashed });
          const crash = state.crashed.waitForEvent('crash');
          void cdp.send('Page.crash').catch(() => {});
          await crash;
        `,
      },
    })
    expect(JSON.stringify(crashed)).toContain('Do not reset the session')
    const failed = await client.callTool({
      name: 'execute',
      arguments: { code: js`await state.crashed.evaluate(() => 1)` },
    })
    expect(JSON.stringify(failed)).toContain('Create a new tab')
    expect(JSON.stringify(failed)).not.toContain('call reset to reconnect')
    const recovered = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          await state.crashed.close();
          delete state.crashed;
          const page = await context.newPage();
          const result = await page.evaluate(() => 42);
          await page.close();
          return result;
        `,
      },
    })
    expect(JSON.stringify(recovered)).toContain('[return value] 42')
    const badNavigation = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          state.errorPage = await context.newPage();
          await state.errorPage.goto('http://127.0.0.1:1/');
        `,
      },
    })
    expect(JSON.stringify(badNavigation)).toContain('Check page.url() and the network error')
    await client.callTool({
      name: 'execute',
      arguments: { code: js`await state.errorPage.close(); delete state.errorPage` },
    })
  })

  it('should show correct url when enabling extension after navigation', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    const targetUrl = 'https://example.com/late-enable'
    await page.goto(targetUrl)
    await page.bringToFront()

    await page.waitForLoadState('domcontentloaded')

    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })

    const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT }))
    await new Promise((r) => setTimeout(r, 100))

    const cdpPage = browser
      .contexts()[0]
      .pages()
      .find((p) => p.url() === targetUrl)

    expect(cdpPage).toBeDefined()
    expect(cdpPage?.url()).toBe(targetUrl)

    await browser.close()
    await page.close()
  }, 60000)

  it('should be able to reconnect after disconnecting everything', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const pages = await browserContext.pages()
    expect(pages.length).toBeGreaterThan(0)
    const page = pages[0]

    await page.goto('https://example.com/disconnect-test')
    await page.waitForLoadState('domcontentloaded')
    await page.bringToFront()

    // Enable extension on this page
    const initialEnable = await serviceWorker.evaluate(async () => {
      return await globalThis.toggleExtensionForActiveTab()
    })
    console.log('Initial enable result:', initialEnable)
    expect(initialEnable.isConnected).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 100))

    // Verify MCP can see the page
    const beforeDisconnect = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          const pages = context.pages();
          console.log('Pages before disconnect:', pages.length);
          const testPage = pages.find(p => p.url().includes('disconnect-test'));
          console.log('Found test page:', !!testPage);
          return { pagesCount: pages.length, foundTestPage: !!testPage };
        `,
      },
    })

    const beforeOutput = (beforeDisconnect as any).content[0].text
    expect(beforeOutput).toContain('foundTestPage')
    console.log('Before disconnect:', beforeOutput)

    // 2. Disconnect everything
    console.log('Calling disconnectEverything...')
    await serviceWorker.evaluate(async () => {
      await globalThis.disconnectEverything()
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    // 3. Detached tabs leave Playwright. Execute still works with zero tabs;
    // the disconnected page must not be listed.
    const afterDisconnect = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          const pages = context.pages();
          const testPage = pages.find(p => p.url().includes('disconnect-test'));
          console.log('Pages after disconnect:', pages.length);
          console.log('Found test page:', !!testPage);
          return { pagesCount: pages.length, foundTestPage: !!testPage };
        `,
      },
    })

    const afterDisconnectOutput = (afterDisconnect as any).content[0].text
    console.log('After disconnect:', afterDisconnectOutput)
    expect((afterDisconnect as any).isError).toBeFalsy()
    expect(afterDisconnectOutput).toContain('foundTestPage: false')

    // 4. Re-enable extension on the same page
    console.log('Re-enabling extension...')
    await page.bringToFront()
    const reconnectResult = await serviceWorker.evaluate(async () => {
      console.log('About to call toggleExtensionForActiveTab')
      const result = await globalThis.toggleExtensionForActiveTab()
      console.log('toggleExtensionForActiveTab result:', result)
      return result
    })

    console.log('Reconnect result:', reconnectResult)
    expect(reconnectResult.isConnected).toBe(true)

    console.log('Waiting for reconnection to stabilize...')
    await new Promise((resolve) => setTimeout(resolve, 100))

    // 5. Reset the MCP client's playwright connection
    console.log('Resetting MCP playwright connection...')
    const resetResult = await client.callTool({
      name: 'reset',
      arguments: {},
    })
    console.log('Reset result:', (resetResult as any).content[0].text)
    expect((resetResult as any).content[0].text).toContain('Connection reset successfully')

    // 6. Verify MCP can see the page again
    console.log('Attempting to access page via MCP...')
    const afterReconnect = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          console.log('Checking pages after reconnect...');
          const pages = context.pages();
          console.log('Pages after reconnect:', pages.length);

          if (pages.length === 0) {
            console.log('No pages found!');
            return { pagesCount: 0, foundTestPage: false };
          }

          const testPage = pages.find(p => p.url().includes('disconnect-test'));
          console.log('Found test page after reconnect:', !!testPage);

          if (testPage) {
            console.log('Test page URL:', testPage.url());
            return { pagesCount: pages.length, foundTestPage: true, url: testPage.url() };
          }

          return { pagesCount: pages.length, foundTestPage: false };
        `,
      },
    })

    const afterReconnectOutput = (afterReconnect as any).content[0].text
    console.log('After reconnect:', afterReconnectOutput)
    expect(afterReconnectOutput).toContain('foundTestPage')
    expect(afterReconnectOutput).toContain('disconnect-test')

    // Clean up
    await page.goto('about:blank')
  })

  it('should auto-reconnect MCP after extension WebSocket reconnects', async () => {
    const serviceWorker = await getExtensionServiceWorker(testCtx!.browserContext)

    // 1. Create a test page and enable extension
    const page = await testCtx!.browserContext.newPage()
    await page.goto('https://example.com/auto-reconnect-test')
    await page.waitForLoadState('domcontentloaded')
    await page.bringToFront()

    const initialEnable = await serviceWorker.evaluate(async () => {
      return await globalThis.toggleExtensionForActiveTab()
    })
    expect(initialEnable.isConnected).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))

    // 2. Verify MCP can execute commands
    const beforeResult = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          let testPage;
          for (let i = 0; i < 20; i++) {
            const pages = context.pages();
            testPage = pages.find(p => p.url().includes('auto-reconnect-test'));
            if (testPage) break;
            await new Promise((r) => { setTimeout(r, 100) });
          }
          const pages = context.pages();
          return { pagesCount: pages.length, foundTestPage: !!testPage, url: testPage?.url() };
        `,
      },
    })
    const beforeOutput = (beforeResult as any).content[0].text
    expect(beforeOutput).toContain('foundTestPage')
    expect(beforeOutput).toContain('true')
    expect(beforeOutput).toContain('auto-reconnect-test')

    // 3. Simulate extension WebSocket reconnection
    await serviceWorker.evaluate(async () => {
      await globalThis.disconnectEverything()
    })
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Re-enable extension
    await page.bringToFront()
    const reconnectResult = await serviceWorker.evaluate(async () => {
      return await globalThis.toggleExtensionForActiveTab()
    })
    expect(reconnectResult.isConnected).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))

    // 4. Execute command WITHOUT calling resetPlaywright()
    const afterResult = await client.callTool({
      name: 'execute',
      arguments: {
        code: js`
          let testPage;
          for (let i = 0; i < 20; i++) {
            const pages = context.pages();
            testPage = pages.find(p => p.url().includes('auto-reconnect-test'));
            if (testPage) break;
            await new Promise((r) => { setTimeout(r, 100) });
          }
          const pages = context.pages();
          return { pagesCount: pages.length, foundTestPage: !!testPage, url: testPage?.url() };
        `,
      },
    })

    const afterOutput = (afterResult as any).content[0].text
    expect(afterOutput).toContain('foundTestPage')
    expect(afterOutput).toContain('true')
    expect(afterOutput).toContain('auto-reconnect-test')
    expect(afterOutput).not.toContain('Extension not connected')
    expect((afterResult as any).isError).not.toBe(true)

    // Clean up
    await page.goto('about:blank')
  })

  it('should keep an active browser connected when another Chromium context starts', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    await serviceWorker.evaluate(async () => {
      await globalThis.disconnectEverything()
    })

    const page = await browserContext.newPage()
    const targetUrl = 'https://example.com/multi-context-stability'
    await page.goto(targetUrl)
    await page.waitForLoadState('domcontentloaded')
    await page.bringToFront()

    const enableResult = await serviceWorker.evaluate(async () => {
      return await globalThis.toggleExtensionForActiveTab()
    })
    expect(enableResult.isConnected).toBe(true)

    const secondUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-conn-second-'))
    const extensionPath = path.resolve(process.cwd(), '../extension', `dist-${TEST_PORT}`)
    const secondContext = await chromium.launchPersistentContext(secondUserDataDir, {
      channel: 'chromium',
      headless: !process.env.HEADFUL,
      colorScheme: 'dark',
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    })

    try {
      await getExtensionServiceWorker(secondContext)

      const statusSnapshots: Array<{ keys: string[]; activeTargets: number[] }> = []
      for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => {
          setTimeout(resolve, 1000)
        })
        const statuses = await getExtensionsStatus(TEST_PORT)
        statusSnapshots.push({
          keys: statuses.map((status) => {
            return status.stableKey || status.extensionId
          }),
          activeTargets: statuses.map((status) => {
            return status.activeTargets
          }),
        })
      }

      expect(statusSnapshots.every((snapshot) => {
        return snapshot.keys.length >= 2
      })).toBe(true)
      expect(statusSnapshots.every((snapshot) => {
        return new Set(snapshot.keys).size === snapshot.keys.length
      })).toBe(true)
      expect(statusSnapshots.every((snapshot) => {
        return snapshot.activeTargets.some((count) => count > 0)
      })).toBe(true)

      const executeResult = await client.callTool({
        name: 'execute',
        arguments: {
          code: js`
            const pages = context.pages();
            const testPage = pages.find((p) => p.url().includes('multi-context-stability'));
            return { pagesCount: pages.length, found: !!testPage, url: testPage?.url() };
          `,
        },
      })

      const executeOutput = (executeResult as any).content[0].text
      expect(executeOutput).toContain('found: true')
      expect(executeOutput).toContain(targetUrl)
      expect((executeResult as any).isError).not.toBe(true)
    } finally {
      await secondContext.close()
      fs.rmSync(secondUserDataDir, { recursive: true, force: true })
      if (!page.isClosed()) {
        await page.close()
      }
      await serviceWorker.evaluate(async () => {
        await globalThis.disconnectEverything()
      })
    }
  }, 120000)

  it('should maintain correct page.url() with service worker pages', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    const targetUrl = 'https://example.com/sw-test'
    await page.goto(targetUrl)
    await page.bringToFront()

    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })

    await new Promise((r) => setTimeout(r, 100))

    const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT }))
    const cdpPages = browser.contexts()[0].pages()
    const testPage = cdpPages.find((p) => p.url().includes('sw-test'))

    expect(testPage).toBeDefined()
    expect(testPage?.url()).toContain('sw-test')
    expect(testPage?.url()).not.toContain('sw.js')

    await browser.close()
    await page.close()
  }, 30000)

  it('should maintain correct page.url() after repeated connections', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    const targetUrl = 'https://example.com/repeated-test'
    await page.goto(targetUrl)
    await page.bringToFront()

    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })

    for (let i = 0; i < 5; i++) {
      const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT }))
      const cdpPages = browser.contexts()[0].pages()
      const testPage = cdpPages.find((p) => p.url().includes('repeated-test'))

      expect(testPage).toBeDefined()
      expect(testPage?.url()).toBe(targetUrl)

      await browser.close()
      await new Promise((r) => setTimeout(r, 100))
    }

    await page.close()
  }, 30000)

  it('should maintain correct page.url() with concurrent MCP and CDP connections', async () => {
    const browserContext = getBrowserContext()
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    const targetUrl = 'https://example.com/concurrent-test'
    await page.goto(targetUrl)
    await page.bringToFront()

    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })

    await new Promise((r) => setTimeout(r, 400))

    const [mcpResult, cdpBrowser] = await Promise.all([
      client.callTool({
        name: 'execute',
        arguments: {
          code: js`
              const pages = context.pages();
              const testPage = pages.find(p => p.url().includes('concurrent-test'));
              return { url: testPage?.url(), found: !!testPage };
            `,
        },
      }),
      chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT })),
    ])

    const mcpOutput = (mcpResult as any).content[0].text
    expect(mcpOutput).toContain(targetUrl)

    const cdpPages = cdpBrowser.contexts()[0].pages()
    const cdpPage = cdpPages.find((p) => p.url().includes('concurrent-test'))
    expect(cdpPage?.url()).toBe(targetUrl)

    await cdpBrowser.close()
    await page.close()
  }, 30000)
})

// Own relay: this test restarts it, which would break the shared MCP client above.
describe('Extension connect during relay handshake', () => {
  const PORT = 19998
  let testCtx: TestContext | null = null

  beforeAll(async () => {
    testCtx = await setupTestContext({ port: PORT, tempDirPrefix: 'pw-handshake-test-', toggleExtension: true })
  }, 600000)

  afterAll(async () => {
    await cleanupTestContext(testCtx, null)
    testCtx = null
  })

  // Regression: enabling a tab while the extension reconnects. The handshake
  // re-attaches every 'connecting' tab, including the one being enabled; the
  // toggle then attached it again and failed with "Another debugger is already
  // attached", leaving a dead target in the relay.
  it('enables a tab whose connect overlaps the relay handshake', async () => {
    const browserContext = testCtx!.browserContext
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    const page = await browserContext.newPage()
    await page.goto('https://example.com/?handshake-race')
    await page.bringToFront()

    testCtx!.relayServer.close()
    // Toggle only after the extension saw the close, so its connect runs the handshake
    await serviceWorker.evaluate(async () => {
      while (globalThis.getExtensionState().connectionState === 'connected') {
        await new Promise((r) => setTimeout(r, 20))
      }
    })
    const toggle = serviceWorker.evaluate(async () => {
      const { isConnected, state } = await globalThis.toggleExtensionForActiveTab()
      const tabStates = [...state.tabs.values()].map((tab) => {
        return tab.state === 'error' ? `error: ${tab.errorText}` : tab.state
      })
      return { isConnected, tabStates }
    })
    testCtx!.relayServer = await startPlayWriterCDPRelayServer({
      port: PORT,
      logger: createFileLogger({ logFilePath: path.join(process.cwd(), 'relay-server.log') }),
    })
    expect(await toggle).toMatchInlineSnapshot(`
      {
        "isConnected": true,
        "tabStates": [
          "connected",
          "connected",
        ],
      }
    `)
  }, 60000)

  it('ignores a stored legacy profile label when reconnecting to the relay', async () => {
    const ctx = testCtx!
    const worker = await getExtensionServiceWorker(ctx.browserContext)
    const [before] = await getExtensionsStatus(PORT)
    expect(before?.stableKey).toBeDefined()

    await worker.evaluate(() => chrome.storage.local.set({ profileLabel: 'Obsolete alias' }))
    ctx.relayServer.close()
    await expect.poll(() => worker.evaluate(() => globalThis.getExtensionState().connectionState), { timeout: 5_000 }).not.toBe('connected')
    ctx.relayServer = await startPlayWriterCDPRelayServer({
      port: PORT,
      cdpLogger: ctx.cdpLogger,
      sessionCounterFile: ctx.sessionCounterFile,
      logger: createFileLogger({ logFilePath: path.join(process.cwd(), 'relay-server.log') }),
    })
    await expect.poll(async () => {
      const [status] = await getExtensionsStatus(PORT)
      return status?.stableKey
    }, { timeout: 15_000 }).toBe(before.stableKey)

    const options = await ctx.browserContext.newPage()
    try {
      await options.goto(new URL('src/profile-options.html', worker.url()).href)
      await options.getByLabel('URL masks').waitFor()
      expect(await options.getByLabel('Profile label').count()).toBe(0)
      const [after] = await getExtensionsStatus(PORT)
      expect(after?.profile?.label).toBeFalsy()
    } finally {
      await options.close()
    }
  })

  it('reconnects after Chrome stopped the idle service worker while the relay was down', async () => {
    const ctx = testCtx!
    const [before] = await getExtensionsStatus(PORT)
    expect(before?.stableKey).toBeDefined()

    ctx.relayServer.close()
    // What Chrome does on its own after 30 idle seconds without a socket.
    const page = await ctx.browserContext.newPage()
    const browserSession = await ctx.browserContext.browser()!.newBrowserCDPSession()
    const workerTargets = async () => {
      const { targetInfos } = await browserSession.send('Target.getTargets')
      return targetInfos.filter((target) => target.type === 'service_worker' && target.url.startsWith('chrome-extension://'))
    }
    for (const target of await workerTargets()) {
      await browserSession.send('Target.closeTarget', { targetId: target.targetId })
    }
    await expect.poll(async () => (await workerTargets()).length, { timeout: 10_000 }).toBe(0)

    ctx.relayServer = await startPlayWriterCDPRelayServer({
      port: PORT,
      cdpLogger: ctx.cdpLogger,
      sessionCounterFile: ctx.sessionCounterFile,
      logger: createFileLogger({ logFilePath: path.join(process.cwd(), 'relay-server.log') }),
    })
    try {
      // Nothing touches the browser here: only the alarm can start the worker again.
      await expect.poll(async () => {
        const [status] = await getExtensionsStatus(PORT)
        return status?.stableKey
      }, { timeout: 75_000, interval: 1000 }).toBe(before!.stableKey)
    } finally {
      await browserSession.detach().catch(() => {})
      await page.close()
    }
  }, 120_000)

  it('reconnects under the stored install id when storage answers after the connect', async () => {
    const ctx = testCtx!
    const worker = await getExtensionServiceWorker(ctx.browserContext)
    const [before] = await getExtensionsStatus(PORT)
    const storedKey = before?.stableKey || ''
    expect(storedKey).toMatch(/^install:[^:]+:[^:]+$/)
    const [, browser, storedId] = storedKey.split(':')
    const connectedKeys = async () => {
      return (await getExtensionsStatus(PORT)).map((status) => status.stableKey)
    }

    // The worker connected under one id and learns the stored one later, as after a slow storage read.
    await worker.evaluate((id) => globalThis.adoptLateInstallId(id), 'late-install-id')
    await expect.poll(connectedKeys, { timeout: 15_000 }).toEqual([`install:${browser}:late-install-id`])

    await worker.evaluate((id) => globalThis.adoptLateInstallId(id), storedId)
    await expect.poll(connectedKeys, { timeout: 15_000 }).toEqual([storedKey])
  })
})

describe('Extension toolbar icons', () => {
  const PORT = 19980
  let testCtx: TestContext | null = null

  beforeAll(async () => {
    testCtx = await setupTestContext({ port: PORT, tempDirPrefix: 'pw-icons-test-' })
  }, 600000)

  afterAll(async () => {
    await cleanupTestContext(testCtx, null)
    testCtx = null
  })

  // Regression: every title change in any tab re-sent the icon of every open tab.
  // 20 tabs updating their title each second kept Chrome at ~1.5 cores. https://github.com/remorses/playwriter/pull/142
  it('sends icons only for tabs whose icon changed', async () => {
    const browserContext = testCtx!.browserContext
    const serviceWorker = await getExtensionServiceWorker(browserContext)
    const pages = await Promise.all(Array.from({ length: 4 }, () => browserContext.newPage()))
    for (const [i, page] of pages.entries()) {
      await page.goto(`data:text/html,<title>icon-tab-${i}</title>`)
    }
    await pages[3].goto('chrome://version')
    await pages[0].bringToFront()
    await expect
      .poll(() => serviceWorker.evaluate(async () => (await chrome.tabs.query({ status: 'loading' })).length))
      .toBe(0)

    await serviceWorker.evaluate(() => {
      const calls = { setIcon: 0 }
      const setIcon = chrome.action.setIcon.bind(chrome.action)
      chrome.action.setIcon = ((details: chrome.action.TabIconDetails) => {
        calls.setIcon++
        return setIcon(details)
      }) as typeof chrome.action.setIcon
      Object.assign(globalThis, { iconCalls: calls, restoreSetIcon: () => (chrome.action.setIcon = setIcon) })
    })
    const takeSetIconCalls = () => {
      return serviceWorker.evaluate(() => {
        const calls = (globalThis as any).iconCalls as { setIcon: number }
        const count = calls.setIcon
        calls.setIcon = 0
        return count
      })
    }
    const getActionTitle = (tabTitle: string) => {
      return serviceWorker.evaluate(async (tabTitle) => {
        const [tab] = await chrome.tabs.query({ title: tabTitle })
        return tab ? chrome.action.getTitle({ tabId: tab.id }) : null
      }, tabTitle)
    }

    const readIcons = () => {
      return serviceWorker.evaluate(async () => {
        const tabs = await chrome.tabs.query({})
        const ours = tabs.filter((tab) => tab.title?.startsWith('icon-tab-') || tab.url === 'chrome://version/')
        const rows = await Promise.all(
          ours.map(async (tab) => {
            const name = tab.url === 'chrome://version/' ? 'chrome://version' : tab.title
            const title = await chrome.action.getTitle({ tabId: tab.id })
            const badge = await chrome.action.getBadgeText({ tabId: tab.id })
            return `${name}: ${title} [${badge}]`
          }),
        )
        return rows.join('\n')
      })
    }

    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })
    await expect.poll(() => getActionTitle('icon-tab-0')).toBe('Connected - Click to disconnect')
    // Only the connected tab (connecting, connected) and the default icon (count badge)
    expect(await takeSetIconCalls()).toMatchInlineSnapshot(`3`)
    // The connecting badge "..." is cleared, so the connected tab shows the default count badge
    expect(await readIcons()).toMatchInlineSnapshot(`
      "icon-tab-0: Connected - Click to disconnect [1]
      icon-tab-1: Click to attach debugger [1]
      icon-tab-2: Click to attach debugger [1]
      chrome://version: Cannot attach to this page [1]"
    `)

    // Listeners run in registration order, so the extension handled every change once ours sees the last one
    const titleChanges = 10
    await serviceWorker.evaluate((last) => {
      const lastTitleSeen = new Promise<void>((resolve) => {
        chrome.tabs.onUpdated.addListener(function onTitle(_tabId, changeInfo) {
          if (changeInfo.title !== last) return
          chrome.tabs.onUpdated.removeListener(onTitle)
          resolve()
        })
      })
      Object.assign(globalThis, { lastTitleSeen })
    }, `icon-tab-2 ${titleChanges}`)
    await pages[2].evaluate(async (count) => {
      for (let i = 1; i <= count; i++) {
        document.title = `icon-tab-2 ${i}`
        await new Promise((r) => setTimeout(r, 20))
      }
    }, titleChanges)
    await serviceWorker.evaluate(() => (globalThis as any).lastTitleSeen)
    expect(await takeSetIconCalls()).toBe(0)

    // Chrome clears per-tab icons on a new document: the connected tab gets its icon back
    await pages[0].goto('data:text/html,<title>icon-tab-0 reloaded</title>')
    await expect.poll(() => getActionTitle('icon-tab-0 reloaded')).toBe('Connected - Click to disconnect')
    expect(await readIcons()).toMatchInlineSnapshot(`
      "icon-tab-0 reloaded: Connected - Click to disconnect [1]
      icon-tab-1: Click to attach debugger [1]
      icon-tab-2 10: Click to attach debugger [1]
      chrome://version: Cannot attach to this page [1]"
    `)

    // Disconnecting resets the tab to idle and every tab falls back to the empty default badge
    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })
    await expect.poll(() => getActionTitle('icon-tab-0 reloaded')).toBe('Click to attach debugger')
    expect(await readIcons()).toMatchInlineSnapshot(`
      "icon-tab-0 reloaded: Click to attach debugger []
      icon-tab-1: Click to attach debugger []
      icon-tab-2 10: Click to attach debugger []
      chrome://version: Cannot attach to this page []"
    `)
    await serviceWorker.evaluate(() => (globalThis as any).restoreSetIcon())

    for (const page of pages) {
      await page.close()
    }
  }, 60000)
})
