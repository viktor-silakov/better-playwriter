import { describe, expect, it } from 'vitest'
import { holdDomains, keepDomains } from './cdp-domains.js'
import type { ICDPSession } from './cdp-session.js'

function fakeSession(domainKey?: string, fail?: string) {
  const sent: string[] = []
  const session = {
    domainKey,
    send: async (method: string) => {
      sent.push(method)
      if (method === fail) throw new Error(`${method} failed`)
      return {}
    },
    on() {},
    off() {},
    detach: async () => {},
  } as unknown as ICDPSession
  return { session, sent }
}

describe('CDP domain holds', () => {
  it('disables a domain only when its last holder releases it, in reverse order', async () => {
    const { session, sent } = fakeSession('target-a')
    const first = await holdDomains(session, ['DOM', 'CSS'])
    const second = await holdDomains(session, ['DOM'])
    await first()
    expect(sent).toEqual(['DOM.enable', 'CSS.enable', 'DOM.enable', 'CSS.disable'])
    await second()
    await second()
    expect(sent.slice(4)).toEqual(['DOM.disable'])
  })

  it('shares holds between sessions of one target and keeps other targets apart', async () => {
    const one = fakeSession('target-b')
    const two = fakeSession('target-b')
    const other = fakeSession('target-c')
    const releaseOne = await holdDomains(one.session, ['Accessibility'])
    const releaseTwo = await holdDomains(two.session, ['Accessibility'])
    const releaseOther = await holdDomains(other.session, ['Accessibility'])
    await releaseOne()
    expect(one.sent).toEqual(['Accessibility.enable'])
    await releaseOther()
    expect(other.sent).toEqual(['Accessibility.enable', 'Accessibility.disable'])
    await releaseTwo()
    expect(two.sent).toEqual(['Accessibility.enable', 'Accessibility.disable'])
  })

  it('never disables a kept domain and releases the hold when enabling fails', async () => {
    const kept = fakeSession()
    keepDomains(kept.session, ['DOM'])
    await (await holdDomains(kept.session, ['DOM']))()
    expect(kept.sent).toEqual(['DOM.enable'])

    const failing = fakeSession('target-d', 'CSS.enable')
    await expect(holdDomains(failing.session, ['DOM', 'CSS'])).rejects.toThrow('CSS.enable failed')
    expect(failing.sent).toEqual(['DOM.enable', 'CSS.enable', 'CSS.disable', 'DOM.disable'])
  })
})
