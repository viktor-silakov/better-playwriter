// Verifies CLI subprocess behavior and error output.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, test } from 'vitest'

const execFileAsync = promisify(execFile)
const currentDir = path.dirname(fileURLToPath(import.meta.url))
const playwriterDir = path.resolve(currentDir, '..')
const viteNodeBinary = path.join(
  playwriterDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vite-node.cmd' : 'vite-node',
)

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(viteNodeBinary, ['src/cli.ts', ...args], {
    cwd: playwriterDir,
    env: process.env,
  })
}

describe('better-playwriter CLI help', () => {
  test('renders root help without crashing', async () => {
    const { stdout, stderr } = await runCli(['--help'])

    expect(stdout).toContain('better-playwriter')
    expect(stdout).toContain('serve')
    expect(stderr).toBe('')
  }, 30000)

  test('prints the fork version on one line', async () => {
    const { stdout, stderr } = await runCli(['--version'])

    expect(stdout.trim()).toMatch(/^better-playwriter\/[^\r\n]+$/)
    expect(stderr).toBe('')
  }, 30000)

  test('renders serve help without crashing', async () => {
    const { stdout, stderr } = await runCli(['serve', '--help'])

    expect(stdout).toContain('Start the relay server on this machine')
    expect(stdout).toContain('--replace')
    expect(stderr).toBe('')
  }, 30000)

  test('unknown command exits with code 1', async () => {
    try {
      await runCli(['run'])
      expect.unreachable('should have thrown')
    } catch (error: any) {
      expect(error.code).toBe(1)
      expect(error.stderr).toContain('Unknown command: run')
      expect(error.stderr).toContain('better-playwriter --help')
    }
  }, 30000)

  test('unknown subcommand exits with code 1', async () => {
    try {
      await runCli(['session', 'nonexistent'])
      expect.unreachable('should have thrown')
    } catch (error: any) {
      expect(error.code).toBe(1)
      expect(error.stdout).toContain('Unknown command: session nonexistent')
      expect(error.stdout).toContain('session new')
    }
  }, 30000)

  test('reports a structured error when no extension is connected', async () => {
    const port = 19995
    const { startPlayWriterCDPRelayServer } = await import('./cdp-relay.js')
    const server = await startPlayWriterCDPRelayServer({ port })

    try {
      const emptyHome = path.join(playwriterDir, 'tmp', 'missing-home')
      await execFileAsync(
        viteNodeBinary,
        ['src/cli.ts', 'session', 'new', '--host', `http://127.0.0.1:${port}`],
        {
          cwd: playwriterDir,
          env: {
            ...process.env,
            HOME: emptyHome,
            USERPROFILE: emptyHome,
            BETTER_PLAYWRITER_API_KEY: '',
            BETTER_PLAYWRITER_CLOUD_TOKEN: '',
            BETTER_PLAYWRITER_STORE_ID: 'not-configured',
          },
        },
      )
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toMatchObject({
        code: 1,
        stderr: expect.stringContaining('ERROR code=extension_not_connected'),
      })
      expect((error as { stderr: string }).stderr).toContain('Load the Better Playwriter extension in chrome://extensions/')
    } finally {
      server.close()
    }
  }, 30000)
})
