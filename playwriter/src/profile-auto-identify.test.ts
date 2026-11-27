import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { identifyUnknownProfiles, selectBrowserOption } from './profile-auto-identify.js'
import type { BrowserOption } from './relay-sessions.js'

describe('automatic profile identification', () => {
  it('identifies unknown local Chrome profiles and leaves named and non-Chrome browsers alone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-profile-test-'))
    try {
      const options: BrowserOption[] = [
        { key: 'install:Chrome:one', type: 'extension', browser: 'Chrome', profile: '(profile unknown)' },
        { key: 'install:Chrome:two', type: 'extension', browser: 'Chrome', profile: 'Work', profileName: 'Work' },
        { key: 'headless', type: 'headless', browser: 'Chrome', profile: '-' },
      ]
      const identify = vi.fn(async () => 'Viktor')
      await identifyUnknownProfiles(options, identify, 1000, path.join(dir, 'retry.json'))
      expect(identify).toHaveBeenCalledOnce()
      expect(options[0]).toMatchObject({ profile: 'Viktor', profileName: 'Viktor' })
      expect(options[1].profile).toBe('Work')
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

describe('browser selection', () => {
  const first: BrowserOption = {
    key: 'install:Chrome:one', type: 'extension', browser: 'Chrome', profile: 'Work', profileName: 'Work',
  }
  const second: BrowserOption = {
    key: 'install:Chrome:two', type: 'extension', browser: 'Chrome', profile: '(profile unknown)',
  }
  const options = [first, second]

  it('selects a browser key without a Chrome profile probe', async () => {
    const identify = vi.fn(async () => 'Other')
    await expect(selectBrowserOption({ key: second.key, options, identify })).resolves.toBe(second)
    expect(identify).not.toHaveBeenCalled()
  })

  it('verifies current Chrome names instead of routing by a stale cached name', async () => {
    const identify = vi.fn(async (key: string) => key === first.key ? 'Personal' : 'Work')
    await expect(selectBrowserOption({ key: 'Work', options, identify })).resolves.toBe(second)
    expect(identify).toHaveBeenCalledWith(first.key)
    expect(identify).toHaveBeenCalledWith(second.key)
  })

  it('rejects duplicate and unverifiable names and shows the stable keys', async () => {
    await expect(selectBrowserOption({ key: 'Work', options, identify: async () => 'Work' }))
      .rejects.toThrow(/Multiple Chrome profiles.*install:Chrome:one, install:Chrome:two/)
    await expect(selectBrowserOption({ key: 'Work', options, identify: async (key) => key === first.key ? 'Work' : null }))
      .rejects.toThrow(/Could not verify.*install:Chrome:one, install:Chrome:two/)
    await expect(selectBrowserOption({ key: 'Work', options }))
      .rejects.toThrow(/Browser not found.*install:Chrome:one/)
  })

  it('probes the cached profile first and skips profiles cached under another name', async () => {
    const work: BrowserOption = { key: 'install:Chrome:work', type: 'extension', browser: 'Chrome', profile: 'Work', profileName: 'Work' }
    const personal: BrowserOption = { key: 'install:Chrome:personal', type: 'extension', browser: 'Chrome', profile: 'Personal', profileName: 'Personal' }
    const identify = vi.fn(async (key: string) => key === work.key ? 'Work' : 'Personal')
    await expect(selectBrowserOption({ key: 'Work', options: [personal, work], identify })).resolves.toBe(work)
    expect(identify).toHaveBeenCalledOnce()
    expect(identify).toHaveBeenCalledWith(work.key)
  })

  it('falls back to every profile when the cached name is stale', async () => {
    const renamed: BrowserOption = { key: 'install:Chrome:renamed', type: 'extension', browser: 'Chrome', profile: 'Work', profileName: 'Work' }
    const other: BrowserOption = { key: 'install:Chrome:other', type: 'extension', browser: 'Chrome', profile: 'Personal', profileName: 'Personal' }
    const identify = vi.fn(async (key: string) => key === renamed.key ? 'Old' : 'Work')
    await expect(selectBrowserOption({ key: 'Work', options: [renamed, other], identify })).resolves.toBe(other)
    expect(identify).toHaveBeenCalledTimes(2)
  })

  it('reports a missing profile even if exactly one Chrome profile responds', async () => {
    await expect(selectBrowserOption({ key: 'Work', options: [first], identify: async () => 'Personal' }))
      .rejects.toThrow(/No connected Chrome profile.*Work/)
  })
})
