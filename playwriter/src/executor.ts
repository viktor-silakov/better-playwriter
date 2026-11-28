import { readEnv, getRelayPort } from './runtime-config.js'
/**
 * PlaywrightExecutor - Manages browser connection and code execution per session.
 * Used by both MCP and CLI to execute Playwright code with persistent state.
 */

import type { Page, Frame, Browser, BrowserContext, Locator, FrameLocator, ElementHandle } from '@xmorse/playwright-core'
import { evaluateIsolated, getChromium } from './playwright-import.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import util from 'node:util'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import * as acorn from 'acorn'
import { createSmartDiff } from './diff-utils.js'
import { getCdpUrl, parseRelayHost, sleep } from './utils.js'
import type { TabGroupColor } from './protocol.js'
import { isRemoteExtensionKey } from './relay-state.js'
import { REMOTE_EXTENSION_NOT_CONNECTED_ERROR } from './remote-control.js'
import { EXTENSION_NOT_CONNECTED_ERROR, getExtensionOutdatedWarning } from './relay-client.js'
import { waitForPageLoad, WaitForPageLoadOptions, WaitForPageLoadResult } from './wait-for-page-load.js'
import { getLatestRequests, getNetworkActivity, observeRequests, type RecentRequestsOptions } from './network-requests.js'
import { ICDPSession, getCDPSessionForPage } from './cdp-session.js'
import { MAX_EXECUTE_OUTPUT_LENGTH, boundExecuteOutput } from './execute-output.js'
import type { Protocol } from './cdp-types.js'
import { Debugger } from './debugger.js'
import { Editor } from './editor.js'
import { getStylesForLocator, formatStylesAsText, type StylesResult } from './styles.js'
import { getReactSource, getReactComponentInfo, type ReactSourceLocation } from './react-source.js'
import { ScopedFS } from './scoped-fs.js'
import { SANDBOX_FILENAME, describeThrown, runAsFaultOwner } from './process-guard.js'
import {
  screenshotWithAccessibilityLabels,
  getAriaSnapshot,
  resolveSnapshotReference,
  resizeImageForAgent,
  type ScreenshotResult,
  type SnapshotFormat,
  type SnapshotMode,
  type SnapshotReference,
  NAVIGATION_RACE_ERROR,
} from './aria-snapshot.js'
export type { SnapshotFormat }
import { getCleanHTML, type GetCleanHTMLOptions } from './clean-html.js'
import { getPageMarkdown, type GetPageMarkdownOptions } from './page-markdown.js'
import { createRecordingApi, type CaptureTargetOptions } from './screen-recording.js'
import type { createStreamApi, StartStreamOptions } from './screen-stream.js'
import { createDemoVideo } from './ffmpeg.js'
import { type GhostCursorClientOptions } from './ghost-cursor.js'
import { GhostCursorController } from './ghost-cursor-controller.js'
import { clearHandoff, handoff, waitForHandoff, type HandoffOptions, type WaitForHandoffOptions } from './handoff.js'
import { challengeWarning, detectChallenge, MAX_CHALLENGE_WAIT_MS, PROBE_TIMEOUT_MS } from './challenge-detection.js'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const require = createRequire(import.meta.url)

/**
 * Check if a path looks like a Windows absolute path (e.g. C:\Users or D:/foo).
 * Works on any platform — uses a regex instead of path.isAbsolute() which is
 * platform-dependent.
 */
export function isWindowsAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(p)
}

/**
 * On POSIX, attempt to translate a Windows absolute path to its WSL mount equivalent.
 * E.g. C:\Users\me\project → /mnt/c/Users/me/project.
 * Returns null if the current platform is Windows (no translation needed),
 * if the path isn't a Windows path, or if the WSL mount point doesn't exist.
 */
export function tryTranslateWindowsPathToWSL(windowsPath: string): string | null {
  if (process.platform === 'win32') {
    return null
  }
  if (!isWindowsAbsolutePath(windowsPath)) {
    return null
  }
  const driveLetter = windowsPath[0].toLowerCase()
  const mountPoint = `/mnt/${driveLetter}`
  if (!fs.existsSync(mountPoint)) {
    return null
  }
  // Strip drive letter + colon, normalize backslashes to forward slashes
  const relativePart = windowsPath.slice(2).replace(/\\/g, '/')
  return path.posix.join(mountPoint, relativePart)
}

/**
 * Resolve a session cwd that may have come from a different OS.
 * Returns { cwd, warning } where cwd is the resolved absolute path (or null
 * if unusable) and warning is a user-facing message if translation was needed
 * or the path was rejected.
 */
export function resolveSessionCwd(rawCwd: string | undefined): { cwd: string | null; warning: string | null } {
  if (!rawCwd) {
    return { cwd: null, warning: null }
  }

  // If the path is already absolute on this platform, use it directly
  if (path.isAbsolute(rawCwd)) {
    return { cwd: path.resolve(rawCwd), warning: null }
  }

  // On POSIX receiving a Windows path: try WSL translation
  if (isWindowsAbsolutePath(rawCwd)) {
    const translated = tryTranslateWindowsPathToWSL(rawCwd)
    if (translated) {
      return {
        cwd: translated,
        warning: `CLI cwd '${rawCwd}' is a Windows path. Translated to WSL mount: ${translated}`,
      }
    }
    return {
      cwd: null,
      warning: `CLI cwd '${rawCwd}' is a Windows path but no WSL mount found at /mnt/${rawCwd[0].toLowerCase()}. Session fs will be scoped to /tmp only.`,
    }
  }

  // Path is relative on this platform and not a Windows path — shouldn't happen
  // in normal usage but guard against mangled paths
  return {
    cwd: null,
    warning: `CLI cwd '${rawCwd}' is not an absolute path on this platform. Session fs will be scoped to /tmp only.`,
  }
}

export class CodeExecutionTimeoutError extends Error {
  constructor(timeout: number) {
    super(
      `Code execution timed out after ${timeout}ms and was aborted: its running and later Playwright calls fail and \`signal\` is aborted. ` +
        `Check the page before retrying.`,
    )
    this.name = 'CodeExecutionTimeoutError'
  }
}

export class ExecuteCancelledError extends Error {
  constructor() {
    super('Code execution was cancelled. Running and later Playwright calls fail. Check the page before retrying.')
    this.name = 'ExecuteCancelledError'
  }
}

const usefulGlobals = {
  URL,
  URLSearchParams,
  fetch,
  Buffer,
  TextEncoder,
  TextDecoder,
  crypto,
  AbortController,
  AbortSignal,
  structuredClone,
  process,
} as const

/**
 * Parse code and check if it's a single expression that should be auto-returned.
 * Returns the exact expression source (without trailing semicolon) using AST
 * node offsets, or null if the code should not be auto-wrapped. See #58.
 */
export function getAutoReturnExpression(code: string): string | null {
  try {
    const ast = acorn.parse(code, {
      ecmaVersion: 'latest',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      sourceType: 'script',
    })

    // Must be exactly one statement
    if (ast.body.length !== 1) {
      return null
    }

    const stmt = ast.body[0]

    // If it's already a return statement, don't auto-wrap
    if (stmt.type === 'ReturnStatement') {
      return null
    }

    // Must be an ExpressionStatement
    if (stmt.type !== 'ExpressionStatement') {
      return null
    }

    // Don't auto-return side-effect expressions
    const expr = stmt.expression
    if (
      expr.type === 'AssignmentExpression' ||
      expr.type === 'UpdateExpression' ||
      (expr.type === 'UnaryExpression' && expr.operator === 'delete')
    ) {
      return null
    }

    // Don't auto-return sequence expressions that contain assignments
    if (expr.type === 'SequenceExpression') {
      const hasAssignment = expr.expressions.some((e) => e.type === 'AssignmentExpression')
      if (hasAssignment) {
        return null
      }
    }

    // Use the expression node's start/end offsets to extract just the expression
    // source, excluding any trailing semicolon. This is more robust than regex.
    return code.slice(expr.start, expr.end)
  } catch {
    // Parse failed, don't auto-return
    return null
  }
}

/** Backward-compatible helper: returns true if code should be auto-wrapped. */
export function shouldAutoReturn(code: string): boolean {
  return getAutoReturnExpression(code) !== null
}

const GET_PAGE_HINT =
  "Get a page from context instead: reuse one with `context.pages().findLast((p) => p.url().includes('example.com'))` (last = most recently opened), or create one with `const page = await context.newPage()`. Store it in `state.page` to reuse it across calls."

export const PAGE_GLOBAL_REMOVED_ERROR = `The global \`page\` was removed. ${GET_PAGE_HINT}`

export function missingPageError(helper: string): Error {
  return new Error(`${helper} requires an explicit page, e.g. ${helper}({ page: state.page }). ${GET_PAGE_HINT}`)
}

function pageFromFrame(
  frame?: { page?: () => Page | null; owner?: () => { page(): Page } },
): Page | undefined {
  if (!frame) return undefined
  if (typeof frame.page === 'function') {
    return frame.page() ?? undefined
  }
  if (typeof frame.owner === 'function') {
    return frame.owner().page()
  }
  return undefined
}

/** The sandbox has no default page: helpers need a page, or a locator/frame that owns one. */
export function resolveSandboxPage(options: {
  helper: string
  page?: Page
  locator?: { page(): Page }
  frame?: { page?: () => Page | null; owner?: () => { page(): Page } }
}): Page {
  const resolved = options.locator?.page() ?? pageFromFrame(options.frame) ?? options.page
  if (!resolved) {
    throw missingPageError(options.helper)
  }
  return resolved
}

/**
 * Wraps user code in an async IIFE for vm execution.
 * Uses AST node offsets to extract the expression without trailing semicolons,
 * avoiding SyntaxError when embedding inside `return await (...)`. See #58.
 */
export function wrapCode(code: string): string {
  const expr = getAutoReturnExpression(code)
  if (expr !== null) {
    return `(async () => { return await (${expr}) })()`
  }
  return `(async () => { ${code} })()`
}

const MAX_LOGS_PER_PAGE = 5000

const ALLOWED_MODULES = new Set([
  'path',
  'node:path',
  'url',
  'node:url',
  'querystring',
  'node:querystring',
  'punycode',
  'node:punycode',
  'crypto',
  'node:crypto',
  'buffer',
  'node:buffer',
  'string_decoder',
  'node:string_decoder',
  'util',
  'node:util',
  'assert',
  'node:assert',
  'events',
  'node:events',
  'timers',
  'node:timers',
  'stream',
  'node:stream',
  'zlib',
  'node:zlib',
  'http',
  'node:http',
  'https',
  'node:https',
  'http2',
  'node:http2',
  'os',
  'node:os',
  'fs',
  'node:fs',
])

export interface ExecuteScreenshot {
  path: string
  base64: string
  mimeType: 'image/png'
  snapshot: string
  labelCount: number
}

export interface ExecuteResult {
  text: string
  images: Array<{ data: string; mimeType: string }>
  screenshots: ExecuteScreenshot[]
  isError: boolean
}

interface OutputEvent {
  id: number
  type: 'warning' | 'page-error'
  message: string
}

interface OutputScope {
  cursor: number
}

interface PageSnapshotReferences {
  byRef: Map<string, SnapshotReference>
  byFrame: Map<Frame, { documentId: string; ids: Map<number, string> }>
}

export interface ExecutorLogger {
  log(...args: any[]): void
  error(...args: any[]): void
}

export interface CdpConfig {
  host?: string
  port?: number
  token?: string
  extensionId?: string | null
  /** Direct CDP WebSocket URL — bypasses relay + extension, connects straight to Chrome */
  directCdpUrl?: string
  /** Launch a headless Chrome via chromium.launch() instead of connecting to an existing one.
   *  Uses direct Playwright browser management, no extension or relay CDP routing needed. */
  headless?: boolean
  /** CLI session id — sent as ?session= on the /cdp URL so the relay can map the client to its session */
  sessionId?: string
  /** Tab group title for this session (extension and remote-control modes) */
  tabGroup?: string
  /** Explicit tab group color (extension and remote-control modes) */
  tabGroupColor?: TabGroupColor
}

export interface SessionMetadata {
  extensionId: string | null
  browser: string | null
  profile: { email: string; id: string; label?: string } | null
}

export interface SessionInfo {
  id: string
  idleMs: number
  stateKeys: string[]
  extensionId: string | null
  browser: string | null
  profile: { email: string; id: string; label?: string } | null
  cwd: string | null
  /** Explicit tab group title, null when the mode supplies its default */
  tabGroup: string | null
  /** Explicit tab group color, null when derived from the title hash */
  tabGroupColor: TabGroupColor | null
  /** Connected with Patchright instead of Playwright */
  patchright: boolean
}

export interface ExecutorOptions {
  cdpConfig: CdpConfig
  sessionMetadata?: SessionMetadata
  logger?: ExecutorLogger
  /** Working directory for scoped fs access */
  cwd?: string
  /** Connect with Patchright instead of Playwright. The relay also humanizes this connection's input. */
  patchright?: boolean
}

function isRegExp(value: any): value is RegExp {
  return (
    typeof value === 'object' && value !== null && typeof value.test === 'function' && typeof value.exec === 'function'
  )
}

// Console argument as text, like DevTools shows it: primitives by value, objects by description.
function describeRemoteObject(arg: Protocol.Runtime.RemoteObject): string {
  if (arg.unserializableValue !== undefined) {
    return arg.unserializableValue
  }
  if (arg.type === 'object' || arg.type === 'function') {
    return arg.subtype === 'null' ? 'null' : (arg.description ?? arg.type)
  }
  return String(arg.value)
}

/**
 * Text for an exception that is a plain object (`throw { code: 42 }`), built from Chrome's preview of its
 * properties. Chrome describes such an object only by its class name, so the page error read "Object".
 */
export function describeThrownObject(exception: Protocol.Runtime.RemoteObject | undefined): string | undefined {
  if (exception?.type !== 'object' || exception.subtype === 'error' || !exception.preview?.properties.length) {
    return undefined
  }
  const properties = exception.preview.properties.map((property) => {
    const value = property.type === 'string' ? JSON.stringify(property.value ?? '') : (property.value ?? property.type)
    return `${property.name}: ${value}`
  })
  if (exception.preview.overflow) {
    properties.push('…')
  }
  return `${exception.description ?? 'Object'} { ${properties.join(', ')} }`
}

