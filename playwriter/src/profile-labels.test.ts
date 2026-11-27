import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const script = readFileSync(new URL('./chrome-profile-macos.jxa', import.meta.url), 'utf8')

type AXNode = {
  AXRole: string
  AXTitle?: string
  AXDescription?: string
  AXChildren?: AXNode[]
  AXWindows?: AXNode[]
}

function nativeArray<T>(values: T[]) {
  return { count: values.length, objectAtIndex: (index: number) => values[index] }
}

function lookup(applications: AXNode[][], trusted = true): string | null {
  const bridge = Object.assign((value: string) => value, {
    AXIsProcessTrusted: () => trusted,
    NSRunningApplication: {
      runningApplicationsWithBundleIdentifier: () => {
        if (!trusted) throw new Error('Must skip Chrome when Accessibility is unavailable')
        return nativeArray(applications.map((_, index) => ({ processIdentifier: index + 1 })))
      },
    },
    AXUIElementCreateApplication: (pid: number): AXNode => ({ AXRole: 'AXApplication', AXWindows: applications[pid - 1] }),
    AXUIElementSetMessagingTimeout: () => {},
    AXUIElementCopyAttributeValue: (node: AXNode, attribute: keyof AXNode, result: unknown[]) => {
      if (attribute === 'AXChildren' && (node.AXRole === 'AXWebArea' || node.AXRole === 'AXToolbar')) {
        throw new Error('Must skip web content and the toolbar')
      }
      const value = node[attribute]
      if (value === undefined) return -1
      result[0] = Array.isArray(value) ? nativeArray(value) : value
      return 0
    },
  })
  const run = runInNewContext(script + '\nrun', {
    $: bridge,
    Ref: () => [],
    ObjC: { import: () => {}, castRefToObject: (value: unknown) => value, unwrap: (value: unknown) => value },
  })
  return JSON.parse(run(['marker']))
}

const tab = (title: string): AXNode => ({ AXRole: 'AXRadioButton', AXTitle: title })
const window = (title: string, children: AXNode[] = []): AXNode => ({ AXRole: 'AXWindow', AXTitle: title, AXChildren: children })

describe('local Chrome profile identification', () => {
  it('finds the background tab in the right Chrome process and skips page content', () => {
    expect(lookup([
      [window('Other tab - Google Chrome - One', [tab('other'), { AXRole: 'AXWebArea', AXChildren: [tab('marker')] }])],
      [window('Active tab - Google Chrome - Two', [tab('marker'), { AXRole: 'AXToolbar' }])],
    ])).toBe('Two')
  })

  it('refuses missing and ambiguous matches and ignores windows without profile names', () => {
    expect(lookup([[window('A - Google Chrome - One', [tab('other')])]])).toBeNull()
    expect(lookup([[window('A - Google Chrome - One', [tab('marker')]), window('B - Google Chrome - Two', [tab('marker')])]])).toBeNull()
    expect(lookup([[window('A - Google Chrome', [tab('marker')])]])).toBeNull()
  })

  it('recognizes a grouped tab described below the Chrome tab strip', () => {
    let group: AXNode = { AXRole: 'AXTabGroup', AXChildren: [{ AXRole: 'AXTab', AXDescription: 'marker - Part of group identify' }] }
    for (let index = 0; index < 8; index++) {
      group = { AXRole: 'AXGroup', AXChildren: [group] }
    }
    expect(lookup([[window('A - Google Chrome - Grouped', [group])]])).toBe('Grouped')
  })

  it('reads the last Chrome suffix when the active page title also contains the browser name', () => {
    expect(lookup([[window('A - Google Chrome - Page text - Google Chrome - One', [tab('marker')])]])).toBe('One')
  })

  it('returns no label when Accessibility is unavailable', () => {
    expect(lookup([], false)).toBeNull()
  })
})
