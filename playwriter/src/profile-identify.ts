import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { deleteSession, executeInSession, isLocalRelay, newSession } from './relay-sessions.js'
import { saveLocalProfileName } from './profile-labels.js'

const run = promisify(execFile)
const profileScript = fileURLToPath(new URL('../src/chrome-profile-macos.jxa', import.meta.url))

async function readChromeProfileName(marker: string): Promise<string | null> {
  const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', profileScript, marker], { timeout: 3000 })
  const name: unknown = JSON.parse(stdout)
  return typeof name === 'string' && name.length > 0 && name.length <= 100 ? name : null
}

/** Identify a local Chrome profile through its uniquely marked temporary tab and macOS Accessibility. */
export async function identifyLocalChromeProfile(key: string): Promise<string | null> {
  const relay = {}
  if (process.platform !== 'darwin' || !isLocalRelay(relay) || !key.startsWith('install:Chrome:')) return null
  const marker = `better-playwriter-${randomUUID()}`
  const session = await newSession({ relay, cwd: process.cwd(), client: 'cli', browser: key, tabGroup: marker })
  if (session.kind !== 'created') return null
  const sessionId = session.session.id
  try {
    const code = `state.identifyPage = await context.newPage(); await state.identifyPage.evaluate((marker) => { document.title = marker }, ${JSON.stringify(marker)})`
    const result = await executeInSession({ relay, sessionId, code, timeout: 12000, cwd: process.cwd(), signal: AbortSignal.timeout(15000) })
    if (result.isError || result.status !== 200) return null
    const name = await readChromeProfileName(marker)
    if (name) saveLocalProfileName(key, name)
    return name
  } finally {
    await deleteSession({ relay, sessionId, closeCreatedTabs: true }).catch(() => {})
  }
}
