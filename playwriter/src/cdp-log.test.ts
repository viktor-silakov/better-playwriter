import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createCdpLogger, type CdpLogEntry } from './cdp-log.js'
import { createFileLogger } from './create-logger.js'

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-log-test-'))
}

function makeEntry(i: number): CdpLogEntry {
  return {
    timestamp: new Date().toISOString(),
    direction: 'from-extension',
    message: { method: `Test.method${i}`, id: i },
  }
}

function readIds(logFile: string): number[] {
  return fs
    .readFileSync(logFile, 'utf-8')
    .trim()
    .split('\n')
    .filter((l) => {
      return l.length > 0
    })
    .map((l) => {
      return JSON.parse(l).message.id as number
    })
}

describe('CDP log rotation', () => {
  it('rotates when lineCount exceeds maxEntries, keeping last half', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'cdp.jsonl')
    const logger = createCdpLogger({ logFilePath: logFile, maxEntries: 20 })

    // Write 25 entries to trigger rotation (threshold is 20)
    for (let i = 0; i < 25; i++) {
      logger.log(makeEntry(i))
    }
    await logger.flush()

    const ids = readIds(logFile)

    // Rotation triggers after entry 20 is written (lineCount becomes 21 > 20).
    // It keeps last 10 (entries 11-20), then entries 21-24 are appended.
    expect(ids).toMatchInlineSnapshot(`
      [
        15,
        16,
        17,
        18,
        19,
        20,
        21,
        22,
        23,
        24,
      ]
    `)

    fs.rmSync(tmpDir, { recursive: true })
  })

  it('does not rotate when under maxEntries', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'cdp.jsonl')
    const logger = createCdpLogger({ logFilePath: logFile, maxEntries: 50 })

    for (let i = 0; i < 30; i++) {
      logger.log(makeEntry(i))
    }
    await logger.flush()

    const ids = readIds(logFile)
    expect(ids.length).toBe(30)
    expect(ids[0]).toBe(0)
    expect(ids[29]).toBe(29)

    fs.rmSync(tmpDir, { recursive: true })
  })

  it('handles multiple rotations', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'cdp.jsonl')
    const logger = createCdpLogger({ logFilePath: logFile, maxEntries: 10 })

    // Write 35 entries, should trigger multiple rotations
    for (let i = 0; i < 35; i++) {
      logger.log(makeEntry(i))
    }
    await logger.flush()

    const ids = readIds(logFile)

    // File should never exceed maxEntries
    expect(ids.length).toBeLessThanOrEqual(15)
    expect(ids.length).toBeGreaterThanOrEqual(5)

    // Last entry should always be the most recent
    expect(ids[ids.length - 1]).toBe(34)
    // No entries from the very beginning should survive multiple rotations
    expect(ids[0]).toBeGreaterThan(10)

    fs.rmSync(tmpDir, { recursive: true })
  })

  it('uses atomic rename for rotation', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'cdp.jsonl')
    const logger = createCdpLogger({ logFilePath: logFile, maxEntries: 10 })

    for (let i = 0; i < 15; i++) {
      logger.log(makeEntry(i))
    }
    await logger.flush()

    // Temp file should not remain after successful rotation
    expect(fs.existsSync(`${logFile}.tmp`)).toBe(false)

    const ids = readIds(logFile)
    expect(ids[ids.length - 1]).toBe(14)

    fs.rmSync(tmpDir, { recursive: true })
  })
})

