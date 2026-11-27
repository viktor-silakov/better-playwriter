import { describe, expect, it } from 'vitest'
import { profileNameFromWindows } from './profile-labels.js'

describe('local Chrome profile identification', () => {
  const snapshot = (title: string, tabs: string[]) => ({ elements: [
    { role: 'AXWindow', label: title },
    ...tabs.map((label) => ({ role: 'AXRadioButton', label })),
  ] })

  it('finds the profile containing the unique marker, not other Chrome windows', () => {
    expect(profileNameFromWindows('marker', [
      snapshot('Jira - Google Chrome - CFA', ['marker']),
      snapshot('Jira - Google Chrome - Personal', ['other']),
    ])).toBe('CFA')
  })

  it('refuses ambiguous or missing results', () => {
    expect(profileNameFromWindows('marker', [snapshot('A - Google Chrome - One', ['marker']), snapshot('B - Google Chrome - Two', ['marker'])])).toBeNull()
    expect(profileNameFromWindows('missing', [snapshot('A - Google Chrome - One', ['marker'])])).toBeNull()
    expect(profileNameFromWindows('marker', [snapshot('A - Google Chrome', ['marker'])])).toBeNull()
  })
  it('recognizes a tab title annotated with its Chrome tab group', () => {
    expect(profileNameFromWindows('marker', [snapshot('A - Google Chrome - Viktor', ['marker - Part of group identify'])])).toBe('Viktor')
  })
})
