import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, test } from 'vitest'
import { skillReferenceNames } from './skill-references.js'

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
    expect(resources.map(({ uri }) => uri).sort()).toEqual(
      ['debugger-api', 'editor-api', 'styles-api', 'recording-guide', ...skillReferenceNames.map((name) => `skill-${name}`)]
        .map((name) => `better-playwriter://resources/${name}.md`)
        .sort(),
    )
    const { tools } = await client.listTools()
    const execute = tools.find(({ name }) => name === 'execute')
    expect(execute?.description).toContain('Find, act, and verify')
    expect(execute?.description).not.toContain('## CLI Usage')
    expect(Buffer.byteLength(execute?.description ?? '')).toBeLessThan(4_000)
    for (const { uri } of resources) {
      expect(uri).toMatch(/^better-playwriter:\/\/resources\//)
      const { contents } = await client.readResource({ uri })
      if (uri.endsWith('/recording-guide.md')) {
        expect(contents[0]).toHaveProperty('text', expect.stringContaining('## Demo video acceleration'))
      }
      expect(contents).toEqual([{ uri, mimeType: 'text/plain', text: expect.stringMatching(/\S/) }])
    }
  } finally {
    await client.close()
  }
})
