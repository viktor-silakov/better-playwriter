import { describe, it, expect } from 'vitest'
import {
  shouldAutoReturn,
  wrapCode,
  isPlaywrightChannelOwner,
  formatConsoleLogs,
  boundExecuteOutput,
  limitSnapshotOutput,
  formatValue,
  condenseSnapshotLines,
  searchSnapshot,
  shortenCallLog,
  shortenUrlForOutput,
} from './executor.js'
import { trimStackForAgent } from './process-guard.js'

describe('shortenUrlForOutput', () => {
  it('keeps a short query and cuts a long one', () => {
    expect(shortenUrlForOutput('https://example.com/list?page=2#top')).toBe('https://example.com/list?page=2#top')
    expect(shortenUrlForOutput(`https://example.com/signin?state=${'a'.repeat(300)}`)).toBe(
      'https://example.com/signin?… (306 more characters: page.url())',
    )
  })
})

describe('error text for an agent', () => {
  it('keeps frames of agent code without paths and drops internal ones', () => {
    const stack = [
      'TypeError: x is not a function',
      '    at run (/srv/app/.playwriter-eval.js:3:17)',
      '    at async file:///srv/app/dist/executor.js:2276:28',
      '    at async PlaywrightExecutor.executeInternal (file:///srv/app/dist/executor.js:2266:28)',
    ].join('\n')
    expect(trimStackForAgent(stack)).toMatchInlineSnapshot(`
      "TypeError: x is not a function
          at your code, line 3, column 17"
    `)
  })

  it('keeps each call log line once and cuts long ones', () => {
    const cover = `      - <div class="row">${'word '.repeat(100)}</div> intercepts pointer events`
    const retry = ['    - retrying click action', '    - waiting 100ms', '      - element is visible, enabled and stable', cover]
    const text = [
      'locator.click: Timeout 1000ms exceeded.',
      'Call log:',
      "  - waiting for getByRole('button', { name: 'Go' })",
      '  - attempting click action',
      ...retry,
      ...retry.map((line) => line.replace('100ms', '500ms')),
      ...retry,
      '',
      '[HINT: after the log]',
    ].join('\n')
    const out = shortenCallLog(text)
    expect(out.length).toBeLessThan(700)
    expect(out.match(/<div class="row">/g)?.length).toBe(1)
    expect(out).toContain('[8 repeated or further call log lines left out]')
    expect(out.endsWith('[HINT: after the log]')).toBe(true)
    expect(shortenCallLog('no log here')).toBe('no log here')
    expect(shortenCallLog('x\nCall log:\n  - <img title="A long title that holds page content" src="s.png"> intercepts')).toContain('<img title="…" src="s.png">')
  })
})

describe('limitSnapshotOutput', () => {
  it('omits whole lines and keeps late dialogs and status messages with their parents', () => {
    const controls = Array.from({ length: 40 }, (_, i) => `  - button "Item ${i}" @e${i + 1}`)
    const snapshot = [
      '- main "Dashboard":',
      ...controls,
      '  - dialog "Confirm":',
      '    - button "Dismiss" @e41',
      '- status:',
      '  - text: "Connection lost"',
    ].join('\n')
    const out = limitSnapshotOutput({ snapshot, maxChars: 200 })
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out).toContain('- main "Dashboard":')
    expect(out).toContain('  - dialog "Confirm":\n    - button "Dismiss" @e41')
    expect(out).toContain('- status:\n  - text: "Connection lost"')
    const [notice] = out.split('\n').slice(-1)
    expect(notice).toContain(`${snapshot.split('\n').length - out.split('\n').length + 1} snapshot lines omitted`)
    for (const line of out.split('\n').slice(0, -1)) {
      expect(snapshot.split('\n')).toContain(line)
    }
  })
})

