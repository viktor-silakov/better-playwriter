import { describe, expect, it } from 'vitest'
import {
  autoAttachMaskForUrl,
  matchesAutoAttachMask,
  normalizeAutoAttachMask,
  readAutoAttachSettings,
} from './auto-attach-rules.js'

describe('automatic tab connection URL masks', () => {
  it('remembers only the exact origin of a manually connected web page', () => {
    expect(autoAttachMaskForUrl('http://example.test:3000/app?token=example#step')).toBe('http://example.test:3000*')
    expect(autoAttachMaskForUrl('https://example.test:443/')).toBe('https://example.test*')
    expect(autoAttachMaskForUrl('https://user:pass@example.test/app')).toBeNull()
    expect(autoAttachMaskForUrl('file:///example')).toBeNull()
    expect(autoAttachMaskForUrl('chrome://settings/')).toBeNull()
  })

  it('matches paths on the exact scheme, host and port', () => {
    const masks = ['http://example.test*']
    expect(matchesAutoAttachMask('http://example.test', masks)).toBe(true)
    expect(matchesAutoAttachMask('http://example.test/app', masks)).toBe(true)
    expect(matchesAutoAttachMask('http://example.test.invalid/app', masks)).toBe(false)
    expect(matchesAutoAttachMask('http://sub.example.test/app', masks)).toBe(false)
    expect(matchesAutoAttachMask('https://example.test/app', masks)).toBe(false)
    expect(matchesAutoAttachMask('http://example.test:8080/app', masks)).toBe(false)
    expect(matchesAutoAttachMask('http://example.test@example.net/app', masks)).toBe(false)
  })

  it('supports literal and prefix paths with no query or fragment matching', () => {
    expect(matchesAutoAttachMask('https://example.test/app/edit?mode=test', ['https://example.test/app/*'])).toBe(true)
    expect(matchesAutoAttachMask('https://example.test/app2/edit', ['https://example.test/app/*'])).toBe(false)
    expect(matchesAutoAttachMask('https://example.test/app#tab', ['https://example.test/app'])).toBe(true)
    expect(matchesAutoAttachMask('https://example.test/app/edit', ['https://example.test/app'])).toBe(false)
  })

  it('rejects wildcards in hosts and persistent credentials or query data', () => {
    for (const mask of [
      '*',
      'https://*',
      'https://*.example.test/*',
      'https://example.test:*/',
      'https://example.test/?a=*',
      'https://a:b@example.test*',
    ]) {
      expect(normalizeAutoAttachMask(mask), mask).toBeNull()
    }
    expect(readAutoAttachSettings(undefined)).toEqual({ masks: [], remember: true })
    expect(
      readAutoAttachSettings({
        masks: [' http://EXAMPLE.test:80/* ', 'http://example.test*', '*', null],
        remember: false,
      }),
    ).toEqual({ masks: ['http://example.test*'], remember: false })
  })
})