/** How long a page error that may be a thrown plain object waits for Chrome's preview of that object. */
const THROWN_OBJECT_PREVIEW_WAIT_MS = 50

function isPromise(value: any): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && typeof value.then === 'function'
}

/**
 * Duck-type check for a Playwright ChannelOwner (Response, Page, Browser,
 * Request, Frame, BrowserContext, etc.). Used to skip auto-printing these
 * objects from the REPL — they're meant for programmatic use, and dumping
 * them risks leaking internal fields. Users can still `console.log(obj)` to
 * inspect them via the safe handler in playwright-core. See issue #82.
 */
export function isPlaywrightChannelOwner(value: any): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value._type === 'string' &&
    typeof value._guid === 'string' &&
    value._connection !== undefined
  )
}

export { MAX_EXECUTE_OUTPUT_LENGTH, boundExecuteOutput }

const INSPECT_OPTIONS: util.InspectOptions = {
  depth: 4,
  colors: false,
  maxArrayLength: 100,
  maxStringLength: 4000,
  breakLength: 80,
}

export function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  const text = util.inspect(value, INSPECT_OPTIONS)
  // util.inspect cuts a long string inside an object and says only how many characters went missing.
  return /\.\.\. \d+ more characters?/.test(text)
    ? `${text}\n[A long string inside this value was cut. Return that string by itself to get all of it.]`
    : text
}

/** Format captured console calls, folding identical consecutive lines into `(xN)`. */
/**
 * Below the default execute timeout, so a missing element fails with its own locator error and call log
 * instead of the generic execute timeout. Slow waits pass an explicit timeout.
 */
export const DEFAULT_ACTION_TIMEOUT_MS = 5000

/** Half of the execute timeout, so a call with a longer timeout also waits longer for slow elements. */
export function actionTimeoutFor(executeTimeout: number): number {
  return Math.min(60000, Math.max(1000, Math.round(executeTimeout / 2)))
}

export function formatConsoleLogs({
  logs,
  title = 'Console output',
}: {
  logs: Array<{ method: string; args: unknown[] }>
  title?: string
}): string {
  if (logs.length === 0) {
    return ''
  }
  const folded: Array<{ line: string; count: number }> = []
  for (const { method, args } of logs) {
    const line = `[${method}] ${args.map(formatValue).join(' ')}`
    const last = folded.at(-1)
    if (last?.line === line) {
      last.count++
    } else {
      folded.push({ line, count: 1 })
    }
  }
  const lines = folded.map(({ line, count }) => (count > 1 ? `${line} (x${count})` : line))
  return `${title}:\n${lines.join('\n')}\n\n`
}


const SNAPSHOT_SEARCH_MAX_MATCHES = 10
const SNAPSHOT_SEARCH_CONTEXT_LINES = 5
const DEFAULT_SNAPSHOT_MAX_CHARS = 4000
const MIN_SNAPSHOT_MAX_CHARS = 100
const SNAPSHOT_NAVIGATION_RETRY_MS = 5000
const SNAPSHOT_SETTLE_WINDOW_MS = 5000
const SNAPSHOT_SETTLE_TIMEOUT_MS = 4000
const SNAPSHOT_SETTLE_QUIET_MS = 500
// A page that is still fetching may be a shell waiting for its data, so its content has to hold still longer.
const SNAPSHOT_SETTLE_STABLE_MS = 750
const SNAPSHOT_SETTLE_POLL_MS = 150
const SNAPSHOT_SCOPE_WAIT_MS = 2000
const SNAPSHOT_SETTLE_APP_START_MS = 2500

/** Whether two looks at a page saw content of about the same size: rows still arriving change it by more. */
export function isSameContentSize(
  before: { text: number; controls: number },
  after: { text: number; controls: number },
): boolean {
  const close = (a: number, b: number, share: number, floor: number) => Math.abs(a - b) <= Math.max(floor, Math.max(a, b) * share)
  return close(before.text, after.text, 0.02, 20) && close(before.controls, after.controls, 0.05, 3)
}

/**
 * A page snapshot stops at the border of an iframe, and embedded apps keep all their content in one
 * (a calendar inside a chat app). Name the visible ones so the agent knows where to look next.
 */
export async function describeChildFrames(page: Page): Promise<string> {
  const main = page.mainFrame()
  const notes = await Promise.all(
    page.frames().map(async (frame, index) => {
      if (frame === main || frame.parentFrame() !== main || frame.isDetached() || !/^https?:/.test(frame.url())) {
        return ''
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const box = await Promise.race([
        frame.frameElement().then((element) => element.boundingBox()),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 1000)
        }),
      ])
        .catch(() => null)
        .finally(() => clearTimeout(timer))
      // Trackers and hidden helper frames are tiny or have no box.
      if (!box || box.width < 200 || box.height < 100) {
        return ''
      }
      const url = frame.url().split(/[?#]/)[0]!.slice(0, 120)
      return `[iframe not included: ${url}. Read it with snapshot({ page, frame: page.frames()[${index}] })]`
    }),
  )
  return notes.filter(Boolean).slice(0, 5).join('\n')
}

/**
 * Bound the rendered tree on whole lines, keeping ancestor paths and giving
 * dialogs and status messages priority over other parts of a large page.
 */
export function limitSnapshotOutput({
  snapshot,
  maxChars,
  condense = true,
}: {
  snapshot: string
  maxChars: number
  /** Off for diffs and search results: their lines are not a tree. */
  condense?: boolean
}): string {
  if (snapshot.length <= maxChars) {
    return snapshot
  }

  const originalLineCount = snapshot.split('\n').length
  // Condensing reads the @ref notation. Legacy locator lines (role=button[name="Save"i]) carry no ref, so
  // a control would look like a plain label and could be dropped.
  const isRefTree = / @e\d+\b/.test(snapshot) && !/^\s*- (?:\[[^\]]*\] )*role=/m.test(snapshot)
  const condensed =
    condense && isRefTree
      ? condenseSnapshotLines(snapshot.split('\n'))
      : { lines: snapshot.split('\n'), disabled: 0, repeated: 0, empty: 0 }
  const lines = condensed.lines
  const dropped = [
    condensed.disabled ? `${condensed.disabled} disabled` : '',
    condensed.repeated ? `${condensed.repeated} repeated` : '',
    condensed.empty ? `${condensed.empty} empty` : '',
  ].filter(Boolean)
  const notice = (omitted: number) => {
    const detail = dropped.length ? ` (${dropped.join(', ')})` : ''
    return `[${omitted} snapshot lines omitted${detail}. Use locator or search to narrow the snapshot.]`
  }
  if (lines.join('\n').length + 1 + notice(originalLineCount).length <= maxChars) {
    return [...lines, notice(originalLineCount - lines.length)].join('\n')
  }
  // Room for the names of the regions that get cut, so the reader knows where to look next.
  const cutRoom = maxChars >= 1000 ? 220 : 0
  let remaining = maxChars - notice(originalLineCount).length - cutRoom
  const parents: number[] = []
  const ancestors: Array<{ index: number; indent: number }> = []
  const priority: number[] = []
  let priorityIndent: number | undefined

  for (const [index, line] of lines.entries()) {
    const body = line.trimStart()
    const indent = line.length - body.length
    while (ancestors.length && ancestors.at(-1)!.indent >= indent) {
      ancestors.pop()
    }
    parents[index] = ancestors.at(-1)?.index ?? -1
    ancestors.push({ index, indent })

    if (priorityIndent !== undefined && indent <= priorityIndent) {
      priorityIndent = undefined
    }
    if (/^- (?:alert|alertdialog|dialog|status|log)\b/i.test(body)) {
      priorityIndent ??= indent
    }
    if (priorityIndent !== undefined) {
      priority.push(index)
    }
  }

  const included = new Set<number>()
  const include = (index: number) => {
    const pending: number[] = []
    let needed = 0
    for (let ancestor = index; ancestor >= 0 && !included.has(ancestor); ancestor = parents[ancestor]!) {
      pending.push(ancestor)
      needed += lines[ancestor]!.length + 1
    }
    if (needed <= remaining) {
      remaining -= needed
      for (const index of pending) {
        included.add(index)
      }
    }
  }
  priority.forEach(include)
  for (const index of lines.keys()) {
    include(index)
  }

  // The largest cut subtrees, by name: "the message list is missing" tells the agent what to scope to.
  const cutSizes = new Map<number, number>()
  for (const index of lines.keys()) {
    if (included.has(index)) {
      continue
    }
    // Count a cut line under its nearest named ancestor: that is the region an agent can scope to.
    let top = parents[index]!
    while (top >= 0 && !SNAPSHOT_LINE.exec(lines[top]!)?.[3] && parents[top]! >= 0) {
      top = parents[top]!
    }
    if (top < 0) {
      top = index
    }
    cutSizes.set(top, (cutSizes.get(top) ?? 0) + 1)
  }
  const cut = [...cutSizes]
    .filter(([, size]) => size >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([index, size]) => {
      const match = SNAPSHOT_LINE.exec(lines[index]!)
      const name = match?.[3] ? ` "${match[3].length > 30 ? `${match[3].slice(0, 30)}…` : match[3]}"` : ''
      return `${match?.[2] ?? 'region'}${name} (${size} lines)`
    })
  const cutNote = cutRoom && cut.length ? `\n[Cut: ${cut.join(', ')}]`.slice(0, cutRoom) : ''
  return [...lines.filter((_, i) => included.has(i)), notice(originalLineCount - included.size)].join('\n') + cutNote
}

