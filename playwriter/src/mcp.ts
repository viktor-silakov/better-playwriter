import { readEnv } from './runtime-config.js'
/**
 * MCP server. A thin client of the relay /cli/* API, like the CLI: code runs in
 * relay sessions, so MCP sessions get session-owned tabs, focus only while an
 * execute runs, drain on relay upgrades, `session list` and the recorder.
 *
 * `execute` without `session` uses this MCP's default session. It is created
 * on first use when only one browser is connected; otherwise the agent picks
 * one with `session_list` and `session_new`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createExecutionId, getExecutionRelayId, isExecutionId } from './execution-runs.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dedent from 'string-dedent'
import { LOG_FILE_PATH, VERSION, parseRelayHost } from './utils.js'
import { PRODUCT_NAME } from './brand.js'
import { getInstalledPlaywriterPackageDir } from './package-paths.js'
import { ensureRelayServer, RELAY_PORT } from './relay-client.js'
import { boundExecuteOutput } from './executor.js'
import { installProcessGuard } from './process-guard.js'
import { TAB_GROUP_ALL_COLORS, normalizeTabGroupColor, type TabGroupColor } from './protocol.js'
import {
  deleteSession,
  discoverBrowserOptions,
  executeInSession,
  formatBrowserTable,
  getExecutionRelayInstance,
  getExecutionStatus,
  isLocalRelay,
  listSessions,
  pruneSessions,
  newSession,
  resetSession,
  updateSession,
  type NewSessionOptions,
  type RelayTarget,
} from './relay-sessions.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEFAULT_EXEC_TIMEOUT = Number(readEnv('EXEC_TIMEOUT')) || 10000
const LOG_TIMEOUT_MS = 1000
const REMOTE_CHECK_TIMEOUT_MS = 3000
const SESSION_LIST_EXTENSION_WAIT_MS = 2000
const CLEANUP_TIMEOUT_MS = 3000
const HTTP_NOT_FOUND = 404
const HTTP_SERVICE_UNAVAILABLE = 503

const REMOVED_DIRECT_ENV_ERROR = dedent`
  BETTER_PLAYWRITER_DIRECT is no longer supported by the Better Playwriter MCP. Remove it from the MCP config.
  The agent connects to Chrome over CDP with the session_new tool instead: direct "auto" or a ws:// URL.
`

// BETTER_PLAYWRITER_HOST and BETTER_PLAYWRITER_TOKEN are the remote relay. startMcp sets them from --host and --token.
const relay: RelayTarget = {}

/** Session used by execute and reset calls without `session`. Set by the first execute or by session_new */
let defaultSessionId: string | null = null
let pendingDefaultSession: Promise<string> | null = null
/** Sessions this MCP created. Deleted when the MCP exits, so their tabs become shared again */
const createdSessionIds = new Set<string>()
/** Creations still waiting for the relay. Exit waits for them, so their sessions get deleted too */
const pendingCreations = new Set<Promise<unknown>>()
let exiting = false

function getLogServerUrl(): string {
  const host = readEnv('HOST')
  if (host) {
    return `${parseRelayHost(host, RELAY_PORT).httpBaseUrl}/mcp-log`
  }
  return `http://127.0.0.1:${RELAY_PORT}/mcp-log`
}

async function sendLogToRelayServer(level: string, ...args: any[]) {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const token = readEnv('TOKEN')
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    await fetch(getLogServerUrl(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ level, args }),
      signal: AbortSignal.timeout(LOG_TIMEOUT_MS),
    })
  } catch {
    // Silently fail if relay server is not available
  }
}

/** Logs to stderr (stdout is the MCP protocol) and to the relay log file. Fire-and-forget. */
const mcpLogger = {
  log: (...args: any[]) => {
    console.error(...args)
    void sendLogToRelayServer('log', ...args)
  },
  error: (...args: any[]) => {
    console.error(...args)
    void sendLogToRelayServer('error', ...args)
  },
}

/** Called before every tool, so a crashed or upgraded local relay comes back. */
async function ensureLocalRelay(): Promise<void> {
  if (isLocalRelay(relay)) {
    await ensureRelayServer({ logger: mcpLogger })
  }
}

async function checkRemoteServer(host: string): Promise<void> {
  const { httpBaseUrl } = parseRelayHost(host, RELAY_PORT)
  const token = readEnv('TOKEN')
  try {
    const response = await fetch(`${httpBaseUrl}/version`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(REMOTE_CHECK_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`Server responded with status ${response.status}`)
    }
  } catch (error: any) {
    const isConnectionError = error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError'
    if (isConnectionError) {
      throw new Error(
        `Cannot connect to remote relay server at ${host}. Make sure 'npx -y better-playwriter serve' is running on the host machine.`,
      )
    }
    throw new Error(`Failed to connect to remote relay server: ${error.message}`)
  }
}

