import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium } from '../playwright/packages/playwright-core/index.mjs'
import { readExtensionZip } from './package-extension.mjs'

const [zip, version, screenshot] = process.argv.slice(2)
const files = readExtensionZip(fs.readFileSync(zip), version)
const root = fileURLToPath(new URL('..', import.meta.url))
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'better-playwriter-smoke-'))
const extension = path.join(temporary, 'extension')
const exec = promisify(execFile)
const pageServer = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end(
    '<!doctype html><title>Better Playwriter release smoke</title><button>Check</button>' +
      '<script>document.querySelector("button").onclick = () => { document.title = "checked" }</script>',
  )
})

// The store ZIP has no development key. Chrome assigns an ID once it loads the exact files.
process.env.BETTER_PLAYWRITER_DATA_DIR = path.join(temporary, 'app')
process.env.DO_NOT_TRACK = '1'
for (const key of [
  'PLAYWRITER_HOST',
  'PLAYWRITER_TOKEN',
  'PLAYWRITER_PORT',
  'BETTER_PLAYWRITER_HOST',
  'BETTER_PLAYWRITER_TOKEN',
  'BETTER_PLAYWRITER_PORT',
]) {
  delete process.env[key]
}

let browserContext
let relay
const portGuard = net.createServer((socket) => socket.destroy())
try {
  const { DEFAULT_RELAY_PORT } = await import('../playwriter/dist/brand.js')
  portGuard.listen(DEFAULT_RELAY_PORT, '127.0.0.1')
  await once(portGuard, 'listening')
  for (const [entry, bytes] of Object.entries(files)) {
    const filename = path.join(extension, entry)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, bytes)
  }
  browserContext = await chromium.launchPersistentContext(path.join(temporary, 'chrome'), {
    channel: 'chromium',
    headless: true,
    timeout: 20_000,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--disable-background-networking',
    ],
  })
  const isExtensionWorker = (worker) => worker.url().startsWith('chrome-extension://')
  const worker =
    browserContext.serviceWorkers().find(isExtensionWorker) ??
    (await browserContext.waitForEvent('serviceworker', { predicate: isExtensionWorker, timeout: 15_000 }))
  process.env.BETTER_PLAYWRITER_STORE_ID = new URL(worker.url()).hostname

  const { RELAY_PORT } = await import('../playwriter/dist/relay-client.js')
  const { startPlayWriterCDPRelayServer } = await import('../playwriter/dist/cdp-relay.js')
  await new Promise((resolve) => portGuard.close(resolve))
  relay = await startPlayWriterCDPRelayServer({
    port: RELAY_PORT,
    sessionCounterFile: path.join(temporary, 'session-counter.json'),
  })
  const relayUrl = `http://127.0.0.1:${RELAY_PORT}`

  let connected = false
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await fetch(`${relayUrl}/extension/status`, { signal: AbortSignal.timeout(1000) })
    const status = await response.json()
    if (status.connected && status.inventoryReady) {
      connected = true
      break
    }
    await sleep(250)
  }
  assert.ok(connected, 'The production extension did not connect to the local relay.')

  pageServer.listen(0, '127.0.0.1')
  await once(pageServer, 'listening')
  const pageUrl = `http://127.0.0.1:${pageServer.address().port}`
  const runCli = (...args) =>
    exec(process.execPath, [path.join(root, 'playwriter/bin.js'), ...args], {
      cwd: temporary,
      timeout: 25_000,
    })
  const { stdout: created } = await runCli('session', 'new', '--host', relayUrl, '--tab-group', 'smoke')
  const sessionId = created.match(/\bSession (\d+) created\b/)?.[1]
  assert.ok(sessionId, 'The CLI did not create an extension session.')
  await runCli(
    '--host',
    relayUrl,
    '-s',
    sessionId,
    '-e',
    `
    state.page = await context.newPage()
    await state.page.goto(${JSON.stringify(pageUrl)})
    await state.page.getByRole('button', { name: 'Check' }).click()
    if (await state.page.title() !== 'checked') throw new Error('The local button did not respond')
  `,
  )
  await runCli('session', 'delete', sessionId, '--host', relayUrl, '--close-created-tabs')
  if (screenshot) {
    const onboarding = await browserContext.newPage()
    await onboarding.setViewportSize({ width: 1280, height: 800 })
    await onboarding.goto(`chrome-extension://${process.env.BETTER_PLAYWRITER_STORE_ID}/src/welcome.html`)
    await onboarding.getByRole('heading', { name: 'Getting Started with Better Playwriter' }).waitFor()
    await onboarding.getByText('Manual setup & full documentation', { exact: true }).click()
    await onboarding.screenshot({ path: screenshot })
  }
  console.log(`The store ZIP ${version} connected in headless Chromium and completed a local CLI session.`)
} finally {
  try {
    await browserContext?.close()
  } finally {
    relay?.close()
    if (portGuard.listening) portGuard.close()
    pageServer.close()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}