describe('condenseSnapshotLines', () => {
  it('drops disabled, repeated and empty leaves and indents by real depth', () => {
    const rows = Array.from({ length: 5 }, (_, i) => [
      `        - option "Message ${i}" @e${10 + i * 2}:`,
      `              - button "Mark as read" @e${11 + i * 2}`,
    ]).flat()
    const out = condenseSnapshotLines([
      '- region "Ribbon":',
      '    - button "New" @e1',
      '    - button "Delete" [disabled] @e2',
      '    - labeltext',
      '    - button "Archive" [disabled] @e3',
      '- group "Respond":',
      '    - button "Reply" [disabled] @e4:',
      '        - text: "to this message"',
      '- group "Ada: the build is red, and this sentence is the whole message that an agent wants to read in full, so it must stay as long as it is":',
      '    - button "Mark as read" @e6',
      '- treeitem "Chat Ada Away" @e5:',
      '    - generic "Away"',
      '- status',
      '- status:',
      '    - text: "Saved"',
      '- listbox "Messages":',
      ...rows,
      '      - generic "Calendar":',
      '          - button "Calendar" @e30',
      '      - text: "…"',
      `      - button "${'Long name '.repeat(20)}" @e31`,
    ])
    expect(out.lines.join('\n')).toMatchInlineSnapshot(`
      "- region "Ribbon":
        - button "New" @e1
      - group "Ada: the build is red, and this sentence is the whole message that an agent wants to read in full, so it must stay as long as it is":
        - button "Mark as read" @e6
      - treeitem "Chat Ada Away" @e5
      - status:
        - text: "Saved"
      - listbox "Messages":
        - option "Message 0" @e10:
          - button "Mark as read" @e11
        - option "Message 1" @e12:
          - button "Mark as read" @e13
        - option "Message 2" @e14
        - option "Message 3" @e16
        - option "Message 4" @e18
        - button "Calendar" @e30
        - button "Long name Long name Long name Long name Long name Long name Long name Long name Long name Long name Long name Long name …" @e31"
    `)
    expect({ disabled: out.disabled, repeated: out.repeated, empty: out.empty }).toMatchInlineSnapshot(`
      {
        "disabled": 3,
        "empty": 5,
        "repeated": 3,
      }
    `)
  })

  it('keeps three cells of a date grid and drops row names made of their cell names', () => {
    const week = (start: number) => {
      const days = Array.from({ length: 7 }, (_, i) => `${start + i}, May, 2030`)
      return [`  - row "${days.join(' ')}":`, ...days.map((day, i) => `    - button "${day}" @e${start + i}`)]
    }
    const out = condenseSnapshotLines([
      '- navigation "Date picker":',
      '  - row "Sunday Monday Tuesday"',
      ...week(1),
      ...week(8),
      ...week(15),
      '- main "Agenda":',
      '  - button "Review, 2:00 PM, May 4, 2030" @e40',
      '  - button "Planning, 3:00 PM, May 5, 2030" @e41',
      ...Array.from({ length: 16 }, (_, i) => `  - button "Order ${1000 + i}" @e${50 + i}`),
    ])
    expect(out.lines.join('\n')).toMatchInlineSnapshot(`
      "- navigation "Date picker":
        - row "Sunday Monday Tuesday"
        - row:
          - button "1, May, 2030" @e1
          - button "2, May, 2030" @e2
          - button "3, May, 2030" @e3
      - main "Agenda":
        - button "Review, 2:00 PM, May 4, 2030" @e40
        - button "Planning, 3:00 PM, May 5, 2030" @e41
        - button "Order 1000" @e50
        - button "Order 1001" @e51
        - button "Order 1002" @e52
        - button "Order 1003" @e53
        - button "Order 1004" @e54
        - button "Order 1005" @e55
        - button "Order 1006" @e56
        - button "Order 1007" @e57
        - button "Order 1008" @e58
        - button "Order 1009" @e59
        - button "Order 1010" @e60
        - button "Order 1011" @e61
        - button "Order 1012" @e62
        - button "Order 1013" @e63
        - button "Order 1014" @e64
        - button "Order 1015" @e65"
    `)
    expect(out.repeated).toBe(18)
  })

  it('leaves diffs and legacy locator lines alone', () => {
    const filler = Array.from({ length: 30 }, (_, i) => `  - button "Item ${i}" @e${i + 10}`)
    const diff = ['- main "Inbox":', '-  - button "Delete" [disabled] @e1', '+  - button "Delete" @e1', '   - status', ...filler].join('\n')
    const bounded = limitSnapshotOutput({ snapshot: diff, maxChars: 300, condense: false })
    expect(bounded).toContain('-  - button "Delete" [disabled] @e1')
    expect(bounded).toContain('   - status')
    expect(bounded).not.toContain('disabled,')

    // Without @refs a control line looks like a label. It must survive under a parent that shares its name.
    const legacy = ['- generic "Save":', '  - role=button[name="Save"i]', '  - [disabled] role=button[name="Undo"i]', ...filler.map((line) => line.replace(/ @e\d+/, ''))].join('\n')
    const legacyBounded = limitSnapshotOutput({ snapshot: legacy, maxChars: 300 })
    expect(legacyBounded).toContain('  - role=button[name="Save"i]')
    expect(legacyBounded).toContain('  - [disabled] role=button[name="Undo"i]')
  })

  it('is applied only when the snapshot is over its budget', () => {
    const snapshot = ['- button "Delete" [disabled] @e1', '- status', '- button "Save" @e2'].join('\n')
    expect(limitSnapshotOutput({ snapshot, maxChars: 4000 })).toBe(snapshot)
    expect(limitSnapshotOutput({ snapshot: [snapshot, ...Array.from({ length: 30 }, () => '- labeltext')].join('\n'), maxChars: 200 }))
      .toMatchInlineSnapshot(`
        "- button "Save" @e2
        [32 snapshot lines omitted (1 disabled, 31 empty). Use locator or search to narrow the snapshot.]"
      `)
  })
})

