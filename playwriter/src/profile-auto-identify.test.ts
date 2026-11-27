import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { identifyUnknownProfiles } from './profile-auto-identify.js'
import type { BrowserOption } from './relay-sessions.js'

describe('automatic profile identification', () => {
  it('identifies unknown local Chrome profiles and leaves named and non-Chrome browsers alone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-profile-test-'))
    try {
      const options: BrowserOption[] = [
        { key: 'install:Chrome:one', type: 'extension', browser: 'Chrome', profile: '(profile unknown)' },
        { key: 'install:Chrome:two', type: 'extension', browser: 'Chrome', profile: 'CFA', profileLabel: 'CFA' },
        { key: 'headless', type: 'headless', browser: 'Chrome', profile: '-' },
      ]
      const identify = vi.fn(async () => 'Viktor')
      await identifyUnknownProfiles(options, identify, 1000, path.join(dir, 'retry.json'))
      expect(identify).toHaveBeenCalledOnce()
      expect(options[0]).toMatchObject({ profile: 'Viktor', profileLabel: 'Viktor' })
      expect(options[1].profile).toBe('CFA')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('backs off after an unavailable Accessibility lookup and retries later', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-profile-test-'))
    try {
      const options: BrowserOption[] = [{ key: 'install:Chrome:one', type: 'extension', browser: 'Chrome', profile: 'email@example.com' }]
      const identify = vi.fn(async () => null)
      const file = path.join(dir, 'retry.json')
      await identifyUnknownProfiles(options, identify, 1000, file)
      await identifyUnknownProfiles(options, identify, 2000, file)
      expect(identify).toHaveBeenCalledOnce()
      expect(options[0].profile).toBe('email@example.com')
      await identifyUnknownProfiles(options, identify, 301001, file)
      expect(identify).toHaveBeenCalledTimes(2)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
