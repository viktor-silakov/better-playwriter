import type { Page, Request, Response } from '@xmorse/playwright-core'
import { types } from 'node:util'

const MAX_REQUESTS_PER_PAGE = 200

export type RecentRequest = {
  method: string
  url: string
  resourceType: string
  status: number | null
  failure: string | null
}

export type RecentRequestsOptions = {
  page: Page
  search?: string | RegExp
  sinceLastCall?: boolean
  failedOnly?: boolean
  count?: number
}

const buffers = new WeakMap<Page, { entries: RecentRequest[]; cursor: number }>()

/** Not part of loading a page: they stay open or carry no content. */
const BACKGROUND_RESOURCE_TYPES = new Set(['websocket', 'eventsource', 'ping', 'media'])
/** A request still open after this long is a long poll or a stream. */
const LONG_REQUEST_MS = 3000
const activity = new WeakMap<Page, { open: Map<Request, number>; lastAt: number }>()

/**
 * Requests in flight right now and the time since the last one started or ended. The page cannot see
 * its own unfinished requests, so a bundle still downloading looks like a quiet page from inside.
 */
export function getNetworkActivity(page: Page): { inFlight: number; quietForMs: number } {
  observeRequests(page)
  const state = activity.get(page)!
  const now = Date.now()
  let inFlight = 0
  for (const [request, startedAt] of state.open) {
    if (now - startedAt > 60_000) {
      state.open.delete(request)
    } else if (now - startedAt <= LONG_REQUEST_MS) {
      inFlight++
    }
  }
  return { inFlight, quietForMs: now - state.lastAt }
}

function requestUrl(value: string): string {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin + url.pathname : url.protocol
  } catch {
    return ''
  }
}

/** Start collecting response and failure metadata on a page. Safe to call repeatedly. */
export function observeRequests(page: Page): void {
  if (buffers.has(page)) return
  const buffer = { entries: [] as RecentRequest[], cursor: 0 }
  buffers.set(page, buffer)
  const add = (request: Request, status: number | null, failure: string | null) => {
    buffer.entries.push({
      method: request.method(),
      url: requestUrl(request.url()).slice(0, 2048),
      resourceType: request.resourceType(),
      status,
      failure,
    })
    if (buffer.entries.length > MAX_REQUESTS_PER_PAGE) {
      buffer.entries.shift()
      buffer.cursor = Math.max(0, buffer.cursor - 1)
    }
  }
  const state = { open: new Map<Request, number>(), lastAt: Date.now() }
  activity.set(page, state)
  page.on('request', (request: Request) => {
    if (!BACKGROUND_RESOURCE_TYPES.has(request.resourceType())) {
      state.open.set(request, Date.now())
      state.lastAt = Date.now()
    }
  })
  const settle = (request: Request) => {
    if (state.open.delete(request)) {
      state.lastAt = Date.now()
    }
  }
  page.on('requestfinished', settle)
  page.on('requestfailed', settle)
  page.on('response', (response: Response) => add(response.request(), response.status(), null))
  page.on('requestfailed', (request: Request) => add(request, null, request.failure()?.errorText ?? 'Request failed'))
}

/** Return buffered request metadata without headers, bodies, credentials, queries, or fragments. */
export function getLatestRequests({
  page, search, sinceLastCall = false, failedOnly = false, count = MAX_REQUESTS_PER_PAGE,
}: RecentRequestsOptions): RecentRequest[] {
  observeRequests(page)
  const buffer = buffers.get(page)!
  const entries = buffer.entries.slice(sinceLastCall ? buffer.cursor : 0)
  if (sinceLastCall) buffer.cursor = buffer.entries.length
  const pattern = types.isRegExp(search) ? new RegExp(search.source, search.flags.replace(/[gy]/g, '')) : undefined
  const matches = entries.filter(({ method, url, status, failure }) => {
    if (failedOnly && failure === null && (status ?? 0) < 400) return false
    if (typeof search === 'string') return (method + ' ' + url).includes(search)
    return pattern ? pattern.test(method + ' ' + url) : true
  })
  return count > 0 ? matches.slice(-count).map((entry) => ({ ...entry })) : []
}
