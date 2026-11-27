import { dataPath } from './runtime-config.js'
import fs from 'node:fs'
import path from 'node:path'

const file = dataPath('local-profile-names.json')

/** Names observed locally, keyed by the extension installation. Never used for remote relays. */
export function readLocalProfileNames(): Record<string, string> {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    return Object.fromEntries(Object.entries(data).filter(([key, value]) => key.startsWith('install:') && typeof value === 'string' && value.length > 0 && value.length <= 100)) as Record<string, string>
  } catch {
    return {}
  }
}

export function saveLocalProfileName(key: string, name: string): void {
  if (!key.startsWith('install:') || !name || name.length > 100) throw new Error('Invalid profile name or browser key')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const names = { ...readLocalProfileNames(), [key]: name }
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(names, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(temporary, file)
}
