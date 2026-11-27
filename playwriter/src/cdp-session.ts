import crypto from 'node:crypto'
import type { Frame, Page, CDPSession as PlaywrightCDPSession } from '@xmorse/playwright-core'
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js'

/**
 * Type-safe CDP session interface using devtools-protocol ProtocolMapping.
 * Provides autocomplete and type checking for CDP commands and events.
 * Return types are inferred from the command string (e.g. 'Page.getLayoutMetrics'
 * returns Protocol.Page.GetLayoutMetricsResponse).
 */
export interface ICDPSession {
  send<K extends keyof ProtocolMapping.Commands>(
    method: K,
    params?: ProtocolMapping.Commands[K]['paramsType'][0],
    sessionId?: string | null,
  ): Promise<ProtocolMapping.Commands[K]['returnType']>

  on<K extends keyof ProtocolMapping.Events>(
    event: K,
    callback: (params: ProtocolMapping.Events[K][0]) => void,
  ): unknown

  off<K extends keyof ProtocolMapping.Events>(
    event: K,
    callback: (params: ProtocolMapping.Events[K][0]) => void,
  ): unknown

  detach(): Promise<void>
  getSessionId?(): string | null
  /** Names the Chrome target behind this session, the same for every relay session using that target. See cdp-domains.ts */
  domainKey?: string
}

/**
 * Wraps Playwright's CDPSession (from context.getExistingCDPSession) into an ICDPSession.
 * This reuses Playwright's internal CDP WebSocket instead of creating a new one,
 * which is important for the relay server where Target.attachToTarget is intercepted.
 */
export class PlaywrightCDPSessionAdapter implements ICDPSession {
  private _playwrightSession: PlaywrightCDPSession
  domainKey?: string

  constructor(playwrightSession: PlaywrightCDPSession, domainKey?: string) {
    this._playwrightSession = playwrightSession
    this.domainKey = domainKey
  }

  async send<K extends keyof ProtocolMapping.Commands>(
    method: K,
    params?: ProtocolMapping.Commands[K]['paramsType'][0],
  ): Promise<ProtocolMapping.Commands[K]['returnType']> {
    return await this._playwrightSession.send(method as never, params as never)
  }

  on<K extends keyof ProtocolMapping.Events>(event: K, callback: (params: ProtocolMapping.Events[K][0]) => void): this {
    this._playwrightSession.on(event as never, callback as never)
    return this
  }

  off<K extends keyof ProtocolMapping.Events>(
    event: K,
    callback: (params: ProtocolMapping.Events[K][0]) => void,
  ): this {
    this._playwrightSession.off(event as never, callback as never)
    return this
  }

  async detach(): Promise<void> {
    await this._playwrightSession.detach()
  }
}

/**
 * Gets a CDP session for a page by reusing Playwright's internal existing CDP session.
 * This uses the same WebSocket Playwright already has, avoiding new connections.
 * Works through the relay because it doesn't call Target.attachToTarget.
 */
export async function getCDPSessionForPage({ page }: { page: Page }): Promise<PlaywrightCDPSessionAdapter> {
  // Cached: every getExistingCDPSession call chains one more event forwarder onto the page session for good.
  let session = cdpSessions.get(page)
  if (!session) {
    session = page
      .context()
      .getExistingCDPSession(page)
      .then((playwrightSession) => new PlaywrightCDPSessionAdapter(playwrightSession, targetKey(page)))
    cdpSessions.set(page, session)
    session.catch(() => cdpSessions.delete(page))
  }
  return await session
}

function targetKey(page: Page, frame?: Frame): string | undefined {
  try {
    return frame ? `${page.targetId()}:${frame.frameId()}` : page.targetId()
  } catch {
    return undefined
  }
}

const cdpSessions = new WeakMap<Page, Promise<PlaywrightCDPSessionAdapter>>()
const frameSessions = new WeakMap<Frame, Promise<PlaywrightCDPSessionAdapter | null>>()
const observedPages = new WeakSet<Page>()

/** Use the renderer that owns this frame, including frames nested inside an OOPIF. */
export async function getCDPSessionForFrame(frame: Frame): Promise<PlaywrightCDPSessionAdapter> {
  const page = frame.page()
  if (frame === page.mainFrame()) return getCDPSessionForPage({ page })
  if (!observedPages.has(page)) {
    observedPages.add(page)
    page.on('framenavigated', (child) => frameSessions.delete(child))
    page.on('framedetached', (child) => frameSessions.delete(child))
  }
  for (let child: Frame | null = frame; child?.parentFrame(); child = child.parentFrame()) {
    const owner = child
    let session = frameSessions.get(owner)
    if (!session) {
      session = page.context().getExistingCDPSession(owner).then(
        (cdp) => new PlaywrightCDPSessionAdapter(cdp, targetKey(page, owner)),
        (error) => {
          if (!String(error).includes('does not have a separate CDP session')) {
            frameSessions.delete(owner)
            throw error
          }
          return null
        },
      )
      frameSessions.set(owner, session)
    }
    const resolved = await session
    if (resolved) return resolved
  }
  return getCDPSessionForPage({ page })
}

/** Isolated world for playwriter's own page scripts. Pages cannot see its globals or calls. */
export const PLAYWRITER_WORLD_NAME = `playwriter_${crypto.randomUUID().replaceAll('-', '')}`

/**
 * Evaluates an expression in playwriter's isolated world of the page's main frame and returns the value.
 * Page.createIsolatedWorld returns the same world for the same name until the document changes, so state
 * (like the ghost cursor) lives until the next navigation. Use it instead of page.evaluate for scripts that
 * must stay invisible to anti-bot code: the main world lets pages hook DOM APIs and read foreign call stacks.
 */
export async function evaluateInPlaywriterWorld<T>({
  page,
  expression,
  awaitPromise = false,
}: {
  page: Page
  expression: string
  awaitPromise?: boolean
}): Promise<T> {
  const cdp = await getCDPSessionForPage({ page })
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
    frameId: page.mainFrame().frameId(),
    worldName: PLAYWRITER_WORLD_NAME,
  })
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    contextId: executionContextId,
    returnByValue: true,
    awaitPromise,
    silent: true,
  })
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description || exceptionDetails.text)
  }
  return result.value as T
}