describe('CDP log privacy', () => {
  it('drops screencast frames and redacts remote-control secrets', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'cdp.jsonl')
    const logger = createCdpLogger({ logFilePath: logFile })
    const secret = 'abc123'

    logger.log({
      timestamp: new Date().toISOString(),
      direction: 'from-extension',
      message: { method: 'Page.screencastFrame', params: { data: 'base64-frame' } },
    })
    logger.log({
      timestamp: new Date().toISOString(),
      direction: 'from-playwright',
      message: {
        method: 'Page.navigate',
        params: {
          url: `https://playwriter.dev/remote-control#${secret}`,
          tunnel: `wss://${secret}-tunnel.playwriter.dev/extension`,
          pathTunnel: `wss://playwriter.dev/tunnel/${secret}/extension`,
        },
      },
    })
    logger.log({
      timestamp: new Date().toISOString(),
      direction: 'from-extension',
      message: {
        method: 'Network.requestWillBeSentExtraInfo',
        params: { headers: { Cookie: `sid=${secret}`, Authorization: `Bearer ${secret}`, Accept: 'text/html' } },
      },
    })
    await logger.flush()

    const content = fs.readFileSync(logFile, 'utf-8')
    expect(content).not.toContain('Page.screencastFrame')
    expect(content).not.toContain(secret)
    expect(content).toContain('[redacted]')
    expect(content).toContain('text/html')
    if (process.platform !== 'win32') {
      expect(fs.statSync(logFile).mode & 0o777).toBe(0o600)
    }

    fs.rmSync(tmpDir, { recursive: true })
  })

  it('redacts and truncates multi-megabyte strings without scanning all of them', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'cdp.jsonl')
    const logger = createCdpLogger({ logFilePath: logFile, maxStringLength: 100 })
    const secret = 'abc123secret'
    const filler = '+'.repeat(60)
    // First secret sits before the limit. The second starts before it and its marker lies after it.
    const data = `${filler}/tunnel/${secret}/x${'+'.repeat(10)}${secret}-tunnel.example.test${'A'.repeat(3_000_000)}`

    const start = performance.now()
    for (let i = 0; i < 20; i++) {
      logger.log({ timestamp: new Date().toISOString(), direction: 'to-playwright', message: { id: i, result: { data } } })
    }
    const elapsed = performance.now() - start
    await logger.flush()

    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n')
    expect(lines.length).toBe(20)
    const logged = JSON.parse(lines[0]).message.result.data as string
    expect(logged).not.toContain(secret)
    expect(logged).toContain('/tunnel/[redacted]')
    expect(logged).toMatch(/…\[truncated \d+ chars\]$/)
    expect(logged.length).toBeLessThan(200)
    // Scanning the whole string took over 100 ms per message
    expect(elapsed).toBeLessThan(500)

    fs.rmSync(tmpDir, { recursive: true })
  })

  it('redacts remote-control secrets from relay logs', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'relay.log')
    const logger = createFileLogger({ logFilePath: logFile })
    const secret = 'abc123'

    await logger.log({
      viewer: `https://playwriter.dev/remote-control#${secret}`,
      tunnel: `wss://${secret}-tunnel.playwriter.dev/extension`,
    })
    await logger.flush()

    const content = fs.readFileSync(logFile, 'utf-8')
    expect(content).not.toContain(secret)
    expect(content).toContain('[redacted]')

    fs.rmSync(tmpDir, { recursive: true })
  })
})

describe('CDP log console events', () => {
  it('keeps console events short and leaves other messages whole', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'cdp.jsonl')
    const logger = createCdpLogger({ logFilePath: logFile })
    const timestamp = new Date().toISOString()

    logger.log({
      timestamp,
      direction: 'from-extension',
      message: { method: 'Log.entryAdded', params: { entry: { text: 'x'.repeat(5000), stackTrace: { callFrames: [{ url: 'https://example.com/app.js' }] } } } },
    })
    logger.log({
      timestamp,
      direction: 'from-playwright',
      message: { id: 1, method: 'Runtime.evaluate', params: { expression: 'y'.repeat(1000) } },
    })
    await logger.flush()

    const [consoleLine, commandLine] = fs
      .readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(consoleLine.message.params.entry.text).toMatch(/^x{300}…\[truncated 4700 chars\]$/)
    expect(consoleLine.message.params.entry.stackTrace).toBeUndefined()
    expect(commandLine.message.params.expression).toBe('y'.repeat(1000))

    fs.rmSync(tmpDir, { recursive: true })
  })
})

describe('CDP log large results', () => {
  it('summarizes a long array instead of writing every node', async () => {
    const tmpDir = makeTmpDir()
    const logFile = path.join(tmpDir, 'cdp.jsonl')
    const logger = createCdpLogger({ logFilePath: logFile })
    const nodes = Array.from({ length: 5000 }, (_, i) => ({ nodeId: String(i), role: { value: 'button' } }))

    logger.log({ timestamp: new Date().toISOString(), direction: 'to-playwright', message: { id: 7, result: { nodes } } })
    logger.log({ timestamp: new Date().toISOString(), direction: 'to-playwright', message: { id: 8, result: { nodes: nodes.slice(0, 3) } } })
    await logger.flush()

    const [large, small] = fs
      .readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(large.message.result.nodes).toBe('[5000 items omitted from the log]')
    expect(small.message.result.nodes).toHaveLength(3)

    fs.rmSync(tmpDir, { recursive: true })
  })
})
