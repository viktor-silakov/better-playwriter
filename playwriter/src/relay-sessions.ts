import { readEnv } from './runtime-config.js'
/**
 * Relay session API shared by the CLI and the MCP: browser discovery, session
 * create/list/update/delete/reset and execute over the relay /cli/* endpoints.
 * Nothing here prints. Callers format results and warnings for their own output.
 */

import pc from 'picocolors'
import dedent from 'string-dedent'
import { parseRelayHost } from './utils.js'
import type { TabGroupColor } from './protocol.js'
import {
  ensureRelayServer,
  waitForConnectedExtensions,
  getLocalExtensionStatuses,
  getExtensionOutdatedWarning,
  RELAY_PORT,
  EXTENSION_NOT_CONNECTED_ERROR,
  type ExtensionStatus,
} from './relay-client.js'
import { discoverChromeInstances, resolveDirectInput, type DiscoveredInstance } from './chrome-discovery.js'
import { readLocalProfileNames, readVerifiedConnections, saveVerifiedConnection } from './profile-labels.js'

const STATUS_TIMEOUT_MS = 2000
const SESSION_EXTENSION_WAIT_MS = 20_000
const EXTENSION_POLL_MS = 250
const EXECUTE_RESPONSE_GRACE_MS = 30_000

// Executes can run for minutes; undici's default headers timeout would cut them off.
// Loaded on the first execute: importing undici costs every other CLI command over 100 ms.
let executeClient: Promise<{ fetch: typeof import('undici').fetch; dispatcher: import('undici').Agent }> | undefined
function getExecuteClient() {
  executeClient ??= import('undici').then(({ Agent, fetch }) => {
    return { fetch, dispatcher: new Agent({ headersTimeout: 0, bodyTimeout: 0 }) }
  })
  return executeClient
}

const NO_CHROME_ERROR = dedent`
  No Chrome browser found. Install one first:

    better-playwriter browser install

  This downloads Chrome for Testing from Google.
`

/** Where the relay runs. Missing fields fall back to BETTER_PLAYWRITER_HOST and BETTER_PLAYWRITER_TOKEN. */
export type RelayTarget = { host?: string; token?: string }

export type SessionClient = 'cli' | 'mcp'

export class ExtensionNotConnectedError extends Error {
  readonly code = 'extension_not_connected'
  constructor() {
    super(EXTENSION_NOT_CONNECTED_ERROR)
    this.name = 'ExtensionNotConnectedError'
  }
}

export function isLocalRelay(relay: RelayTarget): boolean {
  return !relay.host && !readEnv('HOST')
}

export function getServerUrl(host?: string): string {
  const serverHost = host || readEnv('HOST') || '127.0.0.1'
  return parseRelayHost(serverHost, RELAY_PORT).httpBaseUrl
}

/** Every relay request sends the token the same way. Falls back to BETTER_PLAYWRITER_TOKEN. */
export function buildAuthHeaders({ token, json }: { token?: string; json?: boolean }): Record<string, string> {
  const headers: Record<string, string> = {}
  if (json) {
    headers['Content-Type'] = 'application/json'
  }
  const effectiveToken = token || readEnv('TOKEN')
  if (effectiveToken) {
    headers['Authorization'] = `Bearer ${effectiveToken}`
  }
  return headers
}

async function ensureLocalRelay({ relay, logger }: { relay: RelayTarget; logger?: { log: (...args: any[]) => void } }): Promise<void> {
  if (isLocalRelay(relay)) {
    await ensureRelayServer({ logger })
  }
}

/** Relay errors come as JSON { error } or { text }, or as plain text from old relays and proxies. */
async function readRelayError(response: { status: number; text: () => Promise<string> }): Promise<string> {
  const text = await response.text()
  try {
    const json = JSON.parse(text) as { error?: string; text?: string }
    return json.error || json.text || `${response.status} ${text}`
  } catch {
    return `${response.status} ${text}`
  }
}

