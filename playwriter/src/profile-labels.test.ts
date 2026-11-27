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

function runChromeScript(args: string[], applications: AXNode[][], trusted = true, chrome?: object) {
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
    Application: () => {
      if (!chrome) throw new Error('Must not send Apple Events unless the profile is verified')
      return chrome
    },
  })
  return JSON.parse(run(args))
}

function lookup(applications: AXNode[][], trusted = true): string | null {
  return runChromeScript(['marker'], applications, trusted)
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

function fakeChromeWindow(id: number, title: string, urls: string[]) {
  let active = 1
  const tabs = Object.assign([...urls], { url: () => [...tabs] })
  return {
    id: () => id,
    title: () => title,
    mode: () => 'normal',
    tabs,
    currentIndex: () => active,
    set activeTabIndex(index: number) { active = index },
    get activeTabIndex(): () => number { return () => active },
  }
}

function fakeChrome(windows: ReturnType<typeof fakeChromeWindow>[]) {
  return {
    windows: Object.assign(() => windows, { byId: (id: number) => windows.find(window => window.id() === id) }),
    Tab: ({ url }: { url: string }) => url,
  }
}

describe('opening a tab by verified Chrome profile', () => {
  const open = (profile: string, url = '', windows = [window('Home - Google Chrome - Work')], chrome?: object) =>
    runChromeScript(['--open-in-profile', profile, url], [windows], true, chrome).status

  it('creates a blank tab in the requested window only', () => {
    const work = fakeChromeWindow(10, 'Home', ['https://work.example/'])
    const personal = fakeChromeWindow(20, 'News', ['https://news.example/'])
    const nativeWindows = [window('News - Google Chrome - Personal'), window('Home - Google Chrome - Work')]
    expect(open('Work', '', nativeWindows, fakeChrome([personal, work]))).toBe('opened')
    expect([...personal.tabs]).toEqual(['https://news.example/'])
    expect([...work.tabs]).toEqual(['https://work.example/', 'chrome://newtab/'])
    expect(work.currentIndex()).toBe(2)
  })

  it('activates an exact existing URL in the verified profile', () => {
    const target = 'https://work.example/?scope=inbox#new'
    const work = fakeChromeWindow(10, 'Home', ['https://work.example/', target])
    expect(open('Work', target, undefined, fakeChrome([work]))).toBe('reused')
    expect(work.tabs).toHaveLength(2)
    expect(work.currentIndex()).toBe(2)
  })

  it('refuses aliases, duplicate profile names and ambiguous window mappings', () => {
    expect(open('Wor')).toBe('profile-not-found')
    expect(open('Work', '', [window('A - Google Chrome - Work'), window('B - Google Chrome - Work')])).toBe('ambiguous-profile')
    expect(open('Work', '', [window('Home - Google Chrome - Work'), window('Home - Google Chrome - Personal')])).toBe('ambiguous-window')
  })
})
