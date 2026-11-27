import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const file = path.join(os.homedir(), '.playwriter', 'local-profile-names.json')

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

/** Only accept a unique marker in the window's AX tree and a Chrome profile suffix. */
export function profileNameFromWindows(marker: string, snapshots: unknown[]): string | null {
  const names = new Set<string>()
  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot !== 'object') continue
    const elements = (snapshot as { elements?: Array<{ label?: string; role?: string }> }).elements
    if (!Array.isArray(elements) || !elements.some((element) => element.label === marker || element.label?.startsWith(`${marker} - `))) continue
    const window = elements.find((element) => element.role === 'AXWindow')?.label
    const name = window?.match(/ - Google Chrome - (.+)$/)?.[1]?.trim()
    if (name) names.add(name)
  }
  return names.size === 1 ? [...names][0] : null
}
