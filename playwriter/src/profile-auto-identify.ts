import { dataPath } from './runtime-config.js'
import fs from 'node:fs'
import path from 'node:path'
import type { BrowserOption } from './relay-sessions.js'

const retryFile = dataPath('profile-identify-retry.json')
const RETRY_MS = 5 * 60 * 1000

type IdentifyProfile = (key: string) => Promise<string | null>

/** Resolve a key directly or verify each connected Chrome profile at selection time. */
export async function selectBrowserOption({
  key, options, identify, verifiedConnections,
}: {
  key: string
  options: BrowserOption[]
  identify?: IdentifyProfile
  /** Browser key to the extension connection its cached name was verified on. */
  verifiedConnections?: Record<string, string>
}): Promise<BrowserOption> {
  const exact = options.find((option) => option.key === key)
  if (exact) return exact

  const available = options.map((option) => option.key).join(', ') || '(none)'
  const useKey = `Use a browser key from 'better-playwriter browser list'. Available keys: ${available}`
  const chromeProfiles = options.filter((option) => option.type === 'extension' && option.browser === 'Chrome')
  if (!identify || !chromeProfiles.length) {
    throw new Error(`Browser not found: ${key}. ${useKey}`)
  }

  // A name verified on this same extension connection is trusted: the profile behind a live connection
  // cannot change. A rename shows up after the extension reconnects. Any other doubt falls back to probes.
  const named = chromeProfiles.filter((option) => option.profileName === key)
  const everyNameKnown = chromeProfiles.every((option) => option.profileName)
  if (named.length === 1 && everyNameKnown && named[0].connectionId && verifiedConnections?.[named[0].key] === named[0].connectionId) {
    return named[0]
  }

  const matches: BrowserOption[] = []
  let unavailable = false
  // Each probe opens a tab and reads Chrome's window, so try the cached names first. A profile cached
  // under this name is verified, and one with no cached name may also carry it. Profiles cached under
  // another name are probed only if this pass finds nothing, for example after a rename.
  const likely = chromeProfiles.filter((option) => !option.profileName || option.profileName === key)
  const cachedMatch = likely.some((option) => option.profileName === key)
  for (const option of cachedMatch ? likely : []) {
    const name = option.key.startsWith('install:Chrome:') ? await identify(option.key).catch(() => null) : null
    if (!name) unavailable = true
    if (name === key) matches.push(option)
  }
  if (matches.length > 1) throw new Error(`Multiple Chrome profiles are named "${key}". ${useKey}`)
  if (matches.length === 1 && !unavailable) return matches[0]
  const probed = new Set(cachedMatch ? likely : [])
  for (const option of chromeProfiles) {
    if (probed.has(option)) continue
    const name = option.key.startsWith('install:Chrome:') ? await identify(option.key).catch(() => null) : null
    if (!name) unavailable = true
    if (name === key) matches.push(option)
  }
  if (matches.length > 1) throw new Error(`Multiple Chrome profiles are named "${key}". ${useKey}`)
  if (unavailable) throw new Error(`Could not verify Chrome profile "${key}". Check macOS Accessibility. ${useKey}`)
  if (matches.length === 1) return matches[0]
  throw new Error(`No connected Chrome profile is named "${key}". ${useKey}`)
}

/** Resolve unknown local profiles once, and back off when Accessibility is unavailable. */
export async function identifyUnknownProfiles(options: BrowserOption[], identify: IdentifyProfile, now = Date.now(), retryFilePath = retryFile): Promise<void> {
  let failures: Record<string, number> = {}
  try {
    const stored = JSON.parse(fs.readFileSync(retryFilePath, 'utf8'))
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) failures = stored
  } catch {}
  let changed = false
  for (const option of options) {
    if (option.type !== 'extension' || !option.key.startsWith('install:Chrome:') || option.profileName) continue
    const failedAt = failures[option.key]
    if (typeof failedAt === 'number' && now >= failedAt && now - failedAt < RETRY_MS) continue
    let name: string | null = null
    try { name = await identify(option.key) } catch {}
    if (name) {
      option.profile = name
      option.profileName = name
      if (option.key in failures) { delete failures[option.key]; changed = true }
    } else {
      failures[option.key] = now
      changed = true
    }
  }
  if (changed) {
    try {
      fs.mkdirSync(path.dirname(retryFilePath), { recursive: true, mode: 0o700 })
      fs.writeFileSync(retryFilePath, JSON.stringify(failures), { mode: 0o600 })
    } catch {}
  }
}
