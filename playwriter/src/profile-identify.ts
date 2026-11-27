import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { deleteSession, executeInSession, isLocalRelay, newSession, type RelayTarget } from './relay-sessions.js'
import { saveLocalProfileName } from './profile-labels.js'

const run = promisify(execFile)
const profileScript = fileURLToPath(new URL('../src/chrome-profile-macos.jxa', import.meta.url))

export async function checkMacAccessibility(): Promise<boolean | null> {
  if (process.platform !== 'darwin') return null
  try {
    const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', profileScript, '--check-access'], { timeout: 3000 })
    const value: unknown = JSON.parse(stdout)
    return typeof value === 'boolean' ? value : null
  } catch {
    return null
  }
}

async function readChromeProfileName(marker: string): Promise<string | null> {
  const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', profileScript, marker], { timeout: 3000 })
  const name: unknown = JSON.parse(stdout)
  return typeof name === 'string' && name.length > 0 && name.length <= 100 ? name : null
}

/** Identify a local Chrome profile through its uniquely marked temporary tab and macOS Accessibility. */
export async function identifyLocalChromeProfile(key: string, relay: RelayTarget = {}): Promise<string | null> {
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
    if (name) {
      try {
        saveLocalProfileName(key, name)
      } catch {
        // A cache write failure does not invalidate the name we just read.
      }
    }
    return name
  } finally {
    await deleteSession({ relay, sessionId, closeCreatedTabs: true }).catch(() => {})
  }
}
