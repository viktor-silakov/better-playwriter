import { readEnv } from './runtime-config.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { findInstalledChrome } from './browser-install.js'
// NOTE: browser-config uses chromium synchronously (executablePath) during browser start.
// Patchright mode only affects connectOverCDP in executor.ts, not browser binary lookup.

type BrowserLookupOptions = {
  browserPath?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  homeDir?: string
  existsSync?: (filePath: string) => boolean
}

function expandHomeDirectory({ filePath, homeDir }: { filePath: string; homeDir: string }): string {
  if (!filePath.startsWith('~/')) {
    return filePath
  }
  return path.join(homeDir, filePath.slice(2))
}

function dedupePaths(pathsToCheck: string[]): string[] {
  return Array.from(new Set(pathsToCheck))
}

// Loading playwright-core takes about 300 ms, so it is the last place asked and only when nothing else matched.
function getPlaywrightChromiumCandidate(): string[] {
  const { chromium }: typeof import('@xmorse/playwright-core') = createRequire(import.meta.url)('@xmorse/playwright-core')
  const executablePath = chromium.executablePath()
  if (!executablePath) {
    return []
  }
  return [executablePath]
}

function getPathEntries(env: NodeJS.ProcessEnv): string[] {
  const rawPath = env.PATH || env.Path || ''
  return rawPath
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => {
      return entry.trim()
    })
}

function getExecutableNames(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    return ['chrome.exe', 'chromium.exe']
  }
  return ['chrome', 'chromium', 'chromium-browser']
}

function getPathExecutableCandidates({
  platform,
  env,
}: {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
}): string[] {
  const executableNames = getExecutableNames(platform)
  return getPathEntries(env).flatMap((entry) => {
    return executableNames.map((name) => {
      return path.join(entry, name)
    })
  })
}

export function getBrowserExecutableCandidates({
  platform = os.platform(),
  env = process.env,
  homeDir = os.homedir(),
  includePlaywright = true,
}: Omit<BrowserLookupOptions, 'browserPath' | 'existsSync'> & { includePlaywright?: boolean } = {}): string[] {
  const platformCandidates = (() => {
    if (platform === 'darwin') {
      return [
        '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        '~/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '~/Applications/Chromium.app/Contents/MacOS/Chromium',
      ]
    }

    if (platform === 'win32') {
      const localAppData = env.LOCALAPPDATA || ''
      const programFiles = env.PROGRAMFILES || 'C:\\Program Files'
      const programFilesX86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'

      return [
        path.join(programFiles, 'Google', 'Chrome for Testing', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Google', 'Chrome for Testing', 'Application', 'chrome.exe'),
        path.join(localAppData, 'Google', 'Chrome for Testing', 'Application', 'chrome.exe'),
        path.join(programFiles, 'Chromium', 'Application', 'chromium.exe'),
        path.join(programFilesX86, 'Chromium', 'Application', 'chromium.exe'),
        path.join(localAppData, 'Chromium', 'Application', 'chromium.exe'),
      ]
    }

    return [
      '/opt/google/chrome-for-testing/chrome',
      '/usr/local/bin/chrome',
      '/usr/bin/chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ]
  })()

  const pathCandidates = getPathExecutableCandidates({ platform, env })
  return dedupePaths(
    [...platformCandidates, ...pathCandidates, ...(includePlaywright ? getPlaywrightChromiumCandidate() : [])].map((filePath) => {
      return expandHomeDirectory({ filePath, homeDir })
    }),
  )
}

export function resolveBrowserExecutablePath({
  browserPath,
  env = process.env,
  platform = os.platform(),
  homeDir = os.homedir(),
  existsSync = fs.existsSync,
}: BrowserLookupOptions = {}): string {
  const explicitPath = browserPath?.trim()
  if (explicitPath) {
    const resolvedExplicitPath = expandHomeDirectory({ filePath: explicitPath, homeDir })
    if (!existsSync(resolvedExplicitPath)) {
      throw new Error(`Browser binary not found at: ${resolvedExplicitPath}`)
    }
    return resolvedExplicitPath
  }

  const envPath = readEnv('BROWSER_PATH', env)?.trim()
  if (envPath) {
    const resolvedEnvPath = expandHomeDirectory({ filePath: envPath, homeDir })
    if (!existsSync(resolvedEnvPath)) {
      throw new Error(`BETTER_PLAYWRITER_BROWSER_PATH does not exist: ${resolvedEnvPath}`)
    }
    return resolvedEnvPath
  }

  // Check Chrome downloaded by `better-playwriter install` first (highest priority)
  const installedChrome = findInstalledChrome()
  if (installedChrome) {
    return installedChrome
  }

  const resolvedPath =
    getBrowserExecutableCandidates({ platform, env, homeDir, includePlaywright: false }).find((candidate) => {
      return existsSync(candidate)
    })
  const candidates = resolvedPath ? [] : getBrowserExecutableCandidates({ platform, env, homeDir })
  const playwrightPath = candidates.find((candidate) => {
    return existsSync(candidate)
  })

  if (resolvedPath || playwrightPath) {
    return (resolvedPath || playwrightPath)!
  }

  const searchedPathsText = candidates.map((candidate) => {
    return `- ${candidate}`
  })

  throw new Error(
    'Could not find a supported browser binary. Run `better-playwriter browser install` to download Chrome for Testing, or pass a binary path.' +
      `\n\nSearched paths:\n- ~/.better-playwriter/browsers/ (better-playwriter browser install)\n${searchedPathsText.join('\n')}`,
  )
}

export function shouldUseHeadlessByDefault({
  platform = os.platform(),
  env = process.env,
}: Omit<BrowserLookupOptions, 'browserPath' | 'homeDir' | 'existsSync'> = {}): boolean {
  if (platform !== 'linux') {
    return false
  }

  return !env.DISPLAY && !env.WAYLAND_DISPLAY
}

export function getBrowserExecutablePath(browserPath?: string): string {
  return resolveBrowserExecutablePath({ browserPath })
}