describe('searchSnapshot', () => {
  const snapshot = Array.from({ length: 40 }, (_, i) => `- button "Item ${i}"`).join('\n')

  it('finds every line with a /g regex and reports the match count', () => {
    expect(searchSnapshot({ snapshot: '- link "A"\n- link "B"\n- text: x\n- link "C"', search: /link/g }))
      .toMatchInlineSnapshot(`
        "3 matches
        - link "A"
        - link "B"
        - link "C""
      `)
  })

  it('matches strings case-insensitively and caps shown matches', () => {
    const out = searchSnapshot({ snapshot, search: 'BUTTON "item 1' })
    expect(out.split('\n')[0]).toMatchInlineSnapshot(`"11 matches"`)
  })

  it('reports no matches', () => {
    expect(searchSnapshot({ snapshot, search: 'checkbox' })).toBe('No matches found')
  })
})

describe('execute output', () => {
  it('folds identical consecutive log lines', () => {
    const logs = [
      ...Array.from({ length: 37 }, () => ({ method: 'log', args: ['tick', 1] })),
      { method: 'warn', args: [{ a: 1 }] },
      { method: 'log', args: ['tick', 1] },
    ]
    expect(formatConsoleLogs({ logs })).toMatchInlineSnapshot(`
      "Console output:
      [log] tick 1 (x37)
      [warn] { a: 1 }
      [log] tick 1

      "
    `)
  })

  it('keeps the return value when logs are long', () => {
    const before = Array.from({ length: 200 }, (_, i) => `[log] line ${i}`).join('\n') + '\n'
    const out = boundExecuteOutput({ before, after: '[return value] summary\n', maxLength: 200 })
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out).toMatchInlineSnapshot(`
      "[log] line 0
      [log] line 1
      [log] line 2
      [log] line 3
      [log] line 4
      ... [2765 characters of logs omitted] ...
      [log] line 196
      [log] line 197
      [log] line 198
      [log] line 199
      [return value] summary
      "
    `)
  })

  it('splits the budget when both logs and return value are long', () => {
    const out = boundExecuteOutput({ before: 'L'.repeat(500), after: 'R'.repeat(500), maxLength: 200 })
    expect(out).toMatchInlineSnapshot(`
      "LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL
      ... [422 characters of logs omitted] ...
      LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR
      [Truncated to 80 of 500 characters. Use snapshot({ search }), or write large data to a file and return a summary]"
    `)
  })

  it('returns short output unchanged', () => {
    expect(boundExecuteOutput({ before: 'a\n', after: 'b\n' })).toBe('a\nb\n')
  })
})

