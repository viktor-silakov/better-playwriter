import fs from 'node:fs'
import path from 'node:path'
import { normalizeTabGroupColor, normalizeTabGroupTitle, type TabGroupColor } from './protocol.js'

export type SavedSession = {
  id: string
  ownerKey: string
  extensionKey: string
  browser: string | null
  cwd: string | null
  tabGroup: string | null
  tabGroupColor: TabGroupColor | null
  patchright: boolean
  assignedTargets?: string[]
}

export function readSavedSessions(filePath: string | undefined): Map<string, SavedSession> {
  if (!filePath) return new Map()
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (data?.version !== 1 || !Array.isArray(data.sessions)) return new Map()
    const sessions = new Map<string, SavedSession>()
    for (const record of data.sessions) {
      if (typeof record?.id !== 'string' || !/^[1-9][0-9]*$/.test(record.id) ||
        !Number.isSafeInteger(Number(record.id)) || Number(record.id) >= Number.MAX_SAFE_INTEGER ||
        typeof record.ownerKey !== 'string' || !/^[0-9a-f-]{36}:[1-9][0-9]*$/.test(record.ownerKey) ||
        !record.ownerKey.endsWith(':' + record.id) ||
        typeof record.extensionKey !== 'string' || !record.extensionKey.startsWith('install:')) continue
      sessions.set(record.id, {
        id: record.id,
        ownerKey: record.ownerKey,
        extensionKey: record.extensionKey,
        browser: typeof record.browser === 'string' ? record.browser : null,
        cwd: typeof record.cwd === 'string' ? record.cwd : null,
        tabGroup: normalizeTabGroupTitle(record.tabGroup),
        tabGroupColor: normalizeTabGroupColor(record.tabGroupColor),
        patchright: record.patchright === true,
        assignedTargets: Array.isArray(record.assignedTargets)
          ? record.assignedTargets.filter((target: unknown) => typeof target === 'string' && /^[a-z0-9-]{1,128}$/i.test(target))
          : undefined,
      })
    }
    return sessions
  } catch {
    return new Map()
  }
}

export function writeSavedSessions(filePath: string, sessions: Iterable<SavedSession>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tmpFile = filePath + '.' + process.pid + '.tmp'
  try {
    fs.writeFileSync(tmpFile, JSON.stringify({ version: 1, sessions: [...sessions] }) + '\n', { mode: 0o600 })
    fs.renameSync(tmpFile, filePath)
  } finally {
    fs.rmSync(tmpFile, { force: true })
  }
}