const SNAPSHOT_LINE = /^(\s*)- ([^\s"]+)(?: "((?:[^"\\]|\\.)*)")?(.*)$/
const EMPTY_LEAF_ROLES = new Set(['status', 'alert', 'log', 'labeltext'])
const EMPTY_CONTAINER_ROLES = new Set(['group', 'generic', 'toolbar', 'tablist', 'tabpanel', 'list', 'region', 'navigation'])
const UNNAMED_CONTAINER_ROLES = new Set(['row', 'rowgroup', 'grid', 'table', 'listitem'])
const NUMBERED_GRID_ROLES = new Set(['button', 'gridcell', 'link'])
const NUMBERED_GRID_MIN = 15
const MAX_CONDENSED_NAME_CHARS = 120
const REPEATED_CONTROLS_KEPT = 3

/**
 * Make room in a snapshot that does not fit its budget. Large web apps spend most of it on toolbars: disabled
 * buttons, the same per-row button on every row, empty status regions and deep indentation. Only lines without
 * children are dropped, so every kept control still sits under its real ancestors.
 */
export function condenseSnapshotLines(input: string[]): { lines: string[]; disabled: number; repeated: number; empty: number } {
  const counts = { disabled: 0, repeated: 0, empty: 0 }
  type Node = { body: string; role: string; name?: string; rest: string; children: Node[] }

  // Parents come from indentation: the nearest line above with a smaller indent.
  const roots: Node[] = []
  const stack: Array<{ indent: number; node: Node }> = []
  for (const line of input) {
    const body = line.trimStart()
    const indent = line.length - body.length
    const match = SNAPSHOT_LINE.exec(body)
    const node: Node = { body, role: (match?.[2] ?? '').replace(/:$/, ''), name: match?.[3], rest: match?.[4] ?? '', children: [] }
    while (stack.length && stack.at(-1)!.indent >= indent) {
      stack.pop()
    }
    ;(stack.at(-1)?.node.children ?? roots).push(node)
    stack.push({ indent, node })
  }

  const hasRef = (node: Node) => /@\w+/.test(node.rest)
  // Day cells of a date grid ("1, May, 2030") and page-number rows ("7") differ only in their digits.
  // One number inside a longer name ("Order 1042") is content, not a grid.
  const numberedKey = (node: Node) => {
    if (node.name === undefined || !NUMBERED_GRID_ROLES.has(node.role) || !hasRef(node)) {
      return undefined
    }
    const isDateLike = (node.name.match(/\d+/g) ?? []).length >= 2 || /^\d+$/.test(node.name.trim())
    return isDateLike ? `${node.role} ${node.name.replace(/\d+/g, '#')}` : undefined
  }
  const numbered = new Map<string, number>()
  const countNumbered = (nodes: Node[]) => {
    for (const node of nodes) {
      const key = node.children.length === 0 ? numberedKey(node) : undefined
      if (key) numbered.set(key, (numbered.get(key) ?? 0) + 1)
      countNumbered(node.children)
    }
  }
  countNumbered(roots)
  const seen = new Map<string, number>()
  const condense = (nodes: Node[], parent?: Node): Node[] => {
    return nodes.flatMap((node) => {
      // A disabled control cannot be used, and neither can its tooltip text.
      if (/\[disabled\]/.test(node.rest)) {
        counts.disabled++
        return []
      }
      const childrenBefore = node.children.length
      const disabledBefore = counts.disabled
      // A row named by joining the names of its cells says everything twice.
      const [first, second] = node.children
      if (node.name && !hasRef(node) && first?.name && second?.name && node.name.startsWith(first.name) && node.name.includes(second.name)) {
        node.body = node.body.replace(`"${node.name}"`, () => '').replace(/\s+/g, ' ').replace(' :', ':')
        node.name = undefined
      }
      node.children = condense(node.children, node)
      if (node.children.length === 0) {
        const isEmptyRegion = node.name === undefined && EMPTY_LEAF_ROLES.has(node.role) && !hasRef(node)
        // Text that is only an ellipsis or a separator.
        const isEmptyText = node.role === 'text' && node.name !== undefined && !/[\p{L}\p{N}]/u.test(node.name)
        // An icon or label that repeats the name of the control it sits in, or a part of it.
        const repeatsParent = !!node.name && !hasRef(node) && !!parent?.name?.includes(node.name)
        // A group left with nothing in it: unnamed, or a toolbar section whose buttons were all disabled.
        // A named group that never had children is content, such as a chat message.
        const emptiedByDisabled = childrenBefore > 0 && counts.disabled - disabledBefore >= childrenBefore
        const isEmptyContainer =
          !hasRef(node) &&
          (node.name === undefined
            ? EMPTY_CONTAINER_ROLES.has(node.role) || UNNAMED_CONTAINER_ROLES.has(node.role)
            : EMPTY_CONTAINER_ROLES.has(node.role) && emptiedByDisabled)
        if (isEmptyRegion || isEmptyText || repeatsParent || isEmptyContainer) {
          counts.empty++
          return []
        }
        if (node.name !== undefined && hasRef(node)) {
          const gridKey = numberedKey(node)
          const key = gridKey && (numbered.get(gridKey) ?? 0) >= NUMBERED_GRID_MIN ? gridKey : `${node.role} ${node.name}`
          const count = (seen.get(key) ?? 0) + 1
          seen.set(key, count)
          if (count > REPEATED_CONTROLS_KEPT) {
            counts.repeated++
            return []
          }
        }
      }
      // A wrapper that only repeats the name of its single child adds a line and a level.
      const [only] = node.children
      if (node.children.length === 1 && node.name !== undefined && !hasRef(node) && only!.name === node.name) {
        return [only!]
      }
      return [node]
    })
  }

  const lines: string[] = []
  const render = (nodes: Node[], depth: number) => {
    for (const node of nodes) {
      let body = node.body
      if (node.role !== 'text') {
        // Only controls: the name of a paragraph or a message is the content the agent came to read.
        if (hasRef(node) && node.name !== undefined && node.name.length > MAX_CONDENSED_NAME_CHARS) {
          const head = node.name.slice(0, MAX_CONDENSED_NAME_CHARS).replace(/\\$/, '')
          body = body.replace(`"${node.name}"`, () => `"${head}…"`)
        }
        body = body.replace(/:$/, '') + (node.children.length ? ':' : '')
      }
      lines.push('  '.repeat(depth) + body)
      render(node.children, depth + 1)
    }
  }
  render(condense(roots), 0)

  return { lines, ...counts }
}

/** Matching snapshot lines with context. Strings match case-insensitively. */
export function searchSnapshot({ snapshot, search }: { snapshot: string; search: string | RegExp }): string {
  const lines = snapshot.split('\n')
  const needle = typeof search === 'string' ? search.toLowerCase() : ''
  const isMatch = (line: string) => {
    if (typeof search === 'string') {
      return line.toLowerCase().includes(needle)
    }
    // A /g or /y regex keeps lastIndex between test() calls and skips matches
    search.lastIndex = 0
    return search.test(line)
  }
  const matchIndices = lines.flatMap((line, i) => (isMatch(line) ? [i] : []))
  if (matchIndices.length === 0) {
    return 'No matches found'
  }

  const shown = matchIndices.slice(0, SNAPSHOT_SEARCH_MAX_MATCHES)
  const includedLines = new Set<number>()
  for (const idx of shown) {
    const start = Math.max(0, idx - SNAPSHOT_SEARCH_CONTEXT_LINES)
    const end = Math.min(lines.length - 1, idx + SNAPSHOT_SEARCH_CONTEXT_LINES)
    for (let i = start; i <= end; i++) {
      includedLines.add(i)
    }
  }

  const total = matchIndices.length
  const header =
    total > shown.length
      ? `${total} matches (showing ${shown.length}). Use a more specific search to see the rest.`
      : `${total} ${total === 1 ? 'match' : 'matches'}`
  const result: string[] = [header]
  const sortedIndices = [...includedLines].sort((a, b) => a - b)
  for (let i = 0; i < sortedIndices.length; i++) {
    const lineIdx = sortedIndices[i]
    if (i > 0 && sortedIndices[i - 1] !== lineIdx - 1) {
      result.push('---')
    }
    result.push(lines[lineIdx])
  }
  return result.join('\n')
}

export class PlaywrightExecutor {
  private isConnected = false
  private browser: Browser | null = null
  private context: BrowserContext | null = null

  private userState: Record<string, any> = {}
  private browserLogs: Map<Page, string[]> = new Map()
  // Tracks the index up to which getLatestLogs({ sinceLastCall: true }) has
  // returned logs. 0 means "return everything" (first call gets full buffer).
  // When addBrowserLog shifts old entries (cap at MAX_LOGS_PER_PAGE), cursors
  // are decremented so they stay in sync with the array.
  private pageLogCursor: Map<Page, number> = new Map()
  private lastSnapshots: WeakMap<Page, Map<string, string>> = new WeakMap()
  private lastRefToLocator: WeakMap<Page, Map<string, string>> = new WeakMap()
  private snapshotReferences = new WeakMap<Page, PageSnapshotReferences>()
  private nextSnapshotReference = 1
  private lastScreenshotHashes = new WeakMap<Page, Map<string, string>>()
  private pageDocumentGenerations: WeakMap<Page, number> = new WeakMap()
  /** When the main frame of a page last navigated, so a snapshot taken right after can wait for the content. */
  private lastNavigationAt: WeakMap<Page, number> = new WeakMap()
  private outputEvents: OutputEvent[] = []
  private nextOutputEventId = 0
  private lastDeliveredOutputEventId = 0

  // Recording timestamp tracking: when recording is active, each execute()
  // call pushes {start, end} (seconds relative to recordingStartedAt).
  // Returned by the recording handle stop() so the model can speed up idle sections.
  private recordingStartedAt: number | null = null
  private executionTimestamps: Array<{ start: number; end: number }> = []
  private activeOutputScopes = new Set<OutputScope>()
  private pagesWithListeners = new WeakSet<Page>()
  /** Pages whose main frame navigated during the running execute script; null outside of one. */
  private navigatedPages: Set<Page> | null = null
  private suppressPageCloseWarnings = false
  private operationTail: Promise<void> = Promise.resolve()
  /** Queued or running operations. Used with lastActivityAt for idle cleanup. */
  private pendingOperations = 0
  private lastActivityAt = Date.now()
  private disposing = false
  private disposePromise: Promise<void> | null = null
  /** Pending agent timers, cleared on reset and dispose. */
  private sandboxTimers = new Set<ReturnType<typeof setTimeout>>()
  private sandboxTimerGlobals = this.createSandboxTimerGlobals()

  private scopedFs: ScopedFS
  private sandboxedRequire: NodeRequire

  private cdpConfig: CdpConfig
  private logger: ExecutorLogger
  private sessionMetadata: SessionMetadata
  private sessionCwd: string | null
  private hasWarnedExtensionOutdated = false

  private ghostCursorController: GhostCursorController
  private patchright: boolean

  constructor(options: ExecutorOptions) {
    this.cdpConfig = options.cdpConfig
    this.logger = options.logger || { log: console.log, error: console.error }
    this.sessionMetadata = options.sessionMetadata || { extensionId: null, browser: null, profile: null }
    // Resolve cwd with cross-OS awareness (Windows CLI + Linux relay via WSL).
    // resolveSessionCwd handles WSL /mnt/ translation and rejects paths that
    // can't be resolved on the relay's platform to prevent mangled paths like
    // /home/user/C:\Users\... (see issue #107).
    const { cwd: resolvedCwd, warning: cwdWarning } = resolveSessionCwd(options.cwd)
    this.sessionCwd = resolvedCwd
    if (cwdWarning) {
      this.logger.log(`[session cwd] ${cwdWarning}`)
    }
    this.patchright = options.patchright ?? false
    // ScopedFS expects an array of allowed directories. If cwd is provided, use it; otherwise use defaults.
    this.scopedFs = new ScopedFS(
      this.sessionCwd ? [this.sessionCwd, '/tmp', os.tmpdir()] : undefined,
      this.sessionCwd || undefined,
    )
    this.sandboxedRequire = this.createSandboxedRequire(require)
    this.ghostCursorController = new GhostCursorController({
      logger: {
        error: (...args: unknown[]) => {
          this.logger.error(...args)
        },
      },
    })
  }

  /** Host timers for agent code. A throwing callback becomes a warning instead of killing the process. */
  private createSandboxTimerGlobals() {
    const timers = this.sandboxTimers
    const runCallback = ({ kind, callback, args }: { kind: string; callback: Function; args: unknown[] }) => {
      try {
        callback(...args)
      } catch (error) {
        const message = describeThrown(error)
        this.logger.error(`[sandbox] ${kind} callback threw:`, message)
        this.enqueueWarning(`${kind} callback threw: ${message}`)
      }
    }
    const assertFunction = (callback: unknown) => {
      if (typeof callback !== 'function') {
        throw new TypeError('The "callback" argument must be a function')
      }
    }
    const clear = (timer: ReturnType<typeof setTimeout> | undefined) => {
      if (timer) {
        timers.delete(timer)
      }
      clearTimeout(timer)
    }
    return {
      setTimeout: (callback: Function, ms?: number, ...args: unknown[]) => {
        assertFunction(callback)
        const timer = setTimeout(() => {
          timers.delete(timer)
          runCallback({ kind: 'setTimeout', callback, args })
        }, ms)
        timers.add(timer)
        return timer
      },
      setInterval: (callback: Function, ms?: number, ...args: unknown[]) => {
        assertFunction(callback)
        const timer = setInterval(() => {
          runCallback({ kind: 'setInterval', callback, args })
        }, ms)
        timers.add(timer)
        return timer
      },
      clearTimeout: clear,
      clearInterval: clear,
    }
  }

  private clearSandboxTimers() {
    for (const timer of this.sandboxTimers) {
      clearTimeout(timer)
    }
    this.sandboxTimers.clear()
  }

  private createSandboxedRequire(originalRequire: NodeRequire): NodeRequire {
    const scopedFs = this.scopedFs
    const sandboxedRequire = ((id: string) => {
      if (!ALLOWED_MODULES.has(id)) {
        const error = new Error(
          `Module "${id}" is not allowed in the sandbox. ` +
            `Only safe Node.js built-ins are permitted: ${[...ALLOWED_MODULES].filter((m) => !m.startsWith('node:')).join(', ')}`,
        )
        error.name = 'ModuleNotAllowedError'
        throw error
      }
      if (id === 'fs' || id === 'node:fs') {
        return scopedFs
      }
      return originalRequire(id)
    }) as NodeRequire

    sandboxedRequire.resolve = originalRequire.resolve
    sandboxedRequire.cache = originalRequire.cache
    sandboxedRequire.extensions = originalRequire.extensions
    sandboxedRequire.main = originalRequire.main

    return sandboxedRequire
  }

  private async setDeviceScaleFactorForMacOS(context: BrowserContext): Promise<void> {
    if (os.platform() !== 'darwin') {
      return
    }
    const options = (context as any)._options
    if (!options || options.deviceScaleFactor === 2) {
      return
    }
    options.deviceScaleFactor = 2
  }

  private clearExecutionState() {
    this.userState = {}
    this.browserLogs = new Map()
    this.pageLogCursor = new Map()
    this.lastSnapshots = new WeakMap()
    this.lastRefToLocator = new WeakMap()
    this.snapshotReferences = new WeakMap()
    this.lastScreenshotHashes = new WeakMap()
    this.pageDocumentGenerations = new WeakMap()
    this.outputEvents = []
    this.nextOutputEventId = 0
    this.lastDeliveredOutputEventId = 0
    this.activeOutputScopes.clear()
    this.clearSandboxTimers()
  }

  private clearConnectionState() {
    this.isConnected = false
    this.browser = null
    this.context = null
  }

  private runExclusive<T>({
    operation,
    allowDuringDispose = false,
  }: {
    operation: () => Promise<T>
    allowDuringDispose?: boolean
  }): Promise<T> {
    if (this.disposing && !allowDuringDispose) {
      return Promise.reject(new Error('Session is being deleted'))
    }

    this.pendingOperations++
    const run = async () => {
      try {
        return await operation()
      } finally {
        this.pendingOperations--
        this.lastActivityAt = Date.now()
      }
    }
    const result = this.operationTail.then(run, run)
    this.operationTail = result.then(
      () => {},
      () => {},
    )
    return result
  }

  /** Ms since the last operation finished, or 0 while one is queued or running. */
  idleMs(): number {
    return this.pendingOperations > 0 ? 0 : Date.now() - this.lastActivityAt
  }

  enqueueWarning(message: string) {
    this.enqueueOutputEvent({ type: 'warning', message })
  }

  private enqueueOutputEvent(event: Omit<OutputEvent, 'id'>) {
    this.nextOutputEventId += 1
    this.outputEvents.push({ id: this.nextOutputEventId, ...event })
  }

  private beginOutputScope(): OutputScope {
    // Use lastDeliveredOutputEventId as cursor (not nextOutputEventId) so
    // events enqueued between execute() calls are picked up by the next scope.
    // Using nextOutputEventId would skip them.
    const scope: OutputScope = {
      cursor: this.lastDeliveredOutputEventId,
    }
    this.activeOutputScopes.add(scope)
    return scope
  }

  private flushOutputForScope(scope: OutputScope): string {
    const relevantEvents = this.outputEvents.filter((event) => {
      return event.id > scope.cursor
    })
    const latestEventId = relevantEvents.at(-1)?.id
    if (latestEventId && latestEventId > this.lastDeliveredOutputEventId) {
      this.lastDeliveredOutputEventId = latestEventId
    }

    this.activeOutputScopes.delete(scope)
    this.pruneDeliveredOutputEvents()

    if (relevantEvents.length === 0) {
      return ''
    }

    return `${relevantEvents
      .map((event) => `[${event.type === 'warning' ? 'WARNING' : 'PAGE ERROR'}] ${event.message}`)
      .join('\n')}\n`
  }

  private pruneDeliveredOutputEvents() {
    const activeCursors = [...this.activeOutputScopes].map((scope) => {
      return scope.cursor
    })
    const minActiveCursor = activeCursors.length > 0 ? Math.min(...activeCursors) : this.lastDeliveredOutputEventId
    const pruneBeforeOrAt = Math.min(this.lastDeliveredOutputEventId, minActiveCursor)
    this.outputEvents = this.outputEvents.filter((event) => {
      return event.id > pruneBeforeOrAt
    })
  }

  private stateKeysForPage(page: Page): string[] {
    return Object.entries(this.userState)
      .filter(([, value]) => {
        return value === page
      })
      .map(([key]) => key)
  }

  private warnIfExtensionOutdated(playwriterVersion: string | null) {
    if (this.hasWarnedExtensionOutdated) {
      return
    }
    const warning = getExtensionOutdatedWarning(playwriterVersion)
    if (warning) {
      this.logger.log(warning)
      // Enqueue so MCP agents see version-skew messages in their next execute
      // response — logger.log alone only reaches stdout, not the LLM.
      this.enqueueWarning(warning)
      this.hasWarnedExtensionOutdated = true
    }
  }

  private setupPageListeners(page: Page) {
    observeRequests(page)
    if (this.pagesWithListeners.has(page)) {
      return
    }
    this.pagesWithListeners.add(page)
    this.setupPageCloseDetection(page)
    page.on('crash', () => {
      const keys = this.stateKeysForPage(page)
      if (keys.length === 0) {
        return
      }
      const key = `state.${keys[0]}`
      this.enqueueWarning(
        `Page crashed (url: ${page.url()}) for ${keys.map((key) => `state.${key}`).join(', ')}. ` +
          `Do not reset the session or repeat the last script. Create a new tab with ${key} = await context.newPage(), ` +
          `navigate to the intended URL, then check whether the last action completed before continuing. Other tabs and state are unchanged.`,
      )
    })
    this.setupPageConsoleListener(page)
    this.setupNewPageLogging(page)
    this.ghostCursorController.attachToPage({ page })
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.invalidateSnapshotState(page)
        this.navigatedPages?.add(page)
      }
    })
    page.on('framedetached', (frame) => {
      const references = this.snapshotReferences.get(page)
      if (references) {
        this.forgetFrameReferences(references, frame)
      }
    })
    page.on('close', () => {
      this.invalidateSnapshotState(page)
      this.snapshotReferences.delete(page)
      this.ghostCursorController.detachFromPage({ page })
    })
  }

  private invalidateSnapshotState(page: Page) {
    this.lastSnapshots.delete(page)
    this.lastRefToLocator.delete(page)
    this.lastScreenshotHashes.delete(page)
    this.pageDocumentGenerations.set(page, (this.pageDocumentGenerations.get(page) || 0) + 1)
    this.lastNavigationAt.set(page, Date.now())
  }

  private forgetFrameReferences(references: PageSnapshotReferences, frame: Frame) {
    const frameReferences = references.byFrame.get(frame)
    if (frameReferences) {
      for (const id of frameReferences.ids.values()) {
        references.byRef.delete(id)
      }
      references.byFrame.delete(frame)
    }
  }

  private rememberSnapshotReference(page: Page, reference: SnapshotReference): string {
    let references = this.snapshotReferences.get(page)
    if (!references) {
      references = { byRef: new Map(), byFrame: new Map() }
      this.snapshotReferences.set(page, references)
    }

    const { frame, documentId, backendNodeId } = reference
    let frameReferences = references.byFrame.get(frame)
    if (frameReferences?.documentId !== documentId) {
      this.forgetFrameReferences(references, frame)
      frameReferences = { documentId, ids: new Map() }
      references.byFrame.set(frame, frameReferences)
    }

    let id = frameReferences.ids.get(backendNodeId)
    if (!id) {
      id = `e${this.nextSnapshotReference++}`
      frameReferences.ids.set(backendNodeId, id)
      references.byRef.set(id, reference)
    }
    return id
  }

  private setupPageCloseDetection(page: Page) {
    page.on('close', () => {
      const stateKeysForClosedPage = this.stateKeysForPage(page)
      if (!this.isConnected || this.suppressPageCloseWarnings || stateKeysForClosedPage.length === 0) {
        return
      }

      const stateKeyLabel = stateKeysForClosedPage.map((key) => `state.${key}`).join(', ')
      const closedUrl = page.url() || 'unknown'
      this.enqueueWarning(
        `Page closed (url: ${closedUrl}) for ${stateKeyLabel}. ` +
          `Assign a new open page to ${stateKeyLabel} before reusing it, e.g. ${stateKeyLabel.split(', ')[0]} = await context.newPage().`,
      )
    })
  }

  private setupNewPageLogging(page: Page) {
    // page.on('popup') fires for window.open, target=_blank, and cmd+click
    // (but not context.newPage() or CDP reconnection). The extension
    // auto-relocates popups to tabs, so these pages are controllable via
    // context.pages(). Enqueue synchronously so the warning lands in the
    // enclosing execute() call's scope. initialUrl may be 'about:blank'
    // for blank-then-scripted popups.
    page.on('popup', (popup) => {
      const pages = popup.context().pages()
      const rawIndex = pages.indexOf(popup)
      const pageIndex = rawIndex >= 0 ? String(rawIndex) : 'unknown'
      const initialUrl = popup.url() || 'about:blank'
      this.enqueueWarning(
        `New page opened from current page (index ${pageIndex}, initial url: ${initialUrl}). ` +
          `Access it via context.pages()[${pageIndex}] to interact with it.`,
      )
    })
  }

  private setupPageConsoleListener(page: Page) {
    if (!this.browserLogs.has(page)) {
      this.browserLogs.set(page, [])
    }

    // Logs are NOT cleared on navigation so that getLatestLogs({ sinceLastCall: true })
    // can return errors from the previous page load. The MAX_LOGS_PER_PAGE cap (5000)
    // prevents unbounded growth; old entries are shifted out in addBrowserLog.

    page.on('close', () => {
      this.browserLogs.delete(page)
      this.pageLogCursor.delete(page)
    })

    if (this.patchright) {
      this.setupPatchrightLogListener(page)
      return
    }

    page.on('console', (msg) => {
      try {
        const logEntry = `[${msg.type()}] ${msg.text()}`
        this.addBrowserLog({ page, logEntry })
      } catch (e) {
        this.logger.error('[Executor] Failed to get console message text:', e)
      }
    })

    // Playwright's pageerror names a thrown plain object only by its class ("Object"). The raw CDP event has
    // a preview of its properties, and the two arrive in no fixed order, so a bare class name waits briefly.
    const thrownObjects = new Map<string, string[]>()
    const takeThrownObject = (className: string) => thrownObjects.get(className)?.shift()
    let previewsArrive = false
    getCDPSessionForPage({ page })
      .then((cdp) => {
        cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
          const text = describeThrownObject(exceptionDetails.exception)
          const className = exceptionDetails.exception?.description
          if (!text || !className) {
            return
          }
          const waiting = thrownObjects.get(className) ?? []
          thrownObjects.set(className, [...waiting.slice(-20), text])
        })
        previewsArrive = true
      })
      .catch(() => {})

    page.on('pageerror', (error) => {
      const text = takeThrownObject(error.message)
      if (text || !previewsArrive || !/^[A-Z][\w$]*$/.test(error.message)) {
        this.addPageError({ page, message: text ?? error.message })
        return
      }
      setTimeout(() => {
        this.addPageError({ page, message: takeThrownObject(error.message) ?? error.message })
      }, THROWN_OBJECT_PREVIEW_WAIT_MS)
    })
  }

  // Patchright keeps Runtime off, so page.on('console') stays silent. Raw Runtime events still arrive while
  // another client keeps Runtime on, or while getLatestLogs turns it on to make Chrome replay its buffered
  // messages. Every replay repeats all buffered messages, so timestamps drop the ones already stored.
  private setupPatchrightLogListener(page: Page) {
    let lastTimestamp = 0
    const isNew = (timestamp: number) => {
      if (timestamp <= lastTimestamp) {
        return false
      }
      lastTimestamp = timestamp
      return true
    }
    getCDPSessionForPage({ page })
      .then((cdp) => {
        cdp.on('Runtime.consoleAPICalled', (event) => {
          if (isNew(event.timestamp)) {
            this.addBrowserLog({ page, logEntry: `[${event.type}] ${event.args.map(describeRemoteObject).join(' ')}` })
          }
        })
        cdp.on('Runtime.exceptionThrown', ({ timestamp, exceptionDetails }) => {
          if (isNew(timestamp)) {
            this.addPageError({
              page,
              message:
                describeThrownObject(exceptionDetails.exception) ??
                exceptionDetails.exception?.description?.split('\n')[0] ??
                exceptionDetails.text,
            })
          }
        })
      })
      .catch((e) => {
        this.logger.error('[Executor] Failed to listen for Patchright page logs:', e)
      })
  }

  // Chrome replays buffered console messages and exceptions on Runtime.enable. Patchright turns Runtime
  // on only for this read, so the page sees a debugger for a few milliseconds, not the whole session.
  private async readPatchrightLogs(page: Page) {
    const cdp = await getCDPSessionForPage({ page })
    await cdp.send('Runtime.enable')
    await cdp.send('Runtime.disable')
  }

  private addPageError(options: { page: Page; message: string }) {
    this.addBrowserLog({ page: options.page, logEntry: `[pageerror] ${options.message}` })
    if (this.stateKeysForPage(options.page).length > 0) {
      this.enqueueOutputEvent({ type: 'page-error', message: options.message })
    }
  }

  private addBrowserLog(options: { page: Page; logEntry: string }) {
    if (!this.browserLogs.has(options.page)) {
      this.browserLogs.set(options.page, [])
    }
    const pageLogs = this.browserLogs.get(options.page)!
    pageLogs.push(options.logEntry)
    if (pageLogs.length > MAX_LOGS_PER_PAGE) {
      pageLogs.shift()
      // Decrement cursor so it stays in sync with the shifted array.
      // Clamp to 0 so the cursor never goes negative.
      const cursor = this.pageLogCursor.get(options.page)
      if (cursor !== undefined && cursor > 0) {
        this.pageLogCursor.set(options.page, cursor - 1)
      }
    }
  }

  private pagesRelatedToPage(page: Page): Page[] {
    const frameUrls = new Set(
      page
        .frames()
        .map((frame) => {
          return frame.url()
        })
        .filter((url) => {
          return url && url !== 'about:blank'
        }),
    )

    return page
      .context()
      .pages()
      .filter((candidate) => {
        return candidate === page || frameUrls.has(candidate.url())
      })
  }

  private async checkExtensionStatus(): Promise<{
    connected: boolean
    activeTargets: number
    playwriterVersion: string | null
  }> {
    const { host = '127.0.0.1', port = getRelayPort(), extensionId, token } = this.cdpConfig
    const { httpBaseUrl } = parseRelayHost(host, port)
    const notConnected = { connected: false, activeTargets: 0, playwriterVersion: null }
    const headers: Record<string, string> = {}
    const effectiveToken = token || readEnv('TOKEN')
    if (effectiveToken) {
      headers['Authorization'] = `Bearer ${effectiveToken}`
    }
    try {
      if (extensionId) {
        const response = await fetch(`${httpBaseUrl}/extensions/status`, {
          signal: AbortSignal.timeout(2000),
          headers,
        })
        if (!response.ok) {
          const fallback = await fetch(`${httpBaseUrl}/extension/status`, {
            signal: AbortSignal.timeout(2000),
            headers,
          })
          if (!fallback.ok) {
            return notConnected
          }
          return (await fallback.json()) as {
            connected: boolean
            activeTargets: number
            playwriterVersion: string | null
          }
        }
        const data = (await response.json()) as {
          extensions: Array<{
            extensionId: string
            stableKey?: string
            activeTargets: number
            playwriterVersion?: string | null
          }>
        }
        const extension = data.extensions.find((item) => {
          return item.extensionId === extensionId || item.stableKey === extensionId
        })
        if (!extension) {
          return notConnected
        }
        return {
          connected: true,
          activeTargets: extension.activeTargets,
          playwriterVersion: extension?.playwriterVersion || null,
        }
      }

      const response = await fetch(`${httpBaseUrl}/extension/status`, {
        signal: AbortSignal.timeout(2000),
        headers,
      })
      if (!response.ok) {
        return notConnected
      }
      return (await response.json()) as { connected: boolean; activeTargets: number; playwriterVersion: string | null }
    } catch {
      return notConnected
    }
  }

  /** Remote dials drop and retry; wait instead of showing the local-extension error. */
  private async requireConnectedExtension(): Promise<{
    connected: boolean
    activeTargets: number
    playwriterVersion: string | null
  }> {
    let status = await this.checkExtensionStatus()
    const remote = isRemoteExtensionKey(this.cdpConfig.extensionId || '')
    if (!status.connected && remote) {
      const deadline = Date.now() + 8000
      while (!status.connected && Date.now() < deadline) {
        await sleep(200)
        status = await this.checkExtensionStatus()
      }
    }
    if (!status.connected) {
      throw new Error(remote ? REMOTE_EXTENSION_NOT_CONNECTED_ERROR : EXTENSION_NOT_CONNECTED_ERROR)
    }
    return status
  }

  private isDirectCdpMode(): boolean {
    return !!this.cdpConfig.directCdpUrl
  }

  isHeadlessMode(): boolean {
    return !!this.cdpConfig.headless
  }

  /**
   * Connect to Chrome and set up the context. Shared by ensureConnection and reset.
   * Never opens a tab: the sandbox has no default page, code creates or picks its own.
   * In headless mode, launches Chrome via chromium.launch().
   * In direct CDP mode, connects straight to Chrome's WebSocket.
   * In extension mode, checks extension status then connects via relay.
   */
  private async connectToBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
    // Headless mode: launch Chrome directly via Playwright (no extension, no relay CDP routing)
    if (this.isHeadlessMode()) {
      return this.connectHeadlessBrowser()
    }

    if (this.isDirectCdpMode()) {
      // Direct CDP: connect straight to Chrome, no relay or extension needed
      const chromium = await getChromium({ patchright: this.patchright })
      const browser = await chromium.connectOverCDP(this.cdpConfig.directCdpUrl!)

      browser.on('disconnected', () => {
        this.logger.log('Browser disconnected, clearing connection state')
        this.clearConnectionState()
      })

      const contexts = browser.contexts()
      const context = contexts.length > 0 ? contexts[0] : await browser.newContext()

      context.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT_MS)
      context.setDefaultNavigationTimeout(10000)

      context.on('page', (page) => {
        this.setupPageListeners(page)
      })

      context.pages().forEach((p) => this.setupPageListeners(p))

      await this.setDeviceScaleFactorForMacOS(context)

      return { browser, context }
    }

    // Extension mode: check status first for better error messages
    const extensionStatus = await this.requireConnectedExtension()
    this.warnIfExtensionOutdated(extensionStatus.playwriterVersion)

    const cdpUrl = getCdpUrl({ ...this.cdpConfig, patchright: this.patchright })
    const chromium = await getChromium({ patchright: this.patchright })
    const browser = await chromium.connectOverCDP(cdpUrl)

    browser.on('disconnected', () => {
      this.logger.log('Browser disconnected, clearing connection state')
      this.clearConnectionState()
    })

    const contexts = browser.contexts()
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext()

    // Action timeout (click, fill, hover, etc.) is longer to tolerate slower
    // SPA/Turbo navigations and post-click settling on real sites.
    // Navigation timeout (goto, reload) remains separate.
    context.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT_MS)
    context.setDefaultNavigationTimeout(10000)

    context.on('page', (page) => {
      this.setupPageListeners(page)
    })

    context.pages().forEach((p) => this.setupPageListeners(p))

    await this.setDeviceScaleFactorForMacOS(context)

    return { browser, context }
  }

  /**
   * Launch a headless Chrome via chromium.launch(). No extension, no relay CDP routing.
   * Reuses an existing shared browser if one was already launched for headless mode.
   * Does NOT add per-session disconnect listeners to avoid accumulation on the shared
   * browser; instead, ensureConnection checks browser.isConnected() on each call.
   */
  private async connectHeadlessBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
    const browser = await PlaywrightExecutor.getOrLaunchHeadlessBrowser()

    const context = await browser.newContext()
    try {
      context.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT_MS)
      context.setDefaultNavigationTimeout(10000)

      context.on('page', (page) => {
        this.setupPageListeners(page)
      })

      await this.setDeviceScaleFactorForMacOS(context)

      PlaywrightExecutor._headlessExecutors.add(this)
      return { browser, context }
    } catch (e) {
      await context.close().catch(() => {})
      throw e
    }
  }

  private static _sharedHeadlessBrowser: Browser | null = null
  private static _sharedHeadlessBrowserPromise: Promise<Browser> | null = null
  private static _headlessExecutors = new Set<PlaywrightExecutor>()

  private static async getOrLaunchHeadlessBrowser(): Promise<Browser> {
    if (PlaywrightExecutor._sharedHeadlessBrowser?.isConnected()) {
      return PlaywrightExecutor._sharedHeadlessBrowser
    }

    if (PlaywrightExecutor._sharedHeadlessBrowserPromise) {
      return PlaywrightExecutor._sharedHeadlessBrowserPromise
    }

    const launchPromise = (async () => {
      const chromium = await getChromium()
      const { resolveBrowserExecutablePath } = await import('./browser-config.js')
      const executablePath = resolveBrowserExecutablePath()

      const browser = await chromium.launch({
        headless: true,
        // Playwright passes --no-sandbox unless chromiumSandbox is true.
        // Agents browse untrusted pages, so keep the Chromium sandbox on,
        // except as root on Linux (Docker), where Chromium cannot start sandboxed.
        chromiumSandbox: !(process.platform === 'linux' && process.getuid?.() === 0),
        executablePath,
      })

      browser.on('disconnected', () => {
        if (PlaywrightExecutor._sharedHeadlessBrowser !== browser) {
          return
        }
        PlaywrightExecutor._sharedHeadlessBrowser = null
        PlaywrightExecutor._sharedHeadlessBrowserPromise = null
        PlaywrightExecutor._headlessExecutors.clear()
      })

      PlaywrightExecutor._sharedHeadlessBrowser = browser
      PlaywrightExecutor._sharedHeadlessBrowserPromise = null
      return browser
    })()

    PlaywrightExecutor._sharedHeadlessBrowserPromise = launchPromise
    try {
      return await launchPromise
    } catch (error) {
      PlaywrightExecutor._sharedHeadlessBrowserPromise = null
      throw error
    }
  }

  async closeHeadlessContext(): Promise<void> {
    if (!this.isHeadlessMode()) {
      return
    }
    const context = this.context
    this.clearConnectionState()

    if (context) {
      await context.close().catch((e) => {
        this.logger.error('Error closing headless context:', e)
      })
    }

    const wasTracked = PlaywrightExecutor._headlessExecutors.delete(this)
    if (wasTracked && PlaywrightExecutor._headlessExecutors.size === 0) {
      await PlaywrightExecutor.closeSharedHeadlessBrowser()
    }
  }

  static async closeSharedHeadlessBrowser(): Promise<void> {
    const browser = PlaywrightExecutor._sharedHeadlessBrowser
    if (browser) {
      PlaywrightExecutor._sharedHeadlessBrowser = null
      PlaywrightExecutor._sharedHeadlessBrowserPromise = null
      await browser.close().catch(() => {})
    }
  }

  private async ensureConnection(): Promise<{ browser: Browser; context: BrowserContext }> {
    // In headless mode, check that this session's browser is still alive.
    const browserAlive = this.isHeadlessMode() ? this.browser?.isConnected() : true
    if (this.isConnected && this.browser && this.context && browserAlive) {
      return { browser: this.browser, context: this.context }
    }

    const { browser, context } = await this.connectToBrowser()
    this.browser = browser
    this.context = context
    this.isConnected = true

    return { browser, context }
  }

  /** Used by the action recorder (`better-playwriter recorder`) to attach
   *  context-level instrumentation. Connects to the browser if needed. */
  withBrowserContext<T>({ operation }: { operation: (context: BrowserContext) => Promise<T> }): Promise<T> {
    return this.runExclusive({
      operation: async () => {
        const { context } = await this.ensureConnection()
        return operation(context)
      },
    })
  }

  async reset(): Promise<{ context: BrowserContext }> {
    return this.runExclusive({ operation: () => this.resetInternal() })
  }

  /** Switch between Playwright and Patchright. A connected session reconnects like reset(), so tabs stay open and state is cleared. */
  async setPatchright(patchright: boolean): Promise<{ reconnected: boolean }> {
    return this.runExclusive({
      operation: async () => {
        if (this.patchright === patchright) {
          return { reconnected: false }
        }
        this.patchright = patchright
        if (!this.isConnected) {
          return { reconnected: false }
        }
        await this.resetInternal()
        return { reconnected: true }
      },
    })
  }

  private async resetInternal(): Promise<{ context: BrowserContext }> {
    this.suppressPageCloseWarnings = true
    try {
      if (this.isHeadlessMode()) {
        if (this.context) {
          await this.context.close().catch((e) => {
            this.logger.error('Error closing context:', e)
          })
        }
      } else if (this.browser) {
        await this.browser.close()
      }
    } catch (e) {
      this.logger.error('Error closing browser:', e)
    } finally {
      this.suppressPageCloseWarnings = false
    }

    this.clearConnectionState()
    this.clearExecutionState()

    const { browser, context } = await this.connectToBrowser()

    this.browser = browser
    this.context = context
    this.isConnected = true

    return { context }
  }

  /** `signal` aborts the script like a timeout does, for example when the HTTP caller disconnects. */
  async execute(
    code: string,
    {
      timeout = 10000,
      signal,
      onStart,
      onHandoffChange,
    }: {
      timeout?: number
      signal?: AbortSignal
      onStart?: () => void
      onHandoffChange?: (targetId: string, waiting: boolean) => void
    } = {},
  ): Promise<ExecuteResult> {
    return this.runExclusive({
      operation: () => this.executeInternal({ code, timeout, signal, onStart, onHandoffChange }),
    })
  }

  private async executeInternal({
    code,
    timeout,
    signal,
    onStart,
    onHandoffChange,
  }: {
    code: string
    timeout: number
    signal?: AbortSignal
    onStart?: () => void
    onHandoffChange?: (targetId: string, waiting: boolean) => void
  }): Promise<ExecuteResult> {
    const consoleLogs: Array<{ method: string; args: any[] }> = []
    const outputScope = this.beginOutputScope()
    const handoffPages = new Set<Page>()

    const abortController = new AbortController()
    let scriptStartedAt = 0
    // Bot challenge checks use what is left of the execute timeout, so they never extend a successful call.
    const challengeDeadline = () => {
      return Math.min(scriptStartedAt + timeout, Date.now() + MAX_CHALLENGE_WAIT_MS)
    }

    try {
      // The caller left while this execute waited for the session lock.
      if (signal?.aborted) {
        throw new ExecuteCancelledError()
      }
      onStart?.()
      const { context } = await this.ensureConnection()
      if (signal?.aborted) {
        throw new ExecuteCancelledError()
      }
      context.setDefaultTimeout(actionTimeoutFor(timeout))

      this.logger.log('Executing code:', code)

      const customConsole = {
        log: (...args: any[]) => {
          consoleLogs.push({ method: 'log', args })
        },
        info: (...args: any[]) => {
          consoleLogs.push({ method: 'info', args })
        },
        warn: (...args: any[]) => {
          consoleLogs.push({ method: 'warn', args })
        },
        error: (...args: any[]) => {
          consoleLogs.push({ method: 'error', args })
        },
        debug: (...args: any[]) => {
          consoleLogs.push({ method: 'debug', args })
        },
      }

      const snapshot = async (options: {
        page?: Page
        /** Optional frame to scope the snapshot (e.g. from iframe.contentFrame() or page.frames()) */
        frame?: Frame | FrameLocator
        /** Optional locator to scope the snapshot to a subtree */
        locator?: Locator
        search?: string | RegExp
        showDiffSinceLastCall?: boolean
        mode?: SnapshotMode
        maxDepth?: number
        maxChars?: number
        /** Snapshot format (currently raw only) */
        format?: SnapshotFormat
        /** Select a legacy locator-based view. */
        interactiveOnly?: boolean
        /** Right after a navigation, wait up to 3 s for the page to stop loading. Default true. */
        waitForLoad?: boolean
      } = {}) => {
        const usesLegacyView = options.interactiveOnly !== undefined || options.format === 'raw'
        const {
          page: targetPage,
          frame,
          locator,
          search,
          showDiffSinceLastCall = !search,
          // A search looks for text as often as for a control, so it reads the compact view: text and refs.
          mode = usesLegacyView ? undefined : options.search ? 'compact' : 'interactive',
          interactiveOnly,
          maxDepth,
          maxChars = mode && mode !== 'full' ? DEFAULT_SNAPSHOT_MAX_CHARS : undefined,
        } = options
        if (mode !== undefined && !['interactive', 'compact', 'full'].includes(mode)) {
          throw new Error("snapshot mode must be 'interactive', 'compact', or 'full'")
        }
        if (maxChars !== undefined && (!Number.isSafeInteger(maxChars) || maxChars < MIN_SNAPSHOT_MAX_CHARS)) {
          throw new Error(`snapshot maxChars must be an integer of at least ${MIN_SNAPSHOT_MAX_CHARS}`)
        }
        const resolvedPage = resolveSandboxPage({ helper: 'snapshot', page: targetPage, locator, frame })
        if (locator && (await locator.count()) === 0) {
          // The region may still be rendering, but a selector that matches nothing must not cost the whole timeout.
          await locator.first().waitFor({ state: 'attached', timeout: SNAPSHOT_SCOPE_WAIT_MS }).catch(() => {
            throw new Error(
              `snapshot: the locator matched 0 elements (${locator}). Take a snapshot of the page to find the region, or find it by its label with getByLabel().`,
            )
          })
        }
        // goto(..., { waitUntil: 'domcontentloaded' }) returns on the empty shell of a single-page app.
        // A snapshot taken then would show a progress bar and cost the agent a second call.
        const navigatedAt = this.lastNavigationAt.get(resolvedPage)
        if (options.waitForLoad !== false && navigatedAt !== undefined && Date.now() - navigatedAt < SNAPSHOT_SETTLE_WINDOW_MS) {
          const settleUntil = Date.now() + SNAPSHOT_SETTLE_TIMEOUT_MS
          // Mail and chat apps keep fetching for many seconds after their content is on screen, so a quiet
          // network is a late signal. The content itself is the signal: its size stops changing.
          const measure = () => {
            return evaluateIsolated({
              target: resolvedPage,
              fn: () => {
                const doc = (globalThis as any).document
                const body = doc?.body
                return {
                  text: body ? body.innerText.trim().length : 0,
                  controls: body ? body.querySelectorAll('a[href],button,input,select,textarea,[contenteditable]').length : 0,
                  // A splash screen can hold the app's hidden controls: only one that shows counts as content.
                  shown: body
                    ? [...body.querySelectorAll('a[href],button,input,select,textarea,[contenteditable]')]
                        .slice(0, 50)
                        .some((element: any) => {
                          return element.checkVisibility
                            ? element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
                            : element.getClientRects().length > 0
                        })
                    : false,
                  complete: doc?.readyState === 'complete',
                  scripts: doc?.scripts?.length ?? 0,
                }
              },
              // A redirect destroyed the document under the check: the next one is still on its way.
            }).catch(() => undefined)
          }
          const settleStart = Date.now()
          let base: { text: number; controls: number } | undefined
          let stableSince = 0
          while (Date.now() < settleUntil) {
            const size = await measure()
            const network = getNetworkActivity(resolvedPage)
            const networkIdle = network.inFlight === 0 && network.quietForMs >= SNAPSHOT_SETTLE_QUIET_MS
            // No text and nothing to act on: a splash screen, complete and quiet while the app's scripts start.
            if (!size || (size.text === 0 && !size.shown)) {
              base = undefined
              // An image or an empty document stays blank for good: once nothing has been fetched for a
              // second, this is the page. A blank page with scripts is an app starting, and a chat app's
              // splash was seen to fetch nothing for almost two seconds before its content came.
              const blankQuietMs = size && size.scripts > 0 ? SNAPSHOT_SETTLE_APP_START_MS : 1000
              if (size && Date.now() - settleStart >= blankQuietMs && network.inFlight === 0 && network.quietForMs >= blankQuietMs) {
                break
              }
              await sleep(SNAPSHOT_SETTLE_POLL_MS)
              continue
            }
            if (base && isSameContentSize(base, size)) {
              const stableFor = Date.now() - stableSince
              // A loaded page that fetches nothing is ready after one confirming look.
              if (stableFor >= SNAPSHOT_SETTLE_STABLE_MS || (size.complete && networkIdle)) {
                break
              }
            } else {
              base = size
              stableSince = Date.now()
            }
            await sleep(SNAPSHOT_SETTLE_POLL_MS)
          }
        }
        const frameNotes = !frame && !locator && mode !== undefined ? await describeChildFrames(resolvedPage).catch(() => '') : ''
        const withPageUrl = (body: string, { condense = false }: { condense?: boolean } = {}) => {
          const url = resolvedPage.url()
          const boundedUrl = maxChars !== undefined && url.length > 512 ? `${url.slice(0, 512)}…` : url
          // The iframe notes are part of the answer, so they come out of the same budget.
          const budget =
            maxChars === undefined ? undefined : Math.max(MIN_SNAPSHOT_MAX_CHARS, maxChars - (frameNotes ? frameNotes.length + 1 : 0))
          const bounded = budget === undefined ? body : limitSnapshotOutput({ snapshot: body, maxChars: budget, condense })
          return `URL: ${boundedUrl}\n${bounded}${frameNotes ? `\n${frameNotes}` : ''}`
        }
        const navigatedMessage = 'Page navigated while the accessibility snapshot was being captured. Try again.'
        const capture = async () => {
          const documentGeneration = this.pageDocumentGenerations.get(resolvedPage) || 0
          const checkDocument = () => {
            if ((this.pageDocumentGenerations.get(resolvedPage) || 0) !== documentGeneration) {
              throw new Error(navigatedMessage)
            }
          }
          const result = await getAriaSnapshot({
            page: resolvedPage,
            frame,
            locator,
            interactiveOnly,
            mode,
            maxDepth,
            reference: mode && mode !== 'full'
              ? (reference) => {
                  checkDocument()
                  return this.rememberSnapshotReference(resolvedPage, reference)
                }
              : undefined,
          })
          checkDocument()
          return result
        }
        // A redirect right after goto() swaps the document mid-capture. Take the snapshot of the page that
        // loads next instead of handing the agent a retry.
        const retryUntil = Date.now() + SNAPSHOT_NAVIGATION_RETRY_MS
        let captured: Awaited<ReturnType<typeof capture>>
        while (true) {
          try {
            captured = await capture()
            break
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const navigated = message === navigatedMessage || NAVIGATION_RACE_ERROR.test(message)
            if (!navigated || locator || Date.now() >= retryUntil) {
              throw error
            }
            await sleep(200)
          }
        }
        const { snapshot: rawSnapshot, refs, getSelectorForRef } = captured
        const snapshotStr = rawSnapshot.toWellFormed?.() ?? rawSnapshot

        const refToLocator = new Map<string, string>()
        for (const entry of refs) {
          const locatorStr = getSelectorForRef(entry.ref)
          if (locatorStr) {
            refToLocator.set(entry.shortRef, locatorStr)
          }
        }
        this.lastRefToLocator.set(resolvedPage, refToLocator)

        const shouldCacheSnapshot = !frame
        // Cache keyed by locator selector so full-page and locator-scoped snapshots
        // don't pollute each other's diff baselines
        const detail = mode ?? (interactiveOnly ? 'legacy-interactive' : 'legacy-full')
        const snapshotKey = JSON.stringify([locator?.selector(), detail, maxDepth])
        let pageSnapshots = this.lastSnapshots.get(resolvedPage)
        if (!pageSnapshots) {
          pageSnapshots = new Map()
          this.lastSnapshots.set(resolvedPage, pageSnapshots)
        }
        const previousSnapshot = shouldCacheSnapshot ? pageSnapshots.get(snapshotKey) : undefined
        if (shouldCacheSnapshot) {
          pageSnapshots.set(snapshotKey, snapshotStr)
        }

        // Diff defaults off when search is provided, but agent can explicitly enable both
        if (showDiffSinceLastCall && previousSnapshot && shouldCacheSnapshot) {
          const diffResult = createSmartDiff({
            oldContent: previousSnapshot,
            newContent: snapshotStr,
            label: 'snapshot',
          })
          if (diffResult.type === 'no-change') {
            return withPageUrl(
              'No changes since last snapshot. Use showDiffSinceLastCall: false to see full content.',
            )
          }
          return withPageUrl(search ? searchSnapshot({ snapshot: diffResult.content, search }) : diffResult.content)
        }

        if (!search) {
          if (mode === 'interactive' && !snapshotStr.trim()) {
            return withPageUrl("No interactive elements found. Use mode: 'compact' to read visible text.")
          }
          const body = mode
            ? snapshotStr
            : `${snapshotStr}\n\nuse refToLocator({ ref: 'e3', page: state.page }) to get locators for ref strings.`
          return withPageUrl(body, { condense: true })
        }

        return withPageUrl(searchSnapshot({ snapshot: snapshotStr, search }))
      }

      const refToLocator = (options: { ref: string; page?: Page }): string | null => {
        const targetPage = resolveSandboxPage({ helper: 'refToLocator', page: options.page })
        const map = this.lastRefToLocator.get(targetPage)
        if (!map) {
          return null
        }
        return map.get(options.ref) ?? null
      }

      const elementForRef = async (options: { ref: string; page?: Page }): Promise<ElementHandle> => {
        const targetPage = resolveSandboxPage({ helper: 'elementForRef', page: options.page })
        if (!/^@?e[1-9]\d*$/.test(options.ref)) {
          throw new Error('elementForRef requires a reference such as @e3 from a recent snapshot.')
        }
        const reference = this.snapshotReferences.get(targetPage)?.byRef.get(options.ref.replace(/^@/, ''))
        if (!reference) {
          throw new Error(`Snapshot reference ${options.ref} is unavailable on this page. Take a fresh snapshot.`)
        }
        return await resolveSnapshotReference({ page: targetPage, reference })
      }

      const getLocatorStringForElement = async (element: Locator | ElementHandle) => {
        if (!element || typeof element.evaluate !== 'function') {
          throw new Error('getLocatorStringForElement: argument must be a Playwright Locator or ElementHandle')
        }
        const elementPage = 'page' in element ? element.page() : (await element.ownerFrame())?.page()
        if (!elementPage) {
          throw new Error('getLocatorStringForElement: could not get the page of this element')
        }
        const hasGenerator = await elementPage.evaluate(() => !!(globalThis as any).__selectorGenerator)
        if (!hasGenerator) {
          const scriptPath = path.join(__dirname, '..', 'dist', 'selector-generator.js')
          const scriptContent = fs.readFileSync(scriptPath, 'utf-8')
          const cdp = await getCDPSession({ page: elementPage })
          await cdp.send('Runtime.evaluate', { expression: scriptContent })
        }
        const generateLocator = (el: any) => {
          const { createSelectorGenerator, toLocator } = (globalThis as any).__selectorGenerator
          const generator = createSelectorGenerator(globalThis)
          const result = generator(el)
          return toLocator(result.selector, 'javascript')
        }
        return 'page' in element ? await element.evaluate(generateLocator) : await element.evaluate(generateLocator)
      }

      const getLatestLogs = async (options: {
        page?: Page
        count?: number
        search?: string | RegExp
        // When true, only return logs added since the last getLatestLogs call
        // with sinceLastCall: true. First call returns all buffered logs.
        // Cursors are tracked per page so navigations and new logs are
        // never missed. Useful for checking page errors after each action.
        sinceLastCall?: boolean
      } = {}) => {
        const { page: requestedPage, count, search, sinceLastCall = false } = options
        const filterPage = resolveSandboxPage({ helper: 'getLatestLogs', page: requestedPage })
        let allLogs: string[] = []

        // Collect logs, optionally slicing from cursor when sinceLastCall is set
        const collectLogs = (targetPage: Page): string[] => {
          const logs = this.browserLogs.get(targetPage) || []
          if (!sinceLastCall) {
            return logs
          }
          const cursor = this.pageLogCursor.get(targetPage) || 0
          return logs.slice(cursor)
        }

        const relatedPages = this.pagesRelatedToPage(filterPage)
        if (this.patchright) {
          await Promise.all(
            relatedPages
              .filter((relatedPage) => !relatedPage.isClosed())
              .map((relatedPage) => {
                return this.readPatchrightLogs(relatedPage).catch((e) => {
                  this.logger.error('[Executor] Failed to read Patchright page logs:', e)
                })
              }),
          )
        }
        allLogs = relatedPages.flatMap((relatedPage) => {
          return collectLogs(relatedPage)
        })

        // Advance cursors after collecting so next sinceLastCall call starts fresh
        if (sinceLastCall) {
          for (const p of relatedPages) {
            const logs = this.browserLogs.get(p)
            if (logs) {
              this.pageLogCursor.set(p, logs.length)
            }
          }
        }

        if (search) {
          const matchIndices: number[] = []
          for (let i = 0; i < allLogs.length; i++) {
            const log = allLogs[i]
            const isMatch = typeof search === 'string' ? log.includes(search) : isRegExp(search) && search.test(log)
            if (isMatch) matchIndices.push(i)
          }

          const CONTEXT_LINES = 5
          const includedIndices = new Set<number>()
          for (const idx of matchIndices) {
            const start = Math.max(0, idx - CONTEXT_LINES)
            const end = Math.min(allLogs.length - 1, idx + CONTEXT_LINES)
            for (let i = start; i <= end; i++) {
              includedIndices.add(i)
            }
          }

          const sortedIndices = [...includedIndices].sort((a, b) => a - b)
          const result: string[] = []
          for (let i = 0; i < sortedIndices.length; i++) {
            const logIdx = sortedIndices[i]
            if (i > 0 && sortedIndices[i - 1] !== logIdx - 1) {
              result.push('---')
            }
            result.push(allLogs[logIdx])
          }
          allLogs = result
        }

        return count !== undefined ? allLogs.slice(-count) : allLogs
      }

      const clearAllLogs = () => {
        this.browserLogs.clear()
        this.pageLogCursor.clear()
      }

      const getCDPSession = async (options: { page: Page }) => {
        if (options.page.isClosed()) {
          throw new Error('Cannot create CDP session for closed page')
        }
        return await getCDPSessionForPage({ page: options.page })
      }

      const createDebugger = (options: { cdp: ICDPSession }) => new Debugger(options)
      const createEditor = (options: { cdp: ICDPSession }) => new Editor(options)

      const getStylesForLocatorFn = async (options: { locator: any }) => {
        const cdp = await getCDPSession({ page: options.locator.page() })
        return getStylesForLocator({ locator: options.locator, cdp })
      }

      const getReactSourceFn = async (options: { locator: any }) => {
        const cdp = await getCDPSession({ page: options.locator.page() })
        return getReactSource({ locator: options.locator, cdp })
      }

      const getReactComponentInfoFn = async (options: { locator: Locator | ElementHandle }) => {
        const targetPage = await (async (): Promise<Page | null> => {
          if ('page' in options.locator) {
            return options.locator.page()
          }

          return (await options.locator.ownerFrame())?.page() ?? null
        })()
        if (!targetPage) {
          throw new Error('Could not get page from locator')
        }
        const cdp = await getCDPSession({ page: targetPage })
        return getReactComponentInfo({ locator: options.locator, cdp })
      }

      const inspectPinnedElement = async (pageUrl: string, elementExpression: string) => {
        const targetPage = context.pages().findLast((candidate) => candidate.url() === pageUrl)
        if (!targetPage) {
          throw new Error(`No Better Playwriter tab with url ${pageUrl}. Enable Better Playwriter on that tab and pin the element again.`)
        }

        this.userState.page = targetPage
        const handle = (await targetPage.evaluateHandle((expression) => {
          return Function(`return (${expression})`)()
        }, elementExpression)).asElement()

        const result = await (async () => {
          if (!handle) {
            return { url: targetPage.url(), outerHTML: null, react: null }
          }
          return {
            url: targetPage.url(),
            outerHTML: await handle.evaluate((el) => el.outerHTML),
            react: await getReactComponentInfoFn({ locator: handle }),
          }
        })()

        console.log(result)
        return result
      }

      const screenshotCollector: ScreenshotResult[] = []
      // Separate collector for images produced by resizeImageForAgent() calls.
      // These get merged into result.images so the CLI can emit them via Kitty Graphics.
      const resizedImageCollector: Array<{ data: string; mimeType: string }> = []

      const resizeImageForAgentFn: typeof resizeImageForAgent = async (options) => {
        const result = await resizeImageForAgent(options)
        resizedImageCollector.push({ data: result.buffer.toString('base64'), mimeType: result.mimeType })
        return result
      }

      const screenshotWithAccessibilityLabelsFn = async (options: {
        page: Page
        locator?: Locator
        interactiveOnly?: boolean
        ifChanged?: boolean
      }): Promise<void> => {
        const targetPage = resolveSandboxPage({ helper: 'screenshotWithAccessibilityLabels', page: options?.page })
        const { locator, interactiveOnly, ifChanged } = options
        const scope = JSON.stringify([locator?.selector(), interactiveOnly ?? true])
        const documentGeneration = this.pageDocumentGenerations.get(targetPage) || 0
        const capture: ScreenshotResult[] = []
        let fingerprint: string | undefined
        const { refToLocator } = await screenshotWithAccessibilityLabels({
          page: targetPage,
          locator,
          interactiveOnly,
          // Same refs as snapshot(): the label e12 on the image is @e12 in the text and in elementForRef.
          reference: interactiveOnly === false
            ? undefined
            : (reference) => this.rememberSnapshotReference(targetPage, reference),
          collector: capture,
          shouldEmit: (buffer) => {
            fingerprint = crypto.createHash('sha256').update(buffer).digest('hex')
            return !ifChanged || fingerprint !== this.lastScreenshotHashes.get(targetPage)?.get(scope)
          },
          logger: {
            info: (...args) => {
              this.logger.error('[playwriter]', ...args)
            },
            error: (...args) => {
              this.logger.error('[playwriter]', ...args)
            },
          },
        })
        // Labels show these refs, so refToLocator must resolve them, not an older snapshot's
        if ((this.pageDocumentGenerations.get(targetPage) || 0) === documentGeneration) {
          this.lastRefToLocator.set(targetPage, refToLocator)
          if (capture.length && fingerprint) {
            let hashes = this.lastScreenshotHashes.get(targetPage)
            if (!hashes) {
              hashes = new Map()
              this.lastScreenshotHashes.set(targetPage, hashes)
            }
            hashes.set(scope, fingerprint)
          }
        }
        for (const shot of capture) {
          screenshotCollector.push({
            ...shot,
            snapshot: limitSnapshotOutput({ snapshot: shot.snapshot, maxChars: DEFAULT_SNAPSHOT_MAX_CHARS }),
          })
        }
        if (capture.length === 0) {
          customConsole.log('Screenshot unchanged.')
        }
      }

      const self = this
      const ghostCursorController = this.ghostCursorController

      const showGhostCursor = async (options?: ({ page?: Page } & GhostCursorClientOptions)) => {
        const targetPage = resolveSandboxPage({ helper: 'ghostCursor.show', page: options?.page })
        const cursorOptions: GhostCursorClientOptions | undefined = (() => {
          if (!options) {
            return undefined
          }

          const { page: _ignoredPage, ...rest } = options
          return rest
        })()

        await ghostCursorController.show({ page: targetPage, cursorOptions })
      }

      const hideGhostCursor = async (options?: { page?: Page }) => {
        const targetPage = resolveSandboxPage({ helper: 'ghostCursor.hide', page: options?.page })
        await ghostCursorController.hide({ page: targetPage })
      }

      // Native screen recording
      const captureLogger = {
        log: (...args: unknown[]) => {
          this.logger.log('[playwriter]', ...args)
        },
        error: (...args: unknown[]) => {
          this.logger.error('[playwriter]', ...args)
        },
      }
      const recordingApi = createRecordingApi({
        ghostCursorController,
        logger: captureLogger,
        cwd: self.sessionCwd,
        onWarning: (message) => {
          self.enqueueWarning(message)
        },
        onStart: () => {
          self.recordingStartedAt = Date.now()
          self.executionTimestamps = []
        },
        onFinish: () => {
          self.recordingStartedAt = null
          self.executionTimestamps = []
        },
        getExecutionTimestamps: () => {
          return self.executionTimestamps
        },
      })

      let streamApi: Promise<ReturnType<typeof createStreamApi>> | undefined
      const getStreamApi = () => {
        streamApi ??= import('./screen-stream.js').then(({ createStreamApi }) => createStreamApi({ logger: captureLogger }))
        return streamApi
      }

      const sandboxedGetBuiltinModule = (id: string) => {
        if (!ALLOWED_MODULES.has(id)) {
          throw Object.assign(
            new Error(
              `Module "${id}" is not allowed in the sandbox. ` +
                `Only safe Node.js built-ins are permitted: ${[...ALLOWED_MODULES].filter((m) => !m.startsWith('node:')).join(', ')}`,
            ),
            { name: 'ModuleNotAllowedError' },
          )
        }
        if (id === 'fs' || id === 'node:fs') {
          return self.scopedFs
        }
        return process.getBuiltinModule(id)
      }

      const DEFAULT_INSPECT_PROPS = ['overflow-y', 'overflow-x', 'position', 'max-height', 'display', 'flex-direction', 'flex-shrink']
      const INSPECT_ARIA = ['aria-expanded', 'aria-selected', 'aria-hidden', 'aria-disabled', 'aria-checked', 'aria-pressed', 'aria-current']

      const inspect = async (options: { locator: Locator; properties?: string[] }) => {
        const { locator, properties } = options
        const box = await locator.boundingBox()
        const boxStr = box ? `x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)} h=${Math.round(box.height)}` : 'not visible'
        const domInfo = await locator.evaluate((el, args) => {
          const cs = window.getComputedStyle(el as any)
          const h = el as any
          const tag = el.tagName.toLowerCase()
          const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean)[0]
          const lines = [
            `Element: ${cls ? tag + '.' + cls : tag}`,
            `Box: ${args.box}`,
            `Children: ${el.children.length}  Text length: ${(el.textContent || '').trim().length}`,
            `Scroll Y: size=${el.scrollHeight} client=${el.clientHeight} overflowing=${el.scrollHeight > el.clientHeight} top=${el.scrollTop}`,
            `Scroll X: size=${el.scrollWidth} client=${el.clientWidth} overflowing=${el.scrollWidth > el.clientWidth} left=${el.scrollLeft}`,
            `Styles: ${args.props.map((p: string) => `${p}=${cs.getPropertyValue(p) || 'unset'}`).join(' ')}`,
          ]
          // Visibility (only non-defaults)
          const vis = [
            cs.opacity !== '1' && `opacity=${cs.opacity}`,
            cs.visibility !== 'visible' && `visibility=${cs.visibility}`,
            cs.pointerEvents !== 'auto' && `pointer-events=${cs.pointerEvents}`,
            !args.hasBox && 'not rendered',
          ].filter(Boolean)
          if (vis.length) lines.push(`Visibility: ${vis.join(' ')}`)
          // Input state (form controls only)
          if (el.matches('input, textarea, select, button, option')) {
            const parts = [
              el.matches('input, textarea, select, option') && `value="${String(h.value).slice(0, 200)}"`,
              el.matches('input') && 'checked' in h && `checked=${h.checked}`,
              h.disabled && 'disabled',
              h.readOnly && 'readOnly',
            ].filter(Boolean)
            if (parts.length) lines.push(`Input: ${parts.join(' ')}`)
          }
          // Aria attributes (only ones that are set)
          const aria = args.aria.map((a: string) => { const v = el.getAttribute(a); return v !== null ? `${a}=${v}` : null }).filter(Boolean)
          if (aria.length) lines.push(`Aria: ${aria.join(' ')}`)
          return lines.join('\n')
        }, { props: properties?.length ? properties : DEFAULT_INSPECT_PROPS, aria: INSPECT_ARIA, box: boxStr, hasBox: !!box })
        return domInfo
      }

      let vmContextObj: any = {
        context,
        browser: this.browser,
        state: this.userState,
        signal: abortController.signal,
        console: customConsole,
        snapshot,
        accessibilitySnapshot: (options?: Parameters<typeof snapshot>[0]) => snapshot({ format: 'raw', ...options }),
        inspect,
        refToLocator,
        elementForRef,
        getCleanHTML: async (options: GetCleanHTMLOptions) => {
          if (options?.ref) {
            // A snapshot ref reaches elements that no role or label locator finds.
            const refPage = resolveSandboxPage({ helper: 'getCleanHTML', page: options.page })
            const element = await elementForRef({ ref: options.ref, page: refPage })
            return getCleanHTML({ ...options, locator: undefined, page: refPage, element })
          }
          if (!options?.locator) {
            throw new Error("getCleanHTML requires { locator } or { ref, page }, e.g. getCleanHTML({ locator: state.page }) or getCleanHTML({ ref: '@e12', page: state.page }).")
          }
          return getCleanHTML(options)
        },
        getPageMarkdown: (options: GetPageMarkdownOptions) => {
          resolveSandboxPage({ helper: 'getPageMarkdown', page: options?.page })
          return getPageMarkdown(options)
        },
        getLocatorStringForElement,
        getLatestLogs,
        getLatestRequests: (options: RecentRequestsOptions) => {
          resolveSandboxPage({ helper: 'getLatestRequests', page: options?.page })
          return getLatestRequests(options)
        },
        clearAllLogs,
        waitForPageLoad: (options: WaitForPageLoadOptions) => {
          const loadPage = resolveSandboxPage({ helper: 'waitForPageLoad', page: options?.page })
          return waitForPageLoad({ network: () => getNetworkActivity(loadPage), ...options })
        },
        getCDPSession,
        createDebugger,
        createEditor,
        getStylesForLocator: getStylesForLocatorFn,
        formatStylesAsText,
        getReactSource: getReactSourceFn,
        getReactComponentInfo: getReactComponentInfoFn,
        inspectPinnedElement,
        screenshotWithAccessibilityLabels: screenshotWithAccessibilityLabelsFn,
        resizeImageForAgent: resizeImageForAgentFn,
        // Backward-compatible alias for resizeImageForAgent
        resizeImage: resizeImageForAgentFn,
        ghostCursor: {
          show: showGhostCursor,
          hide: hideGhostCursor,
        },
        handoff: (options: HandoffOptions) => {
          const page = resolveSandboxPage({ helper: 'handoff', page: options?.page })
          handoffPages.add(page)
          return handoff(options)
        },
        waitForHandoff: async (options: WaitForHandoffOptions) => {
          const page = resolveSandboxPage({ helper: 'waitForHandoff', page: options?.page })
          handoffPages.add(page)
          const targetId = page.targetId()
          if (targetId) onHandoffChange?.(targetId, true)
          try {
            return await waitForHandoff(options)
          } finally {
            if (targetId) onHandoffChange?.(targetId, false)
          }
        },
        clearHandoff: (options: { page: Page }) => {
          resolveSandboxPage({ helper: 'clearHandoff', page: options?.page })
          return clearHandoff(options)
        },
        recording: {
          start: recordingApi.start,
          stop: recordingApi.stop,
        },
        stream: {
          start: async (options: Omit<StartStreamOptions, 'logger'>) => (await getStreamApi()).start(options),
          stop: async (options?: CaptureTargetOptions) => (await getStreamApi()).stop(options),
          status: async (options?: CaptureTargetOptions) => (await getStreamApi()).status(options),
        },
        createDemoVideo,
        resetPlaywright: async () => {
          const { context: newContext } = await self.resetInternal()
          vmContextObj.context = newContext
          vmContextObj.browser = self.browser
          vmContextObj.state = self.userState
          return { context: newContext }
        },
        require: this.sandboxedRequire,
        // Restricted alternative to native import() for allowlisted built-ins.
        importModule: (specifier: string) => {
          if (!ALLOWED_MODULES.has(specifier)) {
            throw Object.assign(
              new Error(
                `Module "${specifier}" is not allowed in the sandbox. ` +
                  `Only safe Node.js built-ins are permitted: ${[...ALLOWED_MODULES].filter((m) => !m.startsWith('node:')).join(', ')}`,
              ),
              { name: 'ModuleNotAllowedError' },
            )
          }
          if (specifier === 'fs' || specifier === 'node:fs') {
            return Promise.resolve(this.scopedFs)
          }
          return import(specifier)
        },
        ...usefulGlobals,
        ...this.sandboxTimerGlobals,
        // Expose process with safety overrides:
        // - cwd() returns the session's cwd instead of the relay server's cwd
        // - exit() is blocked to prevent killing the relay server
        // - chdir() is blocked to prevent affecting other sessions
        // - getBuiltinModule() is blocked because it bypasses ALLOWED_MODULES (issue #105)
        //   Uses getOwnPropertyDescriptor trap too, otherwise
        //   Object.getOwnPropertyDescriptor(process, 'getBuiltinModule').value() bypasses get trap
        process: new Proxy(process, {
          get(target, prop, receiver) {
            if (prop === 'cwd') return () => self.sessionCwd || target.cwd()
            if (prop === 'exit') return () => { throw new Error('process.exit() is not allowed in the sandbox') }
            if (prop === 'chdir') return () => { throw new Error('process.chdir() is not allowed in the sandbox, use a new session with a different cwd instead') }
            if (prop === 'getBuiltinModule') return sandboxedGetBuiltinModule
            return Reflect.get(target, prop, receiver)
          },
          // Prevent Object.getOwnPropertyDescriptor(process, 'getBuiltinModule').value()
          // from bypassing the Proxy get trap
          getOwnPropertyDescriptor(target, prop) {
            const desc = Object.getOwnPropertyDescriptor(target, prop)
            if (!desc) return desc
            if (prop === 'getBuiltinModule') {
              return { ...desc, value: sandboxedGetBuiltinModule }
            }
            return desc
          },
        }),
      }

      const vmContext = vm.createContext(vmContextObj)
      // No default page: reading `page` throws so agents pick or create their own tab.
      // The getter lives on the global's prototype, inside the context: vm swallows errors thrown by
      // sandbox getters (host-side always, own properties of globalThis too since Node 26), and the
      // global would just read as "page is not defined".
      vm.runInContext(
        `Object.setPrototypeOf(globalThis, Object.create(Object.getPrototypeOf(globalThis), { page: { get() { throw new Error(${JSON.stringify(PAGE_GLOBAL_REMOVED_ERROR)}) } } }))`,
        vmContext,
      )
      const sandboxEntryPath = path.join(this.sessionCwd || process.cwd(), SANDBOX_FILENAME)
      const autoReturnExpr = getAutoReturnExpression(code)
      const wrappedCode = autoReturnExpr !== null
        ? `(async () => { return await (${autoReturnExpr}) })()`
        : `(async () => { ${code} })()`
      const hasExplicitReturn = autoReturnExpr !== null || /\breturn\b/.test(code)
      // Native imports use normal Node permissions and resolve from the session cwd.
      const script = new vm.Script(wrappedCode, {
        filename: sandboxEntryPath,
        importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      })

      // Track execution timestamps relative to recording start (seconds).
      // Used to identify idle gaps that can be sped up in demo videos.
      // Captured before execution so we can record timing even if it throws.
      const recordingStartSnapshot = this.recordingStartedAt
      const execStartSec = recordingStartSnapshot !== null
        ? (Date.now() - recordingStartSnapshot) / 1000
        : -1

      scriptStartedAt = Date.now()
      this.navigatedPages = new Set()
      const result = await (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let onCallerAbort: (() => void) | undefined
        try {
          const chromium = await getChromium({ patchright: this.patchright })
          if (signal?.aborted) {
            throw new ExecuteCancelledError()
          }
          // Runs in this executor's async context, so a forgotten await becomes a warning in this session.
          const runScript = () =>
            runAsFaultOwner({ owner: this, run: () => script.runInContext(vmContext, { timeout, displayErrors: true }) })
          return await Promise.race([
            chromium.runWithAbortSignal(abortController.signal, runScript),
            new Promise((_, reject) => {
              // The race does not stop the script. Abort it so its running and later Playwright calls fail.
              const stop = (error: Error) => {
                abortController.abort(error)
                reject(error)
              }
              timer = setTimeout(() => {
                stop(new CodeExecutionTimeoutError(timeout))
              }, timeout)
              onCallerAbort = () => {
                stop(new ExecuteCancelledError())
              }
              signal?.addEventListener('abort', onCallerAbort, { once: true })
            }),
          ])
        } finally {
          clearTimeout(timer)
          if (onCallerAbort) {
            signal?.removeEventListener('abort', onCallerAbort)
          }
          // Record timestamp even on error — the execution still occupied real time
          // that should not be sped up in the demo video.
          // Compare against snapshot to avoid cross-session contamination if
          // recording was stopped and restarted inside the same execute() call.
          if (recordingStartSnapshot !== null && execStartSec >= 0 && this.recordingStartedAt === recordingStartSnapshot) {
            const execEndSec = (Date.now() - recordingStartSnapshot) / 1000
            this.executionTimestamps.push({ start: execStartSec, end: execEndSec })
          }
        }
      })()

      let returnText = ''
      // Only show return value if user explicitly used return
      if (hasExplicitReturn) {
        const resolvedResult = isPromise(result) ? await result : result
        // Auto-returned Playwright handles (Response, Page, Browser, Request,
        // Frame, etc.) are silently skipped — they're programmatic references,
        // not useful display data. Users can `console.log(response)` or
        // return specific fields (`return response.url()`) to see values.
        // See issue #82.
        if (resolvedResult !== undefined && !isPlaywrightChannelOwner(resolvedResult)) {
          const formatted = formatValue(resolvedResult)
          if (formatted.trim()) {
            returnText = `[return value] ${formatted}\n`
          }
        }
      }

      await this.reportBotChallenges({ pages: this.navigatedPages, deadline: challengeDeadline(), signal })

      const responseText = boundExecuteOutput({
        before: this.flushOutputForScope(outputScope) + formatConsoleLogs({ logs: consoleLogs }),
        after: returnText,
      })
      const finalText = responseText.trim() || 'Code executed successfully (no output)'

      const images = [
        ...screenshotCollector.map((s) => ({ data: s.base64, mimeType: s.mimeType })),
        ...resizedImageCollector,
      ]
      const screenshots: ExecuteScreenshot[] = screenshotCollector.map((s) => ({
        path: s.path,
        base64: s.base64,
        mimeType: s.mimeType,
        snapshot: s.snapshot,
        labelCount: s.labelCount,
      }))

      return { text: finalText, images, screenshots, isError: false }
    } catch (error: any) {
      const errorStack = error.stack || error.message
      const isExecutionTimeout =
        error instanceof CodeExecutionTimeoutError || error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
      const isTimeoutError =
        isExecutionTimeout ||
        error instanceof ExecuteCancelledError ||
        error?.name === 'TimeoutError' ||
        error?.name === 'AbortError'

      this.logger.error('Error in execute:', errorStack)

      if (error instanceof ExecuteCancelledError && handoffPages.size > 0) {
        const chromium = await getChromium({ patchright: this.patchright })
        await chromium.runWithAbortSignal(AbortSignal.timeout(1000), () => {
          return Promise.all([...handoffPages].map((page) => clearHandoff({ page })))
        }).catch(() => {})
      }

      // A failed action often means a challenge appeared, also without a navigation, so check state pages too.
      if (this.navigatedPages && !(error instanceof ExecuteCancelledError)) {
        const statePages = Object.values(this.userState).filter((value) => this.pagesWithListeners.has(value))
        await this.reportBotChallenges({
          pages: new Set([...this.navigatedPages, ...statePages]),
          // The call already failed, often by timing out behind a captcha: allow one probe even with no time left.
          deadline: Math.max(challengeDeadline(), Date.now() + PROBE_TIMEOUT_MS),
          signal,
        })
      }

      const logsText = formatConsoleLogs({ logs: consoleLogs, title: 'Console output (before error)' })
      const outputText = this.flushOutputForScope(outputScope)

      const coveringDialog = /intercepts pointer events/.test(error instanceof Error ? error.message : String(error))
        ? await this.describeOpenDialog()
        : undefined
      const resetHint = (() => {
        const message = error instanceof Error ? error.message : String(error)
        if (/intercepts pointer events/.test(message)) {
          if (coveringDialog === undefined) {
            // No dialog: often a control that only shows on hover, such as a message's menu button.
            return '\n\n[HINT: Another element covers the target and no dialog is open. If the covering element is part of the same row or label, click that element. A control that shows only on hover can be used from the keyboard: await element.focus(); await page.keyboard.press(\'Enter\'). Then take a snapshot to see what opened.]'
          }
          const dialog = coveringDialog ? `the dialog "${coveringDialog}"` : 'an open dialog'
          return `\n\n[HINT: The target is covered by ${dialog}. Find it with snapshot({ page, search: /dialog|modal/i }) and close or answer it first.]`
        }
        // Snapshot roles come from Chrome. Playwright computes its own, and the two differ for some elements,
        // such as an editable div without a role.
        if (/Timeout \d+ms exceeded/.test(message) && /waiting for .*getByRole\(/.test(message)) {
          return '\n\n[HINT: No element matched this role and name. If it came from a snapshot, act on its ref instead: elementForRef({ ref, page }). Chrome and Playwright can name the role differently.]'
        }
        if (/\b(?:Target|Page) crashed\b/i.test(message)) {
          return '\n\n[HINT: This tab crashed. Create a new tab with context.newPage(), replace the crashed reference in state, and navigate to the intended URL. Do not reset the session or repeat the last script: first check whether its actions completed.]'
        }
        if (/Target page, context or browser has been closed/i.test(message) && this.browser?.isConnected()) {
          return '\n\n[HINT: This page reference is closed, but the browser is connected. Select an open page from context.pages() or create one with context.newPage(), then replace the closed reference in state. Do not reset the whole session.]'
        }
        if (/net::ERR_/i.test(message)) {
          return '\n\n[HINT: Navigation failed. Check page.url() and the network error before retrying. Do not reset the session or replay a script that may have submitted a form or changed data.]'
        }
        if (isTimeoutError) return ''
        if (NAVIGATION_RACE_ERROR.test(message)) {
          return '\n\n[HINT: The page navigated while this ran. Wait for it to load, then run the step again. Do not reset the session.]'
        }
        // A script's own error (a TypeError, a denied file path) is not a connection problem: no reset advice.
        if (!/Protocol error|Target closed|has been closed|WebSocket|Connection closed|Session closed|not connected|ECONNREFUSED|ECONNRESET|socket hang up|Internal error/i.test(message)) {
          return ''
        }
        return '\n\n[HINT: If this is an internal Playwright error, page/browser closed, or connection issue, call reset to reconnect.]'
      })()

      // timeout stacks are internal noise (Promise.race / setTimeout); only show the message
      // Playwright dims its call log with ANSI codes: noise when the reader is not a terminal.
      const errorText = (isTimeoutError ? error.message : errorStack).replace(/\u001b\[[0-9;]*m/g, '')
      return {
        text: boundExecuteOutput({
          before: outputText + logsText,
          after: `\nError executing code: ${errorText}${resetHint}`,
        }),
        images: [],
        screenshots: [],
        isError: true,
      }
    } finally {
      this.navigatedPages = null
    }
  }

  /** Name of a dialog that is open on one of the session's pages: '' when it has none, undefined when no dialog is open. */
  private async describeOpenDialog(): Promise<string | undefined> {
    const pages = Object.values(this.userState).filter((value): value is Page => this.pagesWithListeners.has(value))
    for (const page of pages) {
      const name = await Promise.race([
        page.evaluate(() => {
          const doc = (globalThis as any).document
          const dialog = [...doc.querySelectorAll('[role=dialog][aria-modal=true],[role=alertdialog],dialog[open]')].find((element: any) => {
            return element.getClientRects().length > 0
          }) as any
          if (!dialog) {
            return undefined
          }
          const labelledBy = dialog.getAttribute('aria-labelledby')
          const label = dialog.getAttribute('aria-label') || (labelledBy && doc.getElementById(labelledBy.split(' ')[0])?.textContent) || ''
          return String(label).trim().slice(0, 80)
        }),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 500)),
      ]).catch(() => undefined)
      if (name !== undefined) {
        return name
      }
    }
    return undefined
  }

  private async reportBotChallenges({
    pages,
    deadline,
    signal,
  }: {
    pages: Set<Page> | null
    deadline: number
    signal?: AbortSignal
  }) {
    if (!pages || pages.size === 0) {
      return
    }
    const probeStartedAt = Date.now()
    const outcomes = await Promise.all(
      [...pages].map((page) => {
        return detectChallenge({ page, deadline, signal }).catch(() => undefined)
      }),
    )
    const probeMs = Date.now() - probeStartedAt
    if (probeMs >= 100) {
      this.logger.log(`[Executor] Bot challenge check took ${probeMs}ms for ${pages.size} page(s)`)
    }
    for (const outcome of outcomes) {
      if (!outcome) {
        continue
      }
      this.logger.log(`[Executor] Bot challenge ${outcome.status}: ${outcome.vendor} ${outcome.kind} after ${outcome.waitedMs}ms`)
      const warning = challengeWarning(outcome)
      if (warning) {
        this.enqueueWarning(warning)
      }
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise
    }

    this.disposing = true
    this.disposePromise = this.runExclusive({
      allowDuringDispose: true,
      operation: async () => {
        if (this.isHeadlessMode()) {
          await this.closeHeadlessContext()
        } else {
          await this.browser?.close().catch((error) => {
            this.logger.error('Error disconnecting deleted session:', error)
          })
          this.clearConnectionState()
        }
        this.clearExecutionState()
      },
    })
    return this.disposePromise
  }

  /** Get keys of user-defined state */
  getStateKeys(): string[] {
    return Object.keys(this.userState)
  }

  getSessionMetadata(): SessionMetadata {
    return this.sessionMetadata
  }

  getSessionInfo({ id }: { id: string }): SessionInfo {
    return {
      id,
      idleMs: this.idleMs(),
      stateKeys: this.getStateKeys(),
      extensionId: this.sessionMetadata.extensionId,
      browser: this.sessionMetadata.browser,
      profile: this.sessionMetadata.profile,
      cwd: this.sessionCwd,
      tabGroup: this.cdpConfig.tabGroup || null,
      tabGroupColor: this.cdpConfig.tabGroupColor || null,
      patchright: this.patchright,
    }
  }

  getConnectedPages(): Page[] | undefined {
    return this.browser?.contexts()[0]?.pages()
  }

  getTabGroup(): string | null {
    return this.cdpConfig.tabGroup || null
  }

  getTabGroupColor(): TabGroupColor | null {
    return this.cdpConfig.tabGroupColor || null
  }

  /** Change the tab group future connections/tabs of this session use.
   *  Existing relay clients are updated separately via updateClientsTabGroup.
   *  Absent fields keep their current value. */
  setTabGroupConfig({ tabGroup, tabGroupColor }: { tabGroup?: string; tabGroupColor?: TabGroupColor }): void {
    this.cdpConfig = {
      ...this.cdpConfig,
      tabGroup: tabGroup ?? this.cdpConfig.tabGroup,
      tabGroupColor: tabGroupColor ?? this.cdpConfig.tabGroupColor,
    }
  }
}

