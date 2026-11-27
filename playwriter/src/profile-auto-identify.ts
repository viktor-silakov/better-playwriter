import { dataPath } from './runtime-config.js'
import fs from 'node:fs'
import path from 'node:path'
import type { BrowserOption } from './relay-sessions.js'

const retryFile = dataPath('profile-identify-retry.json')
const RETRY_MS = 5 * 60 * 1000

/** Resolve unknown local profiles once, and back off when Accessibility is unavailable. */
export async function identifyUnknownProfiles(options: BrowserOption[], identify: (key: string) => Promise<string | null>, now = Date.now(), retryFilePath = retryFile): Promise<void> {
  let failures: Record<string, number> = {}
  try {
    const stored = JSON.parse(fs.readFileSync(retryFilePath, 'utf8'))
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) failures = stored
  } catch {}
  let changed = false
  for (const option of options) {
    if (option.type !== 'extension' || !option.key.startsWith('install:Chrome:') || option.profileLabel) continue
    const failedAt = failures[option.key]
    if (typeof failedAt === 'number' && now >= failedAt && now - failedAt < RETRY_MS) continue
    let name: string | null = null
    try { name = await identify(option.key) } catch {}
    if (name) {
      option.profile = name
      option.profileLabel = name
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
