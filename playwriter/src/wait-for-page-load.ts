import type { Page } from '@xmorse/playwright-core'
import { sleep } from './utils.js'
import { evaluateIsolated } from './playwright-import.js'

const FILTERED_DOMAINS = [
  'doubleclick',
  'googlesyndication',
  'googleadservices',
  'google-analytics',
  'googletagmanager',
  'facebook.net',
  'fbcdn.net',
  'twitter.com',
  'linkedin.com',
  'hotjar',
  'mixpanel',
  'segment.io',
  'segment.com',
  'newrelic',
  'datadoghq',
  'sentry.io',
  'fullstory',
  'amplitude',
  'intercom',
  'crisp.chat',
  'zdassets.com',
  'zendesk',
  'tawk.to',
  'hubspot',
  'marketo',
  'pardot',
  'optimizely',
  'crazyegg',
  'mouseflow',
  'clarity.ms',
  'bing.com/bat',
  'ads.',
  'analytics.',
  'tracking.',
  'pixel.',
]

const FILTERED_EXTENSIONS = ['.gif', '.ico', '.cur', '.woff', '.woff2', '.ttf', '.otf', '.eot']

export interface WaitForPageLoadOptions {
  page: Page
  timeout?: number
  pollInterval?: number
  minWait?: number
  /**
   * After the document is complete, wait until no request has finished for this long. A single-page app
   * fires `load` on an empty shell and fetches its content afterwards. Default 500, 0 turns it off.
   */
  quietMs?: number
  /** Requests the browser has in flight, seen from outside the page. The sandbox fills this in. */
  network?: () => { inFlight: number; quietForMs: number }
}

/** A page that never goes quiet (a heartbeat every 200 ms) counts as loaded after this long. */
const MAX_QUIET_WAIT_MS = 5000
/** No request for this long: the page is idle, and the first check can answer. */
const IDLE_PAGE_MS = 2000
/** The document changed under a check. The next document is the one to wait for. */
const NAVIGATED_ERROR =
  /Cannot find context with specified id|Execution context was destroyed|Cannot find default execution context|Inspected target navigated or closed|frame was detached|navigat/i

export interface WaitForPageLoadResult {
  success: boolean
  readyState: string
  pendingRequests: string[]
  waitTimeMs: number
  timedOut: boolean
}

export async function waitForPageLoad(options: WaitForPageLoadOptions): Promise<WaitForPageLoadResult> {
  const waitId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  try {
    return await waitForPageLoadInner({ ...options, waitId })
  } finally {
    // The observer only serves the waits in progress. Left behind, it would run on every DOM change.
    if ((options.quietMs ?? 500) > 0) {
      await evaluateIsolated({
        target: options.page,
        fn: (id) => {
          const scope = globalThis as any
          const watch = scope.__playwriterDomWatch
          if (!watch) return
          delete watch.users[id]
          if (Object.keys(watch.users).length === 0) {
            watch.observer?.disconnect()
            delete scope.__playwriterDomWatch
          }
        },
        arg: waitId,
      }).catch(() => {})
    }
  }
}