type ToolContent = Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>

function textResult({ text, isError = false }: { text: string; isError?: boolean }): { content: ToolContent; isError?: boolean } {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] }
}

function errorResult(error: unknown) {
  return textResult({ text: error instanceof Error ? error.message : String(error), isError: true })
}

/**
 * Create a session for this MCP. A "choose" result (several browsers) becomes
 * an error listing the keys, so the agent can call session_new with one.
 */
async function createSession(options: Omit<NewSessionOptions, 'relay' | 'cwd' | 'client' | 'logger'>) {
  if (exiting) {
    throw new Error('The Better Playwriter MCP is shutting down.')
  }
  // Registered inside the tracked promise, so exit cleanup sees the id once the creation settles
  const creation = newSession({ ...options, relay, cwd: process.cwd(), client: 'mcp', logger: mcpLogger }).then((result) => {
    if (result.kind === 'created') {
      createdSessionIds.add(result.session.id)
    }
    return result
  })
  pendingCreations.add(creation)
  const result = await creation.finally(() => pendingCreations.delete(creation))
  if (result.kind === 'choose') {
    const warnings = result.warnings.map((warning) => `Warning: ${warning}\n`).join('')
    throw new Error(
      `${warnings}${result.message}\n\n${formatBrowserTable(result.options)}\n\nCall session_new with browser set to one of these keys.`,
    )
  }
  defaultSessionId = result.session.id
  return result
}

/** The given session, or the default one, created on first use. Concurrent first calls share one creation. */
async function resolveSessionId(session: string | undefined): Promise<string> {
  if (session) {
    return session
  }
  if (defaultSessionId) {
    return defaultSessionId
  }
  pendingDefaultSession ??= createSession({})
    .then((result) => {
      mcpLogger.log(`Created default session ${result.session.id}`)
      return result.session.id
    })
    .finally(() => {
      pendingDefaultSession = null
    })
  return pendingDefaultSession
}

/** Forget a session that ended, so the next call without `session` creates a new default one. */
function forgetSession(sessionId: string): void {
  createdSessionIds.delete(sessionId)
  if (defaultSessionId === sessionId) {
    defaultSessionId = null
  }
}

function sessionLostResult({ sessionId, explicit }: { sessionId: string; explicit: boolean }) {
  forgetSession(sessionId)
  const next = explicit
    ? 'Call session_list to see the sessions, or session_new to create one.'
    : 'Call execute again to create a new default session. Its state starts empty; tabs stay open.'
  return textResult({ text: `Session ${sessionId} no longer exists (deleted, or the relay restarted). ${next}`, isError: true })
}

const server = new McpServer({
  name: 'better-playwriter',
  title: 'The better playwright MCP: works as a browser extension. No context bloat. More capable.',
  version: VERSION,
})

for (const name of ['debugger-api', 'editor-api', 'styles-api', 'recording-guide']) {
  const uri = `better-playwriter://resources/${name}.md`
  server.resource(name, uri, { mimeType: 'text/plain' }, async () => {
    const packageDir = getInstalledPlaywriterPackageDir()
    const text = fs.readFileSync(path.join(packageDir, 'dist', `${name}.md`), 'utf-8')
    return { contents: [{ uri, text, mimeType: 'text/plain' }] }
  })
}

const promptContent =
  fs.readFileSync(path.join(__dirname, '..', 'dist', 'prompt.md'), 'utf-8') +
  `\n\nFor ${PRODUCT_NAME} diagnostics, check the relay logs at ${LOG_FILE_PATH}`

const sessionParam = z
  .string()
  .optional()
  .describe('Session id from session_new or session_list. Omit to use the default session')

const tabGroupColorParam = z
  .string()
  .optional()
  .describe(`Tab group color: ${TAB_GROUP_ALL_COLORS.join(', ')}`)

function parseTabGroupColor(value: string | undefined): TabGroupColor | undefined {
  if (value === undefined) {
    return undefined
  }
  const color = normalizeTabGroupColor(value)
  if (!color) {
    throw new Error(`tabGroupColor must be one of: ${TAB_GROUP_ALL_COLORS.join(', ')}`)
  }
  return color
}

