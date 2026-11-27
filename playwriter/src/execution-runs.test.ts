import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createExecutionId, ExecutionRuns, executionStatus, getExecutionRelayId, isExecutionId } from './execution-runs.js'

describe('execution history', () => {
  it('retains one run for duplicate submissions in a session', () => {
    const history = new ExecutionRuns()
    const relayId = randomUUID()
    const executionId = createExecutionId(relayId)
    expect(getExecutionRelayId(executionId)).toBe(relayId)
    expect(isExecutionId(executionId)).toBe(true)

    const entry = history.begin('1', executionId)!
    expect(entry.duplicate).toBe(false)
    expect(executionStatus(entry.run)).toEqual({ executionId, state: 'queued' })
    history.start('1', entry.run)
    expect(history.begin('1', executionId)).toEqual({ run: entry.run, duplicate: true })
    history.finish('1', entry.run, 'completed')
    expect(executionStatus(history.find('1', executionId)!)).toEqual({ executionId, state: 'completed' })
    expect(history.begin('1', executionId)).toEqual({ run: entry.run, duplicate: true })
    expect(history.find('2', executionId)).toBeUndefined()

    history.deleteSession('1')
    expect(history.find('1', executionId)).toBeUndefined()
  })

  it('rejects an evicted ID without re-executing it', () => {
    const history = new ExecutionRuns()
    let time = 1_790_000_000_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => time++)
    try {
      const first = createExecutionId()
      history.finish('1', history.begin('1', first)!.run, 'completed')
      for (let index = 0; index < 128; index++) {
        const active = history.begin('1', createExecutionId())!
        expect(active.duplicate).toBe(false)
        history.finish('1', active.run, 'completed')
      }
      expect(history.find('1', first)).toBeUndefined()
      expect(history.begin('1', first)).toBeUndefined()
    } finally {
      clock.mockRestore()
    }
  })

  it('selects the waiting execution for a shared tab in the same profile', () => {
    const history = new ExecutionRuns()
    const target = { extensionKey: 'test-profile', targetId: 'test-tab' }
    const first = history.begin('1', createExecutionId())!.run
    const waiting = history.begin('2', createExecutionId())!.run
    history.start('1', first)
    history.start('2', waiting)
    first.target = target
    waiting.target = target
    waiting.waiting = true

    expect(history.forTarget(target)).toBe(waiting)
    expect(history.forTarget({ ...target, extensionKey: 'other-profile' })).toBeUndefined()
    history.finish('2', waiting, 'cancelled')
    expect(history.forTarget(target)).toBe(first)
  })
})