/**
 * Session manager for multiple executors, keyed by session ID.
 */
export class ExecutorManager {
  private executors = new Map<string, PlaywrightExecutor>()
  private cdpConfig: CdpConfig | ((sessionId: string) => CdpConfig)
  private logger: ExecutorLogger

  constructor(options: { cdpConfig: CdpConfig | ((sessionId: string) => CdpConfig); logger?: ExecutorLogger }) {
    this.cdpConfig = options.cdpConfig
    this.logger = options.logger || { log: console.log, error: console.error }
  }

  getExecutor(options: {
    sessionId: string
    cwd?: string
    sessionMetadata?: SessionMetadata
    /** Override cdpConfig for this session (e.g. direct CDP connection) */
    cdpConfig?: CdpConfig
    /** Tab group title new tabs of this session join (extension mode only) */
    tabGroup?: string
    /** Explicit tab group color (extension mode only) */
    tabGroupColor?: TabGroupColor
    /** Connect with Patchright instead of Playwright */
    patchright?: boolean
  }): PlaywrightExecutor {
    const { sessionId, cwd, sessionMetadata } = options
    let executor = this.executors.get(sessionId)
    if (!executor) {
      const cdpConfig = (() => {
        // Per-session override takes priority (used for direct CDP sessions)
        if (options.cdpConfig) {
          return options.cdpConfig
        }
        const baseConfig: CdpConfig = {
          ...(typeof this.cdpConfig === 'function' ? this.cdpConfig(sessionId) : this.cdpConfig),
          sessionId,
          tabGroup: options.tabGroup || undefined,
          tabGroupColor: options.tabGroupColor || undefined,
        }
        if (sessionMetadata?.extensionId) {
          return { ...baseConfig, extensionId: sessionMetadata.extensionId }
        }
        return baseConfig
      })()
      executor = new PlaywrightExecutor({
        cdpConfig,
        sessionMetadata,
        logger: this.logger,
        cwd,
        patchright: options.patchright,
      })
      this.executors.set(sessionId, executor)
    }
    return executor
  }