server.tool(
  'execute',
  promptContent,
  {
    code: z
      .string()
      .describe(
        'js playwright code, has {state, context} in scope. There is no `page` global: use `state.page = await context.newPage()` or pick an existing tab from `context.pages()`. Should be one line, using ; to execute multiple statements. you MUST call execute multiple times instead of writing complex scripts in a single tool call.',
      ),
    timeout: z
      .number()
      .default(DEFAULT_EXEC_TIMEOUT)
      .describe('Timeout in milliseconds for code execution (default: 10000ms, or BETTER_PLAYWRITER_EXEC_TIMEOUT)'),
    session: sessionParam,
    executionId: z.string().refine((id) => Boolean(getExecutionRelayId(id))).optional().describe('ID created by execute_id to check this run after losing its response'),
  },
  async ({ code, timeout, session, executionId: requestedId }, extra) => {
    const executionId = requestedId ?? createExecutionId()
    let sessionId: string | undefined
    try {
      await ensureLocalRelay()
      sessionId = await resolveSessionId(session)
      const result = await executeInSession({
        relay, sessionId, code, timeout, cwd: process.cwd(), signal: extra.signal, executionId,
        requireExecutionId: requestedId !== undefined,
      })
      if (result.status === HTTP_NOT_FOUND) {
        return sessionLostResult({ sessionId, explicit: Boolean(session) })
      }
      if (result.status === HTTP_SERVICE_UNAVAILABLE) {
        return textResult({ text: 'The Better Playwriter relay is restarting to upgrade. Call session_list once it is ready. Restored local extension sessions keep their ID and tabs. JavaScript state starts empty.', isError: true })
      }
      if (result.status !== 200) {
        return textResult({ text: result.text, isError: true })
      }

      // result.text is already bounded by the relay. Bound only the appended screenshot snapshots.
      const screenshotText = result.screenshots
        .map((s) => {
          return `\nScreenshot saved to: ${s.path} (image included below, ${s.labelCount} labels)\nAccessibility snapshot:\n${s.snapshot}\n`
        })
        .join('')
      const content: ToolContent = [{ type: 'text', text: result.text + boundExecuteOutput({ before: '', after: screenshotText }) }]
      for (const image of result.images) {
        content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
      }
      const structuredContent = result.execution ? { sessionId, ...result.execution } : undefined
      return { content, structuredContent, ...(result.isError ? { isError: true } : {}) }
    } catch (error) {
      mcpLogger.error('Error in execute tool:', error instanceof Error ? error.stack : error)
      if (sessionId) {
        const message = error instanceof Error ? error.message : String(error)
        return textResult({
          text: `${message}\nCheck execute_status with session "${sessionId}" and executionId "${executionId}".`,
          isError: true,
        })
      }
      return errorResult(error)
    }
  },
)

server.tool('execute_id', 'Create an execution ID before starting a run whose status you may need to check later.', {}, async (_, extra) => {
  try {
    const instanceId = await getExecutionRelayInstance({
      relay, signal: AbortSignal.any([extra.signal, AbortSignal.timeout(5000)]),
    })
    const executionId = createExecutionId(instanceId)
    return { ...textResult({ text: executionId }), structuredContent: { executionId } }
  } catch (error) {
    return errorResult(error)
  }
})

server.tool(
  'execute_status',
  'Check an execution by ID. This does not run code. If the result is unknown, inspect the tab before retrying.',
  {
    session: sessionParam,
    executionId: z.string().refine(isExecutionId),
  },
  async ({ session, executionId }, extra) => {
    const sessionId = session ?? defaultSessionId
    if (!sessionId) return textResult({ text: 'Pass the original session ID to check this run.', isError: true })
    try {
      const status = await getExecutionStatus({
        relay, sessionId, executionId, signal: AbortSignal.any([extra.signal, AbortSignal.timeout(5000)]),
      })
      return {
        ...textResult({ text: `Execution ${executionId}: ${status.state}` }),
        structuredContent: { sessionId, ...status },
      }
    } catch (error) {
      return errorResult(error)
    }
  },
)

server.tool(
  'reset',
  dedent`
    Recreates the browser connection of a session. Use this when you get connection errors, assertion failures, or other internal issues.

    It clears all keys from \`state\` and globals you added. Only \`context\`, \`state\` (empty), \`console\`, and utility functions remain. Assign \`state.page\` again after a reset. Tabs stay open.

    if playwright always returns all pages as about:blank urls and evaluate does not work you should ask the user to restart Chrome. This is a known Chrome bug.
  `,
  { session: sessionParam },
  async ({ session }) => {
    try {
      await ensureLocalRelay()
      const sessionId = await resolveSessionId(session)
      const { pagesCount } = await resetSession({ relay, sessionId, cwd: process.cwd() })
      return textResult({ text: `Connection reset successfully. ${pagesCount} page(s) available.` })
    } catch (error) {
      return errorResult(error)
    }
  },
)

