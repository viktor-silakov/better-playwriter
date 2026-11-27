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

const connectionsFile = dataPath('local-profile-connections.json')

/** The extension connection each cached name was verified on, keyed like the names. */
export function readVerifiedConnections(): Record<string, string> {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(connectionsFile, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    return Object.fromEntries(Object.entries(data).filter(([key, value]) => key.startsWith('install:') && typeof value === 'string' && value.length > 0 && value.length <= 100)) as Record<string, string>
  } catch {
    return {}
  }
}

export function saveVerifiedConnection(key: string, connectionId: string): void {
  if (!key.startsWith('install:') || !connectionId || connectionId.length > 100) throw new Error('Invalid browser key or connection')
  fs.mkdirSync(path.dirname(connectionsFile), { recursive: true, mode: 0o700 })
  const connections = { ...readVerifiedConnections(), [key]: connectionId }
  const temporary = `${connectionsFile}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(connections, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(temporary, connectionsFile)
}