async function waitForPageLoadInner(options: WaitForPageLoadOptions & { waitId?: string }): Promise<WaitForPageLoadResult> {
  const { page, timeout = 30000, pollInterval = 100, minWait = 500, quietMs = 500 } = options
  const waitId = options.waitId ?? ''

  const startTime = Date.now()
  let timedOut = false
  let lastReadyState = ''
  let lastPendingRequests: string[] = []

  let completeSince: number | undefined
  const checkPageReady = async (): Promise<{ ready: boolean; readyState: string; pendingRequests: string[] }> => {
    const result = await checkPageState()
    if (!result.ready || quietMs <= 0) {
      return result
    }
    const firstCheck = completeSince === undefined
    completeSince ??= Date.now()
    const network = options.network?.()
    // A page that has fetched nothing for seconds is idle: no need to watch its DOM for half a second.
    const idleFor = Math.min(result.resourceQuietForMs, network ? network.quietForMs : Infinity)
    if (firstCheck && idleFor >= IDLE_PAGE_MS && (!network || network.inFlight === 0)) {
      return result
    }
    const networkQuiet = !network || (network.inFlight === 0 && network.quietForMs >= quietMs)
    if ((result.quietForMs >= quietMs && networkQuiet) || Date.now() - completeSince >= MAX_QUIET_WAIT_MS) {
      return result
    }
    return { ...result, ready: false, pendingRequests: ['requests finished in the last moments: the page is still fetching'] }
  }

  const checkPageState = async (): Promise<{
    ready: boolean
    readyState: string
    pendingRequests: string[]
    quietForMs: number
    resourceQuietForMs: number
  }> => {
    const result = await evaluateIsolated({
      target: page,
      fn: ({
        filteredDomains,
        filteredExtensions,
        stuckThreshold,
        slowResourceThreshold,
        watchDom,
        waitId,
      }): {
        ready: boolean
        readyState: string
        pendingRequests: string[]
        quietForMs: number
        resourceQuietForMs: number
      } => {
        const doc = globalThis.document as { readyState: string }
        const readyState = doc.readyState

        if (readyState !== 'complete') {
          return { ready: false, readyState, pendingRequests: [`document.readyState: ${readyState}`], quietForMs: 0, resourceQuietForMs: 0 }
        }

        const resources = (performance as any).getEntriesByType('resource') as Array<{
          name: string
          startTime: number
          responseEnd: number
          initiatorType?: string
        }>
        const now = (performance as any).now() as number

        // Time since the last request that matters finished. Beacons and trackers do not show content.
        const lastFinished = resources.reduce((latest, r) => {
          const url = r.name.toLowerCase()
          const ignored =
            r.responseEnd <= 0 ||
            r.initiatorType === 'beacon' ||
            r.initiatorType === 'ping' ||
            filteredDomains.some((domain) => url.includes(domain))
          return ignored ? latest : Math.max(latest, r.responseEnd)
        }, 0)
        // Chrome stops recording resources once its buffer is full (250 entries, less than a mail app loads),
        // so the content arriving in the DOM is the second sign that the page is still building itself.
        const scope = globalThis as any
        if (watchDom && !scope.__playwriterDomWatch) {
          const watch = { last: now, observer: undefined as any, users: {} as Record<string, true> }
          watch.observer = new scope.MutationObserver(() => {
            watch.last = (performance as any).now()
          })
          watch.observer.observe(globalThis.document, { subtree: true, childList: true, characterData: true })
          scope.__playwriterDomWatch = watch
        }
        // Two waits on one page share the observer: each registers, and the last one out removes it.
        if (watchDom) {
          scope.__playwriterDomWatch.users[waitId] = true
        }
        const resourceQuietForMs = now - lastFinished
        const domQuietForMs = scope.__playwriterDomWatch ? now - scope.__playwriterDomWatch.last : Infinity
        const quietForMs = Math.min(resourceQuietForMs, domQuietForMs)

        const pendingRequests = resources
          .filter((r) => {
            if (r.responseEnd > 0) {
              return false
            }

            const elapsed = now - r.startTime
            const url = r.name.toLowerCase()

            if (url.startsWith('data:')) {
              return false
            }

            if (filteredDomains.some((domain) => url.includes(domain))) {
              return false
            }

            if (elapsed > stuckThreshold) {
              return false
            }

            if (elapsed > slowResourceThreshold && filteredExtensions.some((ext) => url.includes(ext))) {
              return false
            }

            return true
          })
          .map((r) => r.name)

        return {
          ready: pendingRequests.length === 0,
          readyState,
          pendingRequests,
          quietForMs,
          resourceQuietForMs,
        }
      },
      arg: {
        filteredDomains: FILTERED_DOMAINS,
        filteredExtensions: FILTERED_EXTENSIONS,
        stuckThreshold: 10000,
        slowResourceThreshold: 3000,
        watchDom: quietMs > 0,
        waitId,
      },
    })

    return result
  }

  // Fast path: check immediately first. If already ready, return without waiting.
  try {
    const firstCheck = await checkPageReady()
    if (firstCheck.ready) {
      return {
        success: true,
        readyState: firstCheck.readyState,
        pendingRequests: [],
        waitTimeMs: Date.now() - startTime,
        timedOut: false,
      }
    }
    lastReadyState = firstCheck.readyState
    lastPendingRequests = firstCheck.pendingRequests
  } catch (e) {
    // First check failed, continue with polling
  }

  // Not ready yet - wait minWait to let JS settle and catch late-starting requests
  await sleep(minWait)

  while (Date.now() - startTime < timeout) {
    try {
      const { ready, readyState, pendingRequests } = await checkPageReady()
      lastReadyState = readyState
      lastPendingRequests = pendingRequests

      if (ready) {
        return {
          success: true,
          readyState,
          pendingRequests: [],
          waitTimeMs: Date.now() - startTime,
          timedOut: false,
        }
      }
    } catch (e) {
      // Only a navigation is worth waiting out. A crashed or closed page would fail until the timeout.
      const message = e instanceof Error ? e.message : String(e)
      if (page.isClosed() || !NAVIGATED_ERROR.test(message)) {
        return {
          success: false,
          readyState: 'error',
          pendingRequests: ['page.evaluate failed - page may have closed or crashed'],
          waitTimeMs: Date.now() - startTime,
          timedOut: false,
        }
      }
      // A redirect replaced the document under the check. The page it leads to is the one to wait for.
      completeSince = undefined
      lastReadyState = 'loading'
      lastPendingRequests = ['the page navigated during the wait']
    }

    await sleep(pollInterval)
  }

  timedOut = true

  return {
    success: false,
    readyState: lastReadyState,
    pendingRequests: lastPendingRequests.slice(0, 10),
    waitTimeMs: Date.now() - startTime,
    timedOut,
  }
}
