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

const openErrors = new Map([
  ['accessibility-unavailable', 'Allow macOS Accessibility for the terminal running Better Playwriter.'],
  ['chrome-closed', 'Open the requested profile in Google Chrome first.'],
  ['no-windows', 'Chrome Accessibility reported no open windows. Show the requested profile window and try again.'],
  ['profile-not-found', 'No Chrome window has that exact profile name. Check the name shown in Chrome.'],
  ['ambiguous-profile', 'Several Chrome windows show that profile name. Keep one matching window open and try again.'],
  ['ambiguous-window', 'Could not uniquely match the verified profile to a Chrome window. Give that window a distinct active tab and try again.'],
  ['window-changed', 'The Chrome window changed during verification. Try again.'],
  ['unverified', 'Chrome did not confirm the active tab. Check the requested profile window.'],
])

/** For an open-only request, use the verified native window without starting a relay. */
export async function openLocalChromeProfile({ profile, url }: { profile: string; url?: string }): Promise<'opened' | 'reused'> {
  if (process.platform !== 'darwin') {
    throw new Error('Opening by Chrome profile name requires macOS. Use a verified browser key with session new on this platform.')
  }
  const name = profile.trim()
  if (!name || name.length > 100) throw new Error('Pass the exact Chrome profile name with --profile.')
  if (url !== undefined) {
    const target = URL.parse(url)
    if (!target || !['http:', 'https:'].includes(target.protocol)) {
      throw new Error('Pass an HTTP or HTTPS URL, or omit it to open a blank tab.')
    }
    url = target.href
  }

  let status: unknown
  try {
    const { stdout } = await run(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', profileScript, '--open-in-profile', name, url ?? ''],
      { timeout: 5000 },
    )
    status = JSON.parse(stdout).status
  } catch {
    throw new Error('Could not verify the Chrome tab. Check macOS Accessibility and Automation permissions and inspect the requested window.')
  }
  if (status === 'opened' || status === 'reused') return status
  throw new Error(typeof status === 'string' ? openErrors.get(status) ?? 'Chrome returned an unrecognized result.' : 'Chrome returned an invalid result.')
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