describe('what a bounded answer says about its cuts', () => {
  it('names the largest regions a snapshot over its budget left out', () => {
    const snapshot = [
      '- navigation "Apps"',
      ...Array.from({ length: 30 }, (_, i) => `  - button "App ${i}" @e${i + 1}`),
      '- list "Messages"',
      ...Array.from({ length: 60 }, (_, i) => `  - listitem "Message number ${i} with a long preview text" @e${i + 100}`),
    ].join('\n')
    const out = limitSnapshotOutput({ snapshot, maxChars: 1200, condense: false })
    expect(out.length).toBeLessThanOrEqual(1200)
    expect(out.split('\n').at(-2)).toMatch(/^\[Cut: list "Messages" \(\d+ lines\)/)
    expect(out.split('\n').at(-1)).toBe(`[Read it: snapshot({ locator: page.getByRole('list', { name: 'Messages' }).first() })]`)
  })

  it('says how to get a string that was cut inside a returned object', () => {
    expect(formatValue({ menu: 'x'.repeat(3000) })).not.toContain('more characters')
    expect(formatValue({ menu: 'x'.repeat(5000) })).toContain('Return that string by itself')
    expect(formatValue('x'.repeat(5000))).toHaveLength(5000)
  })
})

describe('shouldAutoReturn', () => {
  it('returns true for simple expressions', () => {
    expect(shouldAutoReturn('1 + 2')).toBe(true)
    expect(shouldAutoReturn('page.title()')).toBe(true)
    expect(shouldAutoReturn('await page.title()')).toBe(true)
    expect(shouldAutoReturn('snapshot({ page })')).toBe(true)
    expect(shouldAutoReturn('accessibilitySnapshot({ page })')).toBe(true)
    expect(shouldAutoReturn('context.pages().map(p => p.url())')).toBe(true)
  })

  it('returns true for awaited expressions', () => {
    expect(shouldAutoReturn('await Promise.resolve(42)')).toBe(true)
    expect(shouldAutoReturn('await page.goto("https://example.com")')).toBe(true)
  })

  it('returns false for assignment expressions', () => {
    expect(shouldAutoReturn('state.page = await context.newPage()')).toBe(false)
    expect(shouldAutoReturn('const x = 1')).toBe(false)
    expect(shouldAutoReturn('let y = 2')).toBe(false)
    expect(shouldAutoReturn('x = 5')).toBe(false)
  })

  it('returns false for update expressions', () => {
    expect(shouldAutoReturn('x++')).toBe(false)
    expect(shouldAutoReturn('++x')).toBe(false)
    expect(shouldAutoReturn('x--')).toBe(false)
    expect(shouldAutoReturn('--x')).toBe(false)
  })

  it('returns false for delete expressions', () => {
    expect(shouldAutoReturn('delete obj.prop')).toBe(false)
  })

  it('returns false for multiple statements', () => {
    expect(shouldAutoReturn('const x = 1; x + 1')).toBe(false)
    expect(shouldAutoReturn('await page.click("button"); await page.title()')).toBe(false)
    expect(shouldAutoReturn('const a = 1\nconst b = 2')).toBe(false)
  })

  it('returns false for return statements', () => {
    expect(shouldAutoReturn('return 5')).toBe(false)
    expect(shouldAutoReturn('return await page.title()')).toBe(false)
  })

  it('returns false for non-expression statements', () => {
    expect(shouldAutoReturn('if (true) { x }')).toBe(false)
    expect(shouldAutoReturn('for (let i = 0; i < 10; i++) {}')).toBe(false)
    expect(shouldAutoReturn('function foo() {}')).toBe(false)
    expect(shouldAutoReturn('class Foo {}')).toBe(false)
  })

  it('returns false for invalid syntax', () => {
    expect(shouldAutoReturn('const')).toBe(false)
    expect(shouldAutoReturn('{')).toBe(false)
    expect(shouldAutoReturn('await')).toBe(false)
  })

  it('handles edge cases', () => {
    // Empty string
    expect(shouldAutoReturn('')).toBe(false)
    // Just whitespace
    expect(shouldAutoReturn('   ')).toBe(false)
    // Object literal (parsed as block)
    expect(shouldAutoReturn('{ foo: 1 }')).toBe(false)
    // Parenthesized object literal (expression)
    expect(shouldAutoReturn('({ foo: 1 })')).toBe(true)
    // Array literal
    expect(shouldAutoReturn('[1, 2, 3]')).toBe(true)
  })

  it('handles sequence expressions with assignments', () => {
    // Sequence with assignment should not auto-return
    expect(shouldAutoReturn('(x = 1, x + 1)')).toBe(false)
    // Sequence without assignment should auto-return
    expect(shouldAutoReturn('(1, 2, 3)')).toBe(true)
  })

  it('handles comments in code', () => {
    expect(shouldAutoReturn('// comment\npage.title()')).toBe(true)
    expect(shouldAutoReturn('page.title() // comment')).toBe(true)
    expect(shouldAutoReturn('/* block */ 42')).toBe(true)
  })

  it('handles template literals', () => {
    expect(shouldAutoReturn('`hello`')).toBe(true)
    expect(shouldAutoReturn('`hello ${name}`')).toBe(true)
  })

  it('returns true for expressions with trailing semicolons', () => {
    expect(shouldAutoReturn('await page.title();')).toBe(true)
    expect(shouldAutoReturn('page.title();')).toBe(true)
    expect(shouldAutoReturn('snapshot({ page });')).toBe(true)
    expect(shouldAutoReturn('await screenshotWithAccessibilityLabels({ page });')).toBe(true)
    // trailing whitespace after semicolon
    expect(shouldAutoReturn('await foo();   ')).toBe(true)
    // comment after semicolon
    expect(shouldAutoReturn('await foo(); // comment')).toBe(true)
    // double semicolons are two statements, not auto-return
    expect(shouldAutoReturn('await foo();;')).toBe(false)
  })
})

describe('wrapCode', () => {
  it('wraps single expressions with return await', () => {
    expect(wrapCode('await page.title()')).toBe(
      '(async () => { return await (await page.title()) })()',
    )
  })

  it('strips trailing semicolons to avoid SyntaxError (#58)', () => {
    // The bug: trailing semicolons inside return await (...;) produce invalid JS
    const wrapped = wrapCode('await screenshotWithAccessibilityLabels({ page });')
    expect(wrapped).toBe(
      '(async () => { return await (await screenshotWithAccessibilityLabels({ page })) })()',
    )
    // Verify it's valid JS by parsing it
    expect(() => new Function(wrapped)).not.toThrow()
  })

  it('produces valid JS for trailing semicolons on simple calls', () => {
    const wrapped = wrapCode('page.title();')
    expect(wrapped).toBe('(async () => { return await (page.title()) })()')
    expect(() => new Function(wrapped)).not.toThrow()
  })

  it('wraps multi-statement code without return', () => {
    const wrapped = wrapCode('const x = 1; console.log(x);')
    expect(wrapped).toBe('(async () => { const x = 1; console.log(x); })()')
  })

  it('wraps assignment expressions without return', () => {
    expect(wrapCode('x = 5')).toBe('(async () => { x = 5 })()')
  })
})

describe('isPlaywrightChannelOwner', () => {
  it('detects ChannelOwner-shaped objects', () => {
    const fakeResponse = {
      _type: 'Response',
      _guid: 'response@abc123',
      _connection: { _platform: { env: {} } },
    }
    expect(isPlaywrightChannelOwner(fakeResponse)).toBe(true)
  })

  it('rejects plain objects and primitives', () => {
    expect(isPlaywrightChannelOwner(null)).toBe(false)
    expect(isPlaywrightChannelOwner(undefined)).toBe(false)
    expect(isPlaywrightChannelOwner('string')).toBe(false)
    expect(isPlaywrightChannelOwner(42)).toBe(false)
    expect(isPlaywrightChannelOwner({})).toBe(false)
    expect(isPlaywrightChannelOwner([])).toBe(false)
    expect(isPlaywrightChannelOwner({ url: 'https://example.com', status: 200 })).toBe(false)
  })

  it('rejects partial matches missing required fields', () => {
    expect(isPlaywrightChannelOwner({ _type: 'Response' })).toBe(false)
    expect(isPlaywrightChannelOwner({ _guid: 'abc' })).toBe(false)
    expect(isPlaywrightChannelOwner({ _type: 'x', _guid: 'y' })).toBe(false)
    // Missing _connection
    expect(isPlaywrightChannelOwner({ _type: 'x', _guid: 'y' })).toBe(false)
    // _type must be a string
    expect(isPlaywrightChannelOwner({ _type: 123, _guid: 'y', _connection: {} })).toBe(false)
  })
})
