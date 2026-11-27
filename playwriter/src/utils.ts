import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_RELAY_PORT, DEV_EXTENSION_ID } from './brand.js'
import { DEFAULT_DATA_DIR, dataPath, getRelayPort, readEnv } from './runtime-config.js'
import type { TabGroupColor } from './protocol.js'

/**
 * Parse a relay host string into HTTP and WebSocket base URLs.
 * Supports both plain hostnames (appends port) and full URLs (uses as-is).
 *
 * Examples:
 *   "192.168.1.10"                        → http://192.168.1.10:19989, ws://192.168.1.10:19989
 *   "https://my-machine-tunnel.traforo.dev" → https://my-machine-tunnel.traforo.dev, wss://my-machine-tunnel.traforo.dev
 */
export function parseRelayHost(host: string, port: number = getRelayPort()): { httpBaseUrl: string; wsBaseUrl: string } {
  if (host.startsWith('https://') || host.startsWith('http://')) {
    const url = new URL(host)
    const httpBaseUrl = url.origin
    const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsBaseUrl = `${wsProtocol}//${url.host}`
    return { httpBaseUrl, wsBaseUrl }
  }
  return {
    httpBaseUrl: `http://${host}:${port}`,
    wsBaseUrl: `ws://${host}:${port}`,
  }
}

export function getCdpUrl({
  port = getRelayPort(),
  host = '127.0.0.1',
  token,
  extensionId,
  sessionId,
  tabGroup,
  tabGroupColor,
  patchright,
}: {
  port?: number
  host?: string
  token?: string
  extensionId?: string | null
  /** CLI session id, sent as ?session= so the relay can map this client to its session */
  sessionId?: string
  /** Tab group title for tabs this client creates (default 'playwriter'). Old relays ignore it. */
  tabGroup?: string
  /** Explicit tab group color chosen with --tab-group-color. Old relays ignore it. */
  tabGroupColor?: TabGroupColor
  /** The client connects with Patchright, so the relay humanizes its input on every page. Old relays ignore it. */
  patchright?: boolean
} = {}) {
  const id = `${Math.random().toString(36).substring(2, 15)}_${Date.now()}`
  const params = new URLSearchParams()
  if (token) {
    params.set('token', token)
  }
  if (extensionId) {
    params.set('extensionId', extensionId)
  }
  if (sessionId) {
    params.set('session', sessionId)
  }
  if (tabGroup) {
    params.set('tabGroup', tabGroup)
  }
  if (tabGroupColor) {
    params.set('tabGroupColor', tabGroupColor)
  }
  if (patchright) {
    params.set('patchright', '1')
  }
  const queryString = params.toString()
  const suffix = queryString ? `?${queryString}` : ''
  const { wsBaseUrl } = parseRelayHost(host, port)
  return `${wsBaseUrl}/cdp/${id}${suffix}`
}

export function redactRemoteControlSecrets(value: string): string {
  return value
    .replace(/(\/remote-control#)[a-z0-9-]{1,63}/gi, '$1[redacted]')
    .replace(/[a-z0-9-]{1,63}(?=-tunnel\.)/gi, '[redacted]')
    .replace(/(_tunnelId=)[a-z0-9-]{1,63}/gi, '$1[redacted]')
    .replace(/(\/tunnel\/)[a-z0-9-]{1,63}/gi, '$1[redacted]')
}

// Use ~/.better-playwriter for logs so each OS user gets their own dir (avoids permission errors on shared machines, see #44)
const LOG_BASE_DIR = dataPath()
// A relay on another port keeps its own files, so two relays never interleave their lines.
const LOG_PORT_SUFFIX = getRelayPort() === DEFAULT_RELAY_PORT ? '' : `-${getRelayPort()}`
export const LOG_FILE_PATH = readEnv('LOG_FILE_PATH') || path.join(LOG_BASE_DIR, `relay-server${LOG_PORT_SUFFIX}.log`)
export const LOG_CDP_FILE_PATH =
  readEnv('CDP_LOG_FILE_PATH') ||
  path.join(path.dirname(LOG_FILE_PATH), readEnv('LOG_FILE_PATH') ? 'cdp.jsonl' : `cdp${LOG_PORT_SUFFIX}.jsonl`)

/** Logs hold cookies, typed text and page content: only this OS user may read them. */
export const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIR_MODE = 0o700

/** Create a log file's folder and make the file private. Only the default data directory is chmodded. */
export function preparePrivateLogFile(filePath: string): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
  if (path.resolve(dir) === DEFAULT_DATA_DIR) {
    fs.chmodSync(dir, PRIVATE_DIR_MODE)
  }
  fs.writeFileSync(filePath, '', { mode: PRIVATE_FILE_MODE })
  // writeFileSync only applies the mode to new files
  fs.chmodSync(filePath, PRIVATE_FILE_MODE)
}

const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
const packageMetadata = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
  version: string
  betterPlaywriter?: { storeId?: string | null }
}
export const VERSION = packageMetadata.version

// Production installs have a Store ID. Development uses the public key in Vite's manifest transform.
const storeId = readEnv('STORE_ID') || packageMetadata.betterPlaywriter?.storeId
export const STORE_EXTENSION_ID = storeId && /^[a-p]{32}$/.test(storeId) ? storeId : undefined
export const EXTENSION_IDS = STORE_EXTENSION_ID ? [DEV_EXTENSION_ID, STORE_EXTENSION_ID] : [DEV_EXTENSION_ID]

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
