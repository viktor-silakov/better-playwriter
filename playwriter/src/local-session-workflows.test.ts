import { once } from 'node:events'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { WebSocket, type ClientOptions } from 'ws'
import { DEV_EXTENSION_ID } from './brand.js'
import { startPlayWriterCDPRelayServer } from './cdp-relay.js'
import { INVENTORY_READY_CAPABILITY, TAB_ASSIGNMENT_CAPABILITY } from './protocol.js'
import { createExecutionId } from './execution-runs.js'

const quiet = { log() {}, error() {} }
const cdpLogger = { log() {}, async flush() {}, logFilePath: '' }
const waitOptions = { timeout: 10_000 }
type CreatedSession = { id: string; ownershipKey: string }

async function findPort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as net.AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

it('restores session IDs, ownership and assignments, and leaves an assigned tab open on prune', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bpw-saved-sessions-'))
  const sessionCounterFile = path.join(dir, 'counter.json')
  const extensionKey = 'install:Chrome:local-session-test'
  const sockets: WebSocket[] = []
  const relays: Awaited<ReturnType<typeof startPlayWriterCDPRelayServer>>[] = []

  async function start() {
    const port = await findPort()
    const relay = await startPlayWriterCDPRelayServer({ port, sessionCounterFile, logger: quiet, cdpLogger })
    relays.push(relay)
    const httpUrl = `http://127.0.0.1:${port}`
    const wsUrl = `ws://127.0.0.1:${port}`
    async function request<T = unknown>(route: string, body?: object): Promise<T> {
      const response = await fetch(httpUrl + route, body ? {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      } : undefined)
      expect(response.ok, await response.clone().text()).toBe(true)
      return await response.json() as T
    }
    return { relay, wsUrl, request }
  }

  async function connect(url: string, options?: ClientOptions) {
    const socket = new WebSocket(url, options)
    sockets.push(socket)
    const messages: Array<any> = []
    socket.on('message', (data) => messages.push(JSON.parse(String(data))))
    await once(socket, 'open')
    return {
      socket, messages,
      send: (message: object) => socket.send(JSON.stringify(message)),
    }
  }

  async function connectExtension(wsUrl: string) {
    const params = new URLSearchParams({
      browser: 'Chrome',
      installId: 'local-session-test',
      capabilities: [INVENTORY_READY_CAPABILITY, TAB_ASSIGNMENT_CAPABILITY].join(','),
    })
    return connect(`${wsUrl}/extension?${params}`, { origin: `chrome-extension://${DEV_EXTENSION_ID}` })
  }

  function attach(extension: Awaited<ReturnType<typeof connect>>, targetId: string, ownerKey?: string) {
    extension.send({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: `cdp-${targetId}`,
          targetInfo: { targetId, type: 'page', title: targetId, url: 'https://example.test/', attached: true, canAccessOpener: false },
          waitingForDebugger: false,
        },
        ownerKey,
      },
    })
  }

  async function targets(client: Awaited<ReturnType<typeof connect>>, id: number): Promise<string[]> {
    client.send({ id, method: 'Target.getTargets' })
    const reply = await vi.waitFor(() => {
      const message = client.messages.find((item) => item.id === id)
      expect(message?.result?.targetInfos).toBeDefined()
      return message
    }, waitOptions)
    return reply.result.targetInfos.map((item: { targetId: string }) => item.targetId).sort()
  }

  try {
    const first = await start()
    const firstExtension = await connectExtension(first.wsUrl)
    attach(firstExtension, 'borrowed')
    firstExtension.send({ method: 'ready' })
    await vi.waitFor(() => expect(firstExtension.messages).toContainEqual(expect.objectContaining({ method: 'tabAssignmentOptions' })), waitOptions)
    const one = await first.request<CreatedSession>('/cli/session/new', { extensionId: extensionKey, tabGroup: 'docs', client: 'mcp' })
    const two = await first.request<CreatedSession>('/cli/session/new', { extensionId: extensionKey, tabGroup: 'dev' })
    const firstVersion = await first.request<{ instanceId: string }>('/version')
    attach(firstExtension, 'created', one.ownershipKey)
    const owner = await connect(`${first.wsUrl}/cdp/owner?extensionId=${extensionKey}&session=${one.id}`)
    const other = await connect(`${first.wsUrl}/cdp/other?extensionId=${extensionKey}&session=${two.id}`)
    expect(await targets(other, 1)).toEqual(['borrowed'])

    firstExtension.send({ method: 'assignLocalTab', params: { targetId: 'borrowed', sessionId: one.id } })
    await vi.waitFor(() => expect(firstExtension.messages).toContainEqual({
      method: 'tabAssignmentResult', params: { targetId: 'borrowed', sessionId: one.id },
    }), waitOptions)
    await vi.waitFor(() => expect(other.messages).toContainEqual(expect.objectContaining({ method: 'Target.detachedFromTarget' })), waitOptions)
    expect(await targets(owner, 1)).toEqual(['borrowed', 'created'])
    expect(await targets(other, 2)).toEqual([])
    expect((await first.request<Array<{ id: string }>>('/json/list')).map((item) => item.id)).not.toContain('borrowed')

    for (const socket of sockets) socket.terminate()
    first.relay.close()
    const next = await start()
    const nextExtension = await connectExtension(next.wsUrl)
    attach(nextExtension, 'borrowed')
    attach(nextExtension, 'created', one.ownershipKey)
    nextExtension.send({ method: 'ready' })
    await vi.waitFor(() => expect(nextExtension.messages).toContainEqual(expect.objectContaining({ method: 'tabAssignmentOptions' })), waitOptions)
    const restored = await next.request<{ sessions: unknown[] }>('/cli/sessions?tabs=1')
    expect(restored.sessions).toEqual([
      expect.objectContaining({ id: one.id, tabGroup: 'docs', tabs: 2, tabUrls: ['https://example.test/', 'https://example.test/'], stateKeys: [] }),
      expect.objectContaining({ id: two.id, tabGroup: 'dev', tabs: 0 }),
    ])
    const restoredOwner = await connect(`${next.wsUrl}/cdp/restored-owner?extensionId=${extensionKey}&session=${one.id}`)
    const unscoped = await connect(`${next.wsUrl}/cdp/unscoped?extensionId=${extensionKey}`)
    expect(await targets(restoredOwner, 1)).toEqual(['borrowed', 'created'])
    expect(await targets(unscoped, 1)).toEqual(['created'])
    const staleExecution = await fetch(next.wsUrl.replace('ws:', 'http:') + '/cli/execute/identified', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: one.id, executionId: createExecutionId(firstVersion.instanceId), code: "throw new Error('must not run')" }),
    })
    expect(staleExecution.status).toBe(409)

    nextExtension.socket.on('message', (data) => {
      const message = JSON.parse(String(data))
      if (message.method !== 'closeTabsForKey') return
      expect(message.params).toEqual({ key: one.ownershipKey })
      nextExtension.send({ method: 'forwardCDPEvent', params: {
        method: 'Target.detachedFromTarget',
        params: { sessionId: 'cdp-created', targetId: 'created' },
      } })
      nextExtension.send({ id: message.id, result: { success: true } })
    })
    expect(await next.request('/cli/session/delete', { sessionId: one.id, closeCreatedTabs: true })).toEqual({ success: true })
    expect(await targets(unscoped, 2)).toEqual(['borrowed'])
    expect((await next.request<{ deleted: unknown[] }>('/cli/session/prune', { idleMs: 1 })).deleted).toEqual([{ sessionId: two.id }])
    expect((await next.request<{ sessions: unknown[] }>('/cli/sessions')).sessions).toEqual([])
    expect(JSON.parse(await fs.readFile(path.join(dir, 'counter.sessions.json'), 'utf8')).sessions).toEqual([])
  } finally {
    for (const socket of sockets) socket.terminate()
    for (const relay of relays) relay.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})
