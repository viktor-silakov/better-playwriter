import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, test } from 'vitest'

test('MCP reads the fork’s bundled documentation without the upstream package', async () => {
  await using relay = createServer((request, response) => {
    response.writeHead(request.url === '/version' ? 200 : 404).end()
  })
  relay.listen(0, '127.0.0.1')
  await once(relay, 'listening')
  const { port } = relay.address() as AddressInfo
  const client = new Client({ name: 'resource-test', version: '1.0.0' })
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [path.join(import.meta.dirname, '..', 'bin.js'), '--host', `http://127.0.0.1:${port}`],
    }))
    const { resources } = await client.listResources()
    expect(resources).toHaveLength(3)
    for (const { uri } of resources) {
      expect(uri).toMatch(/^better-playwriter:\/\/resources\//)
      const { contents } = await client.readResource({ uri })
      expect(contents).toEqual([{ uri, mimeType: 'text/plain', text: expect.stringMatching(/\S/) }])
    }
  } finally {
    await client.close()
  }
})
