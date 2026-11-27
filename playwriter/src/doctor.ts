import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveBrowserExecutablePath } from './browser-config.js'
import { checkMacAccessibility } from './profile-identify.js'
import { readLocalProfileNames } from './profile-labels.js'
import { getExtensionOutdatedWarning, getLocalExtensionStatuses, getRelayInfo, RELAY_PORT } from './relay-client.js'
import { fetchExtensionsStatus, type RelayTarget } from './relay-sessions.js'
import { LOG_CDP_FILE_PATH, LOG_FILE_PATH, VERSION } from './utils.js'

export async function diagnoseLocalRelay({ browser, token }: { browser?: string; token?: string }) {
  const relay: RelayTarget = { host: '127.0.0.1', token }
  const run = promisify(execFile)
  const [info, extensions, accessibility, ffmpeg] = await Promise.all([
    getRelayInfo(),
    fetchExtensionsStatus(relay),
    checkMacAccessibility(),
    run('ffmpeg', ['-version'], { timeout: 2000 }).then(() => true, () => false),
  ])
  const names = readLocalProfileNames()
  const profiles = getLocalExtensionStatuses(extensions).map((extension) => {
    const key = extension.stableKey || extension.extensionId
    return {
      key,
      browser: extension.browser,
      profileName: names[key] || null,
      tabs: extension.activeTabs ?? extension.activeTargets,
      version: extension.playwriterVersion,
      warning: getExtensionOutdatedWarning(extension.playwriterVersion),
    }
  })
  const matching = browser ? profiles.filter((profile) => profile.key === browser || profile.profileName === browser) : profiles
  const messages: string[] = []
  if (!info) {
    messages.push('Relay is not responding. Run better-playwriter session new to start it.')
  } else if (browser && !matching.length) {
    messages.push('The requested profile is not connected. Open it and check Better Playwriter is enabled.')
  } else if (browser && matching.length > 1) {
    messages.push('Several Chrome profiles have this name. Pass the exact browser key with --browser.')
  } else if (!profiles.length) {
    messages.push('No extension is connected. Enable Better Playwriter in the Chrome profile you want to use.')
  } else if (matching.every((profile) => !profile.tabs)) {
    messages.push('No tabs are attached. Click the Better Playwriter icon on a tab in the selected profile.')
  }
  const ready = messages.length === 0
  if (accessibility === false) {
    messages.push('To read Chrome profile names, grant Accessibility access to the app running Better Playwriter.')
  }
  let managedChrome: string | null = null
  try {
    managedChrome = resolveBrowserExecutablePath({})
  } catch {
    // Chrome for Testing is optional when using an existing Chrome profile.
  }
  return {
    ready,
    cliVersion: VERSION,
    relay: { port: RELAY_PORT, version: info?.version ?? null },
    profiles: matching,
    accessibility,
    managedChrome,
    ffmpeg,
    logs: { relay: LOG_FILE_PATH, cdp: LOG_CDP_FILE_PATH },
    messages,
  }
}