  async deleteExecutor(sessionId: string): Promise<boolean> {
    const executor = this.executors.get(sessionId)
    if (!executor) {
      return false
    }
    this.executors.delete(sessionId)
    await executor.dispose()
    return true
  }

  /** Delete headless sessions idle longer than idleTimeoutMs. The shared headless
   *  Chrome closes with the last headless session. Returns the deleted session IDs. */
  async deleteIdleHeadlessSessions({ idleTimeoutMs }: { idleTimeoutMs: number }): Promise<string[]> {
    const deleted: string[] = []
    for (const [sessionId, executor] of [...this.executors]) {
      // Re-check per session: deleting earlier ones awaits, and new executes may start meanwhile
      if (!executor.isHeadlessMode() || executor.idleMs() <= idleTimeoutMs) {
        continue
      }
      if (await this.deleteExecutor(sessionId)) {
        deleted.push(sessionId)
      }
    }
    return deleted
  }

  async disposeAll(): Promise<void> {
    const executors = [...this.executors.values()]
    this.executors.clear()
    await Promise.all(
      executors.map((executor) => {
        return executor.dispose()
      }),
    )
  }

  getSession(sessionId: string): PlaywrightExecutor | null {
    return this.executors.get(sessionId) || null
  }

  listSessions(): SessionInfo[] {
    return [...this.executors.entries()].map(([id, executor]) => {
      return executor.getSessionInfo({ id })
    })
  }
}