async function postRelay<T>({ relay, path, body }: { relay: RelayTarget; path: string; body: unknown }): Promise<T> {
  const response = await fetch(`${getServerUrl(relay.host)}${path}`, {
    method: 'POST',
    headers: buildAuthHeaders({ token: relay.token, json: true }),
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(await readRelayError(response))
  }
  return (await response.json()) as T
}

export async function fetchExtensionsStatus(relay: RelayTarget): Promise<ExtensionStatus[]> {
  const serverUrl = getServerUrl(relay.host)
  const headers = buildAuthHeaders({ token: relay.token })
  try {
    const response = await fetch(`${serverUrl}/extensions/status`, {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      headers,
    })
    if (response.ok) {
      const data = (await response.json()) as { extensions: ExtensionStatus[] }
      return data?.extensions || []
    }
    // Old relays only have the single-extension endpoint
    const fallback = await fetch(`${serverUrl}/extension/status`, {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      headers,
    })
    if (!fallback.ok) {
      return []
    }
    const data = (await fallback.json()) as {
      connected: boolean
      activeTargets: number
      browser: string | null
      profile: { email: string; id: string } | null
      playwriterVersion?: string | null
    }
    if (!data?.connected) {
      return []
    }
    return [
      {
        extensionId: 'default',
        stableKey: undefined,
        browser: data.browser,
        profile: data.profile,
        activeTargets: data.activeTargets,
        playwriterVersion: data.playwriterVersion || null,
      },
    ]
  } catch {
    return []
  }
}

// ============================================================================
// Browser discovery
// ============================================================================

/** A browser a session can be created on, listed by `session list` and by the MCP `session_list` tool. */
export interface BrowserOption {
  key: string
  type: 'extension' | 'direct' | 'headless'
  browser: string
  profile: string
  /** User-supplied local label, if present. */
  /** Name observed in Chrome through the local profile probe. */
  profileName?: string
  /** Extension entries. null means the relay's only (legacy) extension */
  extensionId?: string | null
  /** Extension entries: the relay's id for the current extension connection. Changes on every reconnect. */
  connectionId?: string
  /** Direct CDP entries */
  wsUrl?: string
  profiles?: Array<{ name: string; email: string }>
}

function extensionToBrowserOption(extension: ExtensionStatus, names: Record<string, string> = {}): BrowserOption {
  const name = extension.stableKey ? names[extension.stableKey] : undefined
  return {
    key: extension.stableKey || extension.extensionId,
    type: 'extension',
    browser: extension.browser || 'Chrome',
    profile: name || '(profile unknown)',
    profileName: name,
    extensionId: extension.extensionId === 'default' ? null : extension.stableKey || extension.extensionId,
    connectionId: extension.stableKey && extension.extensionId !== 'default' ? extension.extensionId : undefined,
  }
}

/** Probe a profile name and remember which extension connection it was verified on. */
function identifyAndRemember(options: BrowserOption[], relay: RelayTarget): (key: string) => Promise<string | null> {
  return async (key) => {
    const { identifyLocalChromeProfile } = await import('./profile-identify.js')
    const name = await identifyLocalChromeProfile(key, relay)
    const connectionId = options.find((option) => option.key === key)?.connectionId
    if (name && connectionId) {
      try {
        saveVerifiedConnection(key, connectionId)
      } catch {
        // Without the record the next selection by name probes again.
      }
    }
    return name
  }
}

export function formatInstanceProfiles(instance: DiscoveredInstance): string {
  if (instance.profiles.length === 0) {
    return '(unknown)'
  }
  return instance.profiles
    .map((p) => {
      return p.email ? `${p.name} (${p.email})` : p.name
    })
    .join(', ')
}

function instanceToBrowserOption(instance: DiscoveredInstance): BrowserOption {
  return {
    key: `direct:${instance.port}`,
    type: 'direct',
    browser: instance.browser,
    profile: formatInstanceProfiles(instance),
    wsUrl: instance.wsUrl,
    profiles: instance.profiles,
  }
}

/** Local extensions connected to the relay. Locally it starts the relay and waits up to waitMs for an extension. */
async function getConnectedExtensions({
  relay,
  waitMs,
  logger,
}: {
  relay: RelayTarget
  waitMs: number
  logger?: { log: (...args: any[]) => void }
}): Promise<ExtensionStatus[]> {
  if (!isLocalRelay(relay)) {
    return getLocalExtensionStatuses(await fetchExtensionsStatus(relay))
  }
  await ensureRelayServer({ logger })
  return waitForConnectedExtensions({ timeoutMs: waitMs, pollIntervalMs: EXTENSION_POLL_MS, logger })
}

/** Headless sessions need a Chrome binary on this machine. */
async function getHeadlessOption(): Promise<BrowserOption[]> {
  try {
    const { resolveBrowserExecutablePath } = await import('./browser-config.js')
    resolveBrowserExecutablePath()
    return [{ key: 'headless', type: 'headless', browser: 'Chrome (Headless)', profile: '-' }]
  } catch {
    return []
  }
}

/**
 * Every browser a new session can use: extensions, local Chrome instances with
 * debugging enabled (local relay only), and headless Chrome.
 */
export async function discoverBrowserOptions({
  relay,
  extensionWaitMs,
  logger,
  identifyProfiles = true,
}: {
  relay: RelayTarget
  /** How long to wait for an extension to connect to a local relay */
  extensionWaitMs: number
  logger?: { log: (...args: any[]) => void }
  identifyProfiles?: boolean
}): Promise<{ options: BrowserOption[]; warnings: string[] }> {
  const warnings: string[] = []
  const [extensions, instances, headless] = await Promise.all([
    getConnectedExtensions({ relay, waitMs: extensionWaitMs, logger }),
    isLocalRelay(relay) ? discoverChromeInstances() : Promise.resolve([]),
    getHeadlessOption(),
  ])
  const names = isLocalRelay(relay) ? readLocalProfileNames() : {}
  const options = [
    ...extensions.map((extension) => extensionToBrowserOption(extension, names)),
    ...instances.map(instanceToBrowserOption),
    ...headless,
  ]
  if (identifyProfiles && isLocalRelay(relay) && process.platform === 'darwin') {
    const { identifyUnknownProfiles } = await import('./profile-auto-identify.js')
    await identifyUnknownProfiles(options, identifyAndRemember(options, relay))
  }
  return { options, warnings }
}

export function formatBrowserTable(options: BrowserOption[]): string {
  const typeLabels = options.map((opt) => {
    return opt.type === 'direct' ? '--direct' : opt.type
  })
  const keyWidth = Math.max(3, ...options.map((opt) => opt.key.length))
  const typeWidth = Math.max(4, ...typeLabels.map((t) => t.length))
  const browserWidth = Math.max(7, ...options.map((opt) => opt.browser.length))
  const header = 'KEY'.padEnd(keyWidth) + '  ' + 'TYPE'.padEnd(typeWidth) + '  ' + 'BROWSER'.padEnd(browserWidth) + '  PROFILE'
  const rows = options.map((opt, i) => {
    return opt.key.padEnd(keyWidth) + '  ' + typeLabels[i].padEnd(typeWidth) + '  ' + opt.browser.padEnd(browserWidth) + '  ' + opt.profile
  })
  return [header, '-'.repeat(keyWidth + typeWidth + browserWidth + 20), ...rows].join('\n')
}

export type SessionMode = 'extension' | 'headless' | 'direct' | 'remote'

export type CreatedSession = {
  id: string
  mode: SessionMode
  /** Short description for "Session N created (label)". Empty for plain extension sessions */
  label: string
  /** Extra lines worth showing the agent, like remote control caveats */
  notes: string[]
}

export type NewSessionResult =
  | { kind: 'created'; session: CreatedSession; warnings: string[] }
  /** Several browsers match: the caller must pick one by key and create the session again */
  | { kind: 'choose'; message: string; options: BrowserOption[]; warnings: string[] }

export type NewSessionOptions = {
  relay: RelayTarget
  cwd: string
  client: SessionClient
  /** Browser key, a verified local Chrome profile name on macOS, or "headless". */
  browser?: string
  /** Direct CDP: '' auto-discovers Chrome with debugging on, else a ws:// URL or host:port */
  direct?: string
  /** Remote control id another user shared with the extension `Remote control` button */
  remote?: string
  tabGroup?: string
  tabGroupColor?: TabGroupColor
  patchright?: boolean
  logger?: { log: (...args: any[]) => void }
}

type RelaySessionResponse = {
  id: string
  warning?: string | null
  /** Echoed by relays that support tab groups */
  tabGroup?: string | null
}

/**
 * Create a relay session the same way for the CLI `session new` and the MCP
 * `session_new` tool. Selection order: remote, headless, direct, then the
 * browser key or verified Chrome profile name, then the only connected extension.
 */
export async function newSession(options: NewSessionOptions): Promise<NewSessionResult> {
  const { relay, cwd, client, browser, direct, remote, tabGroup, tabGroupColor, patchright, logger } = options
  const warnings: string[] = []
  const local = isLocalRelay(relay)

  // Old relays and the CLI path omit client; the relay counts it as cli.
  const clientField = client === 'mcp' ? { client } : {}

  const warnExtensionOnly = (mode: string) => {
    if (tabGroup || tabGroupColor || patchright) {
      warnings.push(`tab group and patchright options only apply to extension and remote sessions, ignored for ${mode}.`)
    }
  }
  const collect = (result: RelaySessionResponse, { tabGroupRequested }: { tabGroupRequested: boolean }) => {
    if (result.warning) {
      warnings.push(result.warning)
    }
    if (tabGroupRequested && result.tabGroup === undefined) {
      warnings.push('The running relay does not support tab groups. Restart it after updating playwriter.')
    }
  }
  const created = (session: Omit<CreatedSession, 'notes'> & { notes?: string[] }): NewSessionResult => {
    return { kind: 'created', session: { notes: [], ...session }, warnings }
  }

  const createDirect = async ({ cdpEndpoint, label, instance }: { cdpEndpoint: string; label: string; instance?: { browser: string; profiles: Array<{ name: string; email: string }> } }) => {
    const result = await postRelay<RelaySessionResponse>({
      relay,
      path: '/cli/session/new',
      body: { cdpEndpoint, cwd, browser: instance?.browser, profiles: instance?.profiles, ...clientField },
    })
    collect(result, { tabGroupRequested: false })
    return created({ id: result.id, mode: 'direct', label })
  }

  const createExtension = async (extensionId: string | null) => {
    const result = await postRelay<RelaySessionResponse>({
      relay,
      path: '/cli/session/new',
      body: { extensionId, cwd, tabGroup, tabGroupColor, patchright: patchright || undefined, ...clientField },
    })
    collect(result, { tabGroupRequested: Boolean(tabGroup || tabGroupColor) })
    return created({ id: result.id, mode: 'extension', label: '' })
  }

  const createHeadless = async () => {
    warnExtensionOnly('headless sessions')
    await ensureLocalRelay({ relay, logger })
    const result = await postRelay<RelaySessionResponse>({
      relay,
      path: '/cli/session/new',
      body: { headless: true, cwd, ...clientField },
    }).catch((error: Error) => {
      throw error.message.includes('Could not find a supported browser binary') ? new Error(NO_CHROME_ERROR) : error
    })
    collect(result, { tabGroupRequested: false })
    return created({ id: result.id, mode: 'headless', label: 'headless' })
  }

  const createFromOption = async (option: BrowserOption) => {
    if (option.type === 'headless') {
      return createHeadless()
    }
    if (option.type === 'direct') {
      warnExtensionOnly('direct CDP sessions')
      return createDirect({ cdpEndpoint: option.wsUrl!, label: `direct CDP, ${option.browser} ${option.profile}`, instance: { browser: option.browser, profiles: option.profiles || [] } })
    }
    return createExtension(option.extensionId ?? null)
  }

  if (remote) {
    await ensureLocalRelay({ relay, logger })
    const result = await postRelay<RelaySessionResponse>({
      relay,
      path: '/cli/session/new',
      body: { remoteControlUrl: remote, cwd, tabGroup, tabGroupColor, patchright: patchright || undefined, ...clientField },
    })
    collect(result, { tabGroupRequested: Boolean(tabGroup || tabGroupColor) })
    return created({
      id: result.id,
      mode: 'remote',
      label: 'remote browser',
      notes: [
        'context.pages()[0] is the tab where the user started sharing. Remote control is not a security sandbox.',
        'The user can revoke access anytime with Stop sharing on the Remote ON dropdown.',
      ],
    })
  }

  if (browser === 'headless') {
    return createHeadless()
  }

  if (direct) {
    warnExtensionOnly('direct CDP sessions')
    const cdpEndpoint = await resolveDirectInput(direct)
    await ensureLocalRelay({ relay, logger })
    return createDirect({ cdpEndpoint, label: 'direct CDP' })
  }

  if (direct === '') {
    warnExtensionOnly('direct CDP sessions')
    if (!local) {
      throw new Error(dedent`
        Direct CDP auto-discovery only works with a local relay.
        For a remote relay, pass an explicit endpoint reachable from the relay host, like ws://relay-host:9222/devtools/browser/...
      `)
    }
    await ensureLocalRelay({ relay, logger })
    logger?.log(pc.dim('Discovering Chrome instances with debugging enabled...'))
    const directOptions = (await discoverChromeInstances()).map(instanceToBrowserOption)
    if (directOptions.length === 0) {
      throw new Error(dedent`
        No Chrome instances with debugging enabled found.
        Enable debugging in one of these ways:
          1. Open chrome://inspect/#remote-debugging in Chrome
          2. Launch Chrome with: chrome --remote-debugging-port=9222
      `)
    }
    if (browser) {
      const { selectBrowserOption } = await import('./profile-auto-identify.js')
      return createFromOption(await selectBrowserOption({ key: browser, options: directOptions }))
    }
    if (directOptions.length === 1) {
      return createFromOption(directOptions[0])
    }
    return { kind: 'choose', message: 'Multiple Chrome instances with debugging enabled:', options: directOptions, warnings }
  }

  const extensions = await getConnectedExtensions({ relay, waitMs: SESSION_EXTENSION_WAIT_MS, logger })
  for (const extension of extensions) {
    const outdated = getExtensionOutdatedWarning(extension.playwriterVersion)
    if (outdated) {
      warnings.push(outdated)
      break
    }
  }

  // One extension and no explicit pick: skip the slower direct discovery
  if (extensions.length === 1 && !browser) {
    const option = extensionToBrowserOption(extensions[0], local ? readLocalProfileNames() : {})
    if (local && process.platform === 'darwin' && option.key.startsWith('install:Chrome:') && !option.profileName) {
      const { identifyUnknownProfiles } = await import('./profile-auto-identify.js')
      await identifyUnknownProfiles([option], identifyAndRemember([option], relay))
    }
    return createFromOption(option)
  }

  const names = local ? readLocalProfileNames() : {}
  const extensionOptions = extensions.map((extension) => extensionToBrowserOption(extension, names))
  // Profile probes use this explicit-key path to avoid another lookup.
  const selectedExtension = extensionOptions.find((option) => option.key === browser)
  if (selectedExtension) return createFromOption(selectedExtension)

  const discoverDirect = local && (browser ? browser.startsWith('direct:') : extensions.length > 0)
  if (discoverDirect) {
    logger?.log(pc.dim('Discovering additional browsers...'))
  }
  const directOptions = discoverDirect ? (await discoverChromeInstances()).map(instanceToBrowserOption) : []
  const allOptions = [...extensionOptions, ...directOptions]

  if (browser) {
    if (/^cloud(?:-\d+)?$/.test(browser)) {
      throw new Error('Managed browsers are provisioned by your provider. Connect with --direct <CDP URL>.')
    }
    const { selectBrowserOption } = await import('./profile-auto-identify.js')
    const identifyProfile = local && process.platform === 'darwin' && !browser.startsWith('direct:')
    const identify = identifyProfile ? identifyAndRemember(allOptions, relay) : undefined
    const verifiedConnections = identifyProfile ? readVerifiedConnections() : undefined
    return createFromOption(await selectBrowserOption({ key: browser, options: allOptions, identify, verifiedConnections }))
  }
  if (allOptions.length === 0) {
    throw new ExtensionNotConnectedError()
  }
  if (local && process.platform === 'darwin') {
    const { identifyUnknownProfiles } = await import('./profile-auto-identify.js')
    await identifyUnknownProfiles(allOptions, identifyAndRemember(allOptions, relay))
  }
  return { kind: 'choose', message: 'Multiple browsers detected:', options: allOptions, warnings }
}

// ============================================================================
// Existing sessions
// ============================================================================

export type RelaySessionInfo = {
  id: string
  idleMs?: number
  tabs?: number | null
  tabUrls?: string[]
  stateKeys: string[]
  browser: string | null
  profile: { email: string; id: string; label?: string } | null
  profileName?: string
  extensionId: string | null
  cwd: string | null
  tabGroup?: string | null
  tabGroupColor?: string | null
  patchright?: boolean
}

export async function listSessions(relay: RelayTarget, { includeTabs = false } = {}): Promise<RelaySessionInfo[]> {
  const response = await fetch(`${getServerUrl(relay.host)}/cli/sessions${includeTabs ? '?tabs=1' : ''}`, {
    headers: buildAuthHeaders({ token: relay.token }),
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(await readRelayError(response))
  }
  const result = (await response.json()) as { sessions: RelaySessionInfo[] }
  const names = isLocalRelay(relay) ? readLocalProfileNames() : {}
  return result.sessions.map((session) => ({
    ...session,
    profileName: session.extensionId ? names[session.extensionId] : undefined,
  }))
}

export async function pruneSessions({
  relay, idleMs, closeCreatedTabs, releaseCreatedTabs,
}: {
  relay: RelayTarget
  idleMs: number
  closeCreatedTabs?: boolean
  releaseCreatedTabs?: boolean
}): Promise<Array<{ sessionId: string; warning?: string }>> {
  const response = await fetch(`${getServerUrl(relay.host)}/cli/session/prune`, {
    method: 'POST',
    headers: buildAuthHeaders({ token: relay.token, json: true }),
    body: JSON.stringify({ idleMs, closeCreatedTabs, releaseCreatedTabs }),
  })
  if (response.status === 404) throw new Error('Update the relay to use session prune.')
  if (!response.ok) throw new Error(await readRelayError(response))
  const result = (await response.json()) as { deleted: Array<{ sessionId: string; warning?: string }> }
  return result.deleted
}

export type UpdateSessionResult = {
  patchright?: boolean
  /** The driver changed, so the session reconnected and its state was cleared */
  reconnected?: boolean
  tabGroup?: string
  tabGroupColor?: string
  movedTabs?: number
  warning?: string
}

export async function updateSession({
  relay,
  sessionId,
  tabGroup,
  tabGroupColor,
  patchright,
}: {
  relay: RelayTarget
  sessionId: string
  tabGroup?: string
  tabGroupColor?: TabGroupColor
  patchright?: boolean
}): Promise<UpdateSessionResult> {
  const response = await fetch(`${getServerUrl(relay.host)}/cli/session/update`, {
    method: 'POST',
    headers: buildAuthHeaders({ token: relay.token, json: true }),
    body: JSON.stringify({ sessionId, tabGroup, tabGroupColor, patchright }),
  })
  if (!response.ok) {
    const text = await response.text()
    const error = (() => {
      try {
        return (JSON.parse(text) as { error?: string }).error
      } catch {
        return undefined
      }
    })()
    if (response.status === 404 && !error) {
      throw new Error('The running relay does not support session update. Restart it after updating playwriter.')
    }
    throw new Error(error || `${response.status} ${text}`)
  }
  const result = (await response.json()) as UpdateSessionResult
  if (patchright !== undefined && result.patchright === undefined) {
    throw new Error('The running relay does not support switching patchright. Restart it after updating playwriter.')
  }
  return result
}

export async function deleteSession({
  relay,
  sessionId,
  closeCreatedTabs,
  releaseCreatedTabs,
}: {
  relay: RelayTarget
  sessionId: string
  /** Also close the tabs this session opened. Other sessions' and user-enabled tabs stay open */
  closeCreatedTabs?: boolean
  /** Detach and ungroup this session's tabs while keeping them open */
  releaseCreatedTabs?: boolean
}): Promise<{ warning?: string }> {
  return postRelay<{ warning?: string }>({
    relay,
    path: '/cli/session/delete',
    body: { sessionId, closeCreatedTabs: closeCreatedTabs || undefined, releaseCreatedTabs: releaseCreatedTabs || undefined },
  })
}

export async function resetSession({ relay, sessionId, cwd }: { relay: RelayTarget; sessionId: string; cwd: string }): Promise<{ pagesCount: number }> {
  return postRelay<{ pagesCount: number }>({ relay, path: '/cli/reset', body: { sessionId, cwd } })
}

export type ReportedExecutionStatus = import('./execution-runs.js').ExecutionStatus | { executionId: string; state: 'unknown' }

export type ExecuteResponse = {
  /** HTTP status. 404: the session does not exist (it ended or the relay restarted) */
  status: number
  text: string
  images: Array<{ data: string; mimeType: string }>
  screenshots: Array<{ path: string; base64: string; snapshot: string; labelCount: number }>
  isError: boolean
  execution?: import('./execution-runs.js').ExecutionStatus
}

export async function getExecutionStatus({
  relay,
  sessionId,
  executionId,
  signal,
}: {
  relay: RelayTarget
  sessionId: string
  executionId: string
  signal?: AbortSignal
}): Promise<ReportedExecutionStatus> {
  const response = await fetch(
    `${getServerUrl(relay.host)}/cli/execute/status/${encodeURIComponent(sessionId)}/${encodeURIComponent(executionId)}`,
    { headers: buildAuthHeaders({ token: relay.token }), signal },
  )
  if (response.status === 404) throw new Error('This relay does not support execution status. Update the relay.')
  if (!response.ok) throw new Error(await readRelayError(response))
  return await response.json() as ReportedExecutionStatus
}

export async function getExecutionRelayInstance({
  relay,
  signal,
}: {
  relay: RelayTarget
  signal?: AbortSignal
}): Promise<string> {
  const response = await fetch(`${getServerUrl(relay.host)}/version`, {
    headers: buildAuthHeaders({ token: relay.token }),
    signal,
  })
  if (!response.ok) throw new Error(await readRelayError(response))
  const { instanceId } = await response.json() as { instanceId?: string }
  if (!instanceId) throw new Error('This relay cannot create identified executions. Update the relay.')
  return instanceId
}

/**
 * Run code in a relay session. Aborting `signal` disconnects, and the relay then
 * aborts the execute and releases the session.
 */
export async function executeInSession({
  relay,
  sessionId,
  code,
  timeout,
  cwd,
  signal,
  executionId,
  requireExecutionId = false,
}: {
  relay: RelayTarget
  sessionId: string
  code: string
  timeout: number
  cwd: string
  signal: AbortSignal
  executionId?: string
  requireExecutionId?: boolean
}): Promise<ExecuteResponse> {
  const endpoint = requireExecutionId ? '/cli/execute/identified' : '/cli/execute'
  const { fetch: undiciFetch, dispatcher: executeDispatcher } = await getExecuteClient()
  const response = await undiciFetch(`${getServerUrl(relay.host)}${endpoint}`, {
    method: 'POST',
    headers: buildAuthHeaders({ token: relay.token, json: true }),
    body: JSON.stringify({ sessionId, code, timeout, cwd, executionId }),
    dispatcher: executeDispatcher,
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout + EXECUTE_RESPONSE_GRACE_MS)]),
  })
  if (!response.ok) {
    // 503 while the relay drains for an upgrade and 404 for a lost session carry a readable text
    const unsupported = requireExecutionId && response.status === 404 && !response.headers.get('content-type')?.startsWith('application/json')
    return {
      status: unsupported ? 501 : response.status,
      text: unsupported ? 'This relay does not support identified executions. Update the relay.' : await readRelayError(response),
      images: [],
      screenshots: [],
      isError: true,
    }
  }
  const result = (await response.json()) as Omit<ExecuteResponse, 'status'>
  return { ...result, status: response.status }
}
