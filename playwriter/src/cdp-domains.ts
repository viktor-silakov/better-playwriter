import type { ICDPSession } from './cdp-session.js'

/**
 * CDP domains that cost the page while they stay enabled. With DOM enabled Chrome reports every DOM
 * change of the nodes a client has seen, with Accessibility it keeps the accessibility tree of the tab
 * up to date, and with CSS it tracks every stylesheet. A snapshot of a busy page left hundreds of
 * thousands of DOM events flowing through the extension and the relay.
 */
type HeldDomain = 'DOM' | 'Accessibility' | 'CSS'

// Chrome keeps one enabled state per tab for every session of this relay, so the count is shared too.
const holds = new Map<string, number>()
const objectKeys = new WeakMap<object, string>()
let objectKeyCount = 0

function holdKey(session: ICDPSession, domain: HeldDomain): string {
  let key = session.domainKey
  if (!key) {
    key = objectKeys.get(session)
    if (!key) {
      key = `session-${++objectKeyCount}`
      objectKeys.set(session, key)
    }
  }
  return `${key}\0${domain}`
}

/**
 * Enables the domains and returns a function that disables each one no other caller still holds.
 * List a domain after the ones it needs (CSS after DOM): they are released in reverse order.
 */
export async function holdDomains(session: ICDPSession, domains: HeldDomain[]): Promise<() => Promise<void>> {
  const keys = domains.map((domain) => holdKey(session, domain))
  for (const key of keys) {
    holds.set(key, (holds.get(key) ?? 0) + 1)
  }
  let released = false
  const release = async (): Promise<void> => {
    if (released) {
      return
    }
    released = true
    for (let i = domains.length - 1; i >= 0; i--) {
      const left = (holds.get(keys[i]) ?? 1) - 1
      if (left > 0) {
        holds.set(keys[i], left)
        continue
      }
      holds.delete(keys[i])
      // Best effort: the page may be gone, and Chrome refuses to disable DOM while another client uses CSS
      await session.send(`${domains[i]}.disable`).catch(() => {})
    }
  }
  try {
    for (const domain of domains) {
      await session.send(`${domain}.enable`)
    }
  } catch (error) {
    await release()
    throw error
  }
  return release
}

/** For features that need a domain for as long as the page lives, like the editor. Never released. */
export function keepDomains(session: ICDPSession, domains: HeldDomain[]): void {
  for (const domain of domains) {
    const key = holdKey(session, domain)
    holds.set(key, (holds.get(key) ?? 0) + 1)
  }
}
