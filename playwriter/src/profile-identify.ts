import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { deleteSession, executeInSession, newSession } from './relay-sessions.js'
import { profileNameFromWindows, saveLocalProfileName } from './profile-labels.js'

const run = promisify(execFile)

async function readJson(command: string, argument: object): Promise<any> {
  const { stdout } = await run('cmux-cua', [command, JSON.stringify(argument)], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 })
  return JSON.parse(stdout)
}

/** Identify a local Chrome profile through its uniquely marked temporary tab and macOS Accessibility. */
export async function identifyLocalChromeProfile(key: string): Promise<string | null> {
  if (process.platform !== 'darwin' || !key.startsWith('install:Chrome:')) return null
  const apps = await readJson('list_apps', {})
  const chrome = apps.apps?.find((app: { bundle_id?: string; running?: boolean }) => app.bundle_id === 'com.google.Chrome' && app.running)
  if (!chrome?.pid) return null
  const relay = {}
  const marker = `better-playwriter-${randomUUID()}`
  const session = await newSession({ relay, cwd: process.cwd(), client: 'cli', browser: key, tabGroup: marker })
  if (session.kind !== 'created') return null
  const sessionId = session.session.id
  try {
    const code = `state.identifyPage = await context.newPage(); await state.identifyPage.evaluate((marker) => { document.title = marker }, ${JSON.stringify(marker)})`
    const result = await executeInSession({ relay, sessionId, code, timeout: 12000, cwd: process.cwd(), signal: AbortSignal.timeout(15000) })
    if (result.isError || result.status !== 200) return null
    const { windows } = await readJson('list_windows', { pid: chrome.pid })
    const candidates = windows.filter((window: { is_on_screen?: boolean; bounds?: { width: number; height: number } }) => window.is_on_screen && (window.bounds?.width || 0) > 200 && (window.bounds?.height || 0) > 100)
    // AX snapshots were measured at ~7s each; in parallel four windows also took ~7s.
    const snapshots = await Promise.all(candidates.map((window: { window_id: number }) =>
      readJson('get_window_state', { pid: chrome.pid, window_id: window.window_id, include_screenshot: false }).catch(() => null),
    ))
    const name = profileNameFromWindows(marker, snapshots)
    if (name) saveLocalProfileName(key, name)
    return name
  } finally {
    await deleteSession({ relay, sessionId, closeCreatedTabs: true }).catch(() => {})
  }
}
