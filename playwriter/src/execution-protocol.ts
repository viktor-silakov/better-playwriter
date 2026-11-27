export const EXECUTION_BADGE_CAPABILITY = 'execution-badge-v1'

export type ExecutionBadge = {
  executionId: string
  state: 'running' | 'waiting'
}

export type ExecutionBadgeMessage = {
  method: 'executionBadge'
  params: { targetId: string; badge: ExecutionBadge | null }
}

export type CancelExecutionMessage = {
  method: 'cancelExecution'
  params: { targetId: string; executionId: string }
}