server.tool(
  'session_list',
  dedent`
    List the active Better Playwriter sessions and the browsers a new session can use.
    Call it when execute says several browsers are connected, or to pick a browser for session_new.
  `,
  { includeTabs: z.boolean().default(false).describe('Include URLs for tabs owned by each session') },
  async ({ includeTabs }) => {
    try {
      await ensureLocalRelay()
      const [sessions, browsers] = await Promise.all([
        listSessions(relay, { includeTabs }),
        discoverBrowserOptions({ relay, extensionWaitMs: SESSION_LIST_EXTENSION_WAIT_MS, logger: mcpLogger }),
      ])
      const sessionLines = sessions.map((s) => {
        const tags = [
          s.id === defaultSessionId ? 'default' : '',
          createdSessionIds.has(s.id) ? 'yours' : '',
          s.patchright ? 'patchright' : '',
        ].filter(Boolean)
        const group = s.tabGroup ? ` group=${s.tabGroup}` : ''
        const tabs = typeof s.tabs === 'number' ? ` tabs=${s.tabs}` : ''
        const state = s.stateKeys.length > 0 ? ` state=${s.stateKeys.join(',')}` : ''
        const urls = s.tabUrls?.map((url) => '\n  - ' + JSON.stringify(url)).join('') ?? ''
        return `- ${s.id}${tags.length > 0 ? ` (${tags.join(', ')})` : ''}: ${s.browser || 'Chrome'} ${s.profile?.label || s.profile?.email || ''}${group}${tabs}${state}${urls}`
      })
      const warnings = browsers.warnings.map((warning) => `Warning: ${warning}`)
      const browserTable = browsers.options.length > 0 ? formatBrowserTable(browsers.options) : 'No browsers detected. Ask the user to click the Better Playwriter extension icon on a tab.'
      const text = [
        'Sessions:',
        ...(sessionLines.length > 0 ? sessionLines : ['(none)']),
        '',
        'Browsers for session_new (pass KEY as browser):',
        browserTable,
        ...warnings,
      ].join('\n')
      return textResult({ text })
    } catch (error) {
      return errorResult(error)
    }
  },
)

server.tool(
  'session_new',
  dedent`
    Create a session and make it the default for execute and reset calls without \`session\`. Each session has its own \`state\` and sees only the tabs it opens plus tabs the user enabled.
    You only need this to pick a browser, run sessions in parallel, use Patchright, or connect without the extension. Otherwise execute creates a default session on the only connected browser.
    Use patchright: true for production sites where the user is logged in with their own account (email, social, shopping, admin). Never for localhost or the user's own project.
  `,
  {
    browser: z
      .string()
      .optional()
      .describe('Browser KEY from session_list. "headless" launches headless Chrome'),
    direct: z
      .string()
      .optional()
      .describe('Connect over CDP without the extension: "auto" finds Chrome with debugging on, or a ws:// URL or host:port'),
    remote: z.string().optional().describe('Remote control id another user shared with the extension Remote control button'),
    patchright: z.boolean().optional().describe('Patchright with human-like mouse, scroll and typing. Extension and remote sessions only'),
    tabGroup: z.string().optional().describe('Chrome tab group title for this session tabs (default "playwriter")'),
    tabGroupColor: tabGroupColorParam,
  },
  async (params) => {
    try {
      await ensureLocalRelay()
      const { session, warnings } = await createSession({
        ...params,
        direct: params.direct === 'auto' ? '' : params.direct,
        tabGroup: params.tabGroup?.trim() || undefined,
        tabGroupColor: parseTabGroupColor(params.tabGroupColor),
      })
      const label = session.label ? ` (${session.label})` : ''
      const lines = [
        `Session ${session.id} created${label}. It is now the default session.`,
        ...session.notes,
        ...warnings.map((warning) => `Warning: ${warning}`),
      ]
      return textResult({ text: lines.join('\n') })
    } catch (error) {
      return errorResult(error)
    }
  },
)

