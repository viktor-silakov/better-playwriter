// Kept apart from executor.ts so the MCP process can bound output without loading the executor and its parsers.

export const MAX_EXECUTE_OUTPUT_LENGTH = 10_000
// Warnings + logs get at least this share when the return value is also large
const LOGS_MIN_SHARE = 0.6

/**
 * Join execute output and truncate it once. `before` (warnings, logs) keeps its head
 * and tail; `after` (return value or error) is always appended and only cut at the end.
 */
export function boundExecuteOutput({
  before,
  after,
  maxLength = MAX_EXECUTE_OUTPUT_LENGTH,
}: {
  before: string
  after: string
  maxLength?: number
}): string {
  if (before.length + after.length <= maxLength) {
    return before + after
  }
  const beforeBudget = Math.min(before.length, Math.max(Math.floor(maxLength * LOGS_MIN_SHARE), maxLength - after.length))
  const afterBudget = maxLength - beforeBudget
  const truncatedBefore = (() => {
    if (before.length <= beforeBudget) {
      return before
    }
    // Upper bound of the marker length, so head + marker + tail fits the budget
    const keep = Math.max(0, beforeBudget - `\n... [${before.length} characters of logs omitted] ...\n`.length)
    // Cut on line boundaries unless that drops more than half of a side
    const half = Math.floor(keep / 2)
    const headNewline = before.lastIndexOf('\n', half - 1)
    const headEnd = headNewline >= half / 2 ? headNewline + 1 : half
    const tailMin = before.length - (keep - headEnd)
    const tailNewline = before.indexOf('\n', tailMin - 1)
    const tailStart =
      tailNewline !== -1 && tailNewline + 1 - tailMin <= (keep - headEnd) / 2 ? tailNewline + 1 : tailMin
    const head = before.slice(0, headEnd)
    const separator = head.endsWith('\n') || head === '' ? '' : '\n'
    return `${head}${separator}... [${tailStart - headEnd} characters of logs omitted] ...\n${before.slice(tailStart)}`
  })()
  const truncatedAfter = (() => {
    if (after.length <= afterBudget) {
      return after
    }
    return (
      after.slice(0, afterBudget) +
      `\n[Truncated to ${afterBudget} of ${after.length} characters. Use snapshot({ search }), or write large data to a file and return a summary]`
    )
  })()
  return truncatedBefore + truncatedAfter
}
