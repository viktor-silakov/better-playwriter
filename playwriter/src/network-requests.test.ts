import { EventEmitter } from 'node:events'
import type { Page } from '@xmorse/playwright-core'
import { expect, it } from 'vitest'
import { getLatestRequests, observeRequests } from './network-requests.js'

it('buffers requests per page, advances the cursor and omits URL credentials and queries', () => {
  const events = new EventEmitter()
  const page = events as unknown as Page
  const other = new EventEmitter() as unknown as Page
  const makeRequest = (path: string) => ({
    method: () => 'GET',
    url: () => `https://user:secret@example.test/${path}?token=secret#fragment`,
    resourceType: () => 'fetch',
    failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }),
  })
  observeRequests(page)
  observeRequests(page)
  events.emit('response', { request: () => makeRequest('ok'), status: () => 200 })
  events.emit('response', { request: () => makeRequest('bad'), status: () => 404 })
  events.emit('requestfailed', makeRequest('offline'))
  expect(getLatestRequests({ page: other })).toEqual([])
  expect(getLatestRequests({ page, failedOnly: true, sinceLastCall: true })).toEqual([
    { method: 'GET', url: 'https://example.test/bad', resourceType: 'fetch', status: 404, failure: null },
    { method: 'GET', url: 'https://example.test/offline', resourceType: 'fetch', status: null, failure: 'net::ERR_CONNECTION_RESET' },
  ])
  expect(getLatestRequests({ page, sinceLastCall: true })).toEqual([])
  expect(getLatestRequests({ page, search: /offline/g, count: 1 })).toHaveLength(1)
  expect(getLatestRequests({ page, count: 0 })).toEqual([])
})