server.tool(
  'session_update',
  'Switch a session to Patchright and back, or change its tab group. Switching patchright reconnects: tabs stay open, state is cleared.',
  {
    session: sessionParam,
    patchright: z.boolean().optional(),
    tabGroup: z.string().optional().describe('New tab group title. Moves the session tabs'),
    tabGroupColor: tabGroupColorParam,
  },
  async ({ session, patchright, tabGroup, tabGroupColor }) => {
    try {
      await ensureLocalRelay()
      const sessionId = await resolveSessionId(session)
      const result = await updateSession({
        relay,
        sessionId,
        patchright,
        tabGroup: tabGroup?.trim() || undefined,
        tabGroupColor: parseTabGroupColor(tabGroupColor),
      })
      const lines: string[] = []
      if (result.patchright !== undefined) {
        const reconnect = result.reconnected ? ' Reconnected: state was cleared, get pages again from context.pages().' : ''
        lines.push(`Session ${sessionId} now uses ${result.patchright ? 'Patchright' : 'Playwright'}.${reconnect}`)
      }
      if (result.tabGroup) {
        lines.push(`Session ${sessionId} now uses tab group "${result.tabGroup}" (${result.movedTabs ?? 0} tab(s) updated).`)
      }
      if (result.warning) {
        lines.push(`Warning: ${result.warning}`)
      }
      return textResult({ text: lines.join('\n') || `Session ${sessionId} unchanged.` })
    } catch (error) {
      return errorResult(error)
    }
  },
)

server.tool(
  'session_prune',
  'End idle local extension sessions when the user asks to clean them up.',
  {
    idleMinutes: z.number().positive().describe('Minimum idle time in minutes'),
    tabs: z.enum(['keep', 'release', 'close']).default('keep').describe('What to do with tabs created by those sessions'),
  },
  async ({ idleMinutes, tabs }) => {
    try {
      await ensureLocalRelay()
      const deleted = await pruneSessions({
        relay,
        idleMs: Math.round(idleMinutes * 60_000),
        closeCreatedTabs: tabs === 'close',
        releaseCreatedTabs: tabs === 'release',
      })
      for (const { sessionId } of deleted) forgetSession(sessionId)
      return textResult({ text: deleted.length ? deleted.map(({ sessionId, warning }) =>
        `Deleted session ${sessionId}.${warning ? ' ' + warning : ''}`).join('\n') : 'No idle sessions matched.' })
    } catch (error) {
      return errorResult(error)
    }
  },
)

server.tool(
  'session_delete',
  'Delete a session and clear its state. Its tabs stay open and become shared, unless closeTabs is true.',
  {
    session: sessionParam,
    closeTabs: z.boolean().optional().describe('Also close the tabs this session opened'),
  },
  async ({ session, closeTabs }) => {
    try {
      await ensureLocalRelay()
      const sessionId = session || defaultSessionId
      if (!sessionId) {
        return textResult({ text: 'No default session to delete. Pass session.', isError: true })
      }
      const { warning } = await deleteSession({ relay, sessionId, closeCreatedTabs: closeTabs })
      forgetSession(sessionId)
      return textResult({ text: [`Session ${sessionId} deleted.`, ...(warning ? [`Warning: ${warning}`] : [])].join('\n') })
    } catch (error) {
      return errorResult(error)
    }
  },
)

/** Delete the sessions this MCP created, then exit. Runs once on stdin close or a signal. */
async function cleanupAndExit(): Promise<void> {
  if (exiting) {
    return
  }
  exiting = true
  const cleanup = (async () => {
    await Promise.allSettled([...pendingCreations])
    await Promise.allSettled([...createdSessionIds].map((sessionId) => deleteSession({ relay, sessionId })))
  })()
  await Promise.race([cleanup, new Promise((resolve) => setTimeout(resolve, CLEANUP_TIMEOUT_MS))])
  process.exit(0)
}

export async function startMcp(options: { host?: string; token?: string } = {}) {
  installProcessGuard({ logger: mcpLogger })

  if (readEnv('DIRECT')) {
    console.error(REMOVED_DIRECT_ENV_ERROR)
    process.exit(1)
  }
  if (options.host) {
    process.env.BETTER_PLAYWRITER_HOST = options.host
  }
  if (options.token) {
    process.env.BETTER_PLAYWRITER_TOKEN = options.token
  }

  const remoteHost = readEnv('HOST')
  if (remoteHost) {
    mcpLogger.log(`Using remote CDP relay server: ${remoteHost}`)
    await checkRemoteServer(remoteHost)
  } else {
    await ensureLocalRelay()
  }

  process.stdin.on('end', () => void cleanupAndExit())
  process.on('SIGINT', () => void cleanupAndExit())
  process.on('SIGTERM', () => void cleanupAndExit())

  await server.connect(new StdioServerTransport())
}
