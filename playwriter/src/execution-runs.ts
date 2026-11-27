import { randomUUID } from 'node:crypto'

const MAX_RUNS_PER_SESSION = 128
const UUID_PATTERN = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
const EXECUTION_ID_PATTERN = new RegExp(`^(?:(${UUID_PATTERN})\\.)?(\\d{13})-${UUID_PATTERN}$`)

export type ExecutionState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export type ExecutionStatus = {
  executionId: string
  state: ExecutionState
}

export function createExecutionId(relayInstanceId?: string): string {
  const id = `${Date.now()}-${randomUUID()}`
  return relayInstanceId ? `${relayInstanceId}.${id}` : id
}

export function isExecutionId(value: unknown): value is string {
  return typeof value === 'string' && EXECUTION_ID_PATTERN.test(value)
}

export function getExecutionRelayId(executionId: string): string | undefined {
  return EXECUTION_ID_PATTERN.exec(executionId)?.[1]
}

function getExecutionIssuedAt(executionId: string): number {
  return Number(EXECUTION_ID_PATTERN.exec(executionId)?.[2])
}

type ExecutionTarget = { extensionKey: string; targetId: string }

export type ExecutionRun = {
  executionId: string
  state: ExecutionState
  controller: AbortController
  target?: ExecutionTarget
  waiting?: boolean
}

type SessionRuns = {
  runs: Map<string, ExecutionRun>
  evictedThrough: number
}

export class ExecutionRuns {
  private readonly sessions = new Map<string, SessionRuns>()
  private readonly running = new Map<string, ExecutionRun>()

  begin(sessionId: string, executionId: string): { run: ExecutionRun; duplicate: boolean } | undefined {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = { runs: new Map(), evictedThrough: 0 }
      this.sessions.set(sessionId, session)
    }
    const existing = session.runs.get(executionId)
    if (existing) return { run: existing, duplicate: true }

    const issuedAt = getExecutionIssuedAt(executionId)
    if (issuedAt <= session.evictedThrough) return undefined
    if (session.runs.size >= MAX_RUNS_PER_SESSION) {
      const completed = [...session.runs.values()].find((run) => run.state !== 'queued' && run.state !== 'running')
      if (!completed) return undefined
      const evictedAt = getExecutionIssuedAt(completed.executionId)
      if (issuedAt <= evictedAt) return undefined
      session.runs.delete(completed.executionId)
      session.evictedThrough = Math.max(session.evictedThrough, evictedAt)
    }

    const run: ExecutionRun = { executionId, state: 'queued', controller: new AbortController() }
    session.runs.set(executionId, run)
    return { run, duplicate: false }
  }

  start(sessionId: string, run: ExecutionRun): void {
    run.state = 'running'
    this.running.set(sessionId, run)
  }

  finish(sessionId: string, run: ExecutionRun, state: 'completed' | 'failed' | 'cancelled'): void {
    run.state = state
    if (this.running.get(sessionId) === run) this.running.delete(sessionId)
  }

  current(sessionId: string): ExecutionRun | undefined {
    return this.running.get(sessionId)
  }

  find(sessionId: string, executionId: string): ExecutionRun | undefined {
    return this.sessions.get(sessionId)?.runs.get(executionId)
  }

  forTarget(target: ExecutionTarget): ExecutionRun | undefined {
    let running: ExecutionRun | undefined
    for (const run of this.running.values()) {
      if (!sameExecutionTarget(run.target, target)) continue
      if (run.waiting) return run
      running ??= run
    }
    return running
  }

  targetsForExtension(extensionKey: string): ExecutionTarget[] {
    return [...this.running.values()].flatMap((run) => {
      return run.target?.extensionKey === extensionKey ? [run.target] : []
    })
  }

  deleteSession(sessionId: string): void {
    this.running.delete(sessionId)
    this.sessions.delete(sessionId)
  }
}

export function executionStatus(run: ExecutionRun): ExecutionStatus {
  return { executionId: run.executionId, state: run.state }
}

export function sameExecutionTarget(a: ExecutionTarget | undefined, b: ExecutionTarget): boolean {
  return a?.extensionKey === b.extensionKey && a.targetId === b.targetId
}
