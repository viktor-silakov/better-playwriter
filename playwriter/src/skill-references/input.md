# Mouse and keyboard

## computer use (low-level mouse/keyboard)

### clicking

```js
// Preferred: by locator (stable, auto-waits, no coordinates needed)
await state.page.locator('button[name="Submit"]').click()
await state.page.locator('text=Login').click({ button: 'right' })
await state.page.locator('text=Login').dblclick()
await state.page.getByRole('link', { name: 'Docs' }).click({ modifiers: ['Meta'] }) // cmd+click opens link in new background tab

// By coordinates (when locators aren't available, e.g. canvas, maps, custom widgets)
await state.page.mouse.click(450, 320) // left click
await state.page.mouse.click(450, 320, { button: 'right' }) // right click
await state.page.mouse.dblclick(450, 320) // double click
await state.page.mouse.click(450, 320, { clickCount: 3 }) // triple click
await state.page.mouse.click(450, 320, { modifiers: ['Shift'] }) // shift+click
```

### hover

```js
await state.page.locator('.tooltip-trigger').hover() // by locator (preferred)
await state.page.mouse.move(450, 320) // by coordinates
```

### scroll

```js
// By locator (preferred)
await state.page.locator('#footer').scrollIntoViewIfNeeded()

// By pixel (for canvas, maps, infinite scroll)
await state.page.mouse.wheel(0, 300) // scroll down 300px
await state.page.mouse.wheel(0, -300) // scroll up
await state.page.mouse.wheel(300, 0) // scroll right
await state.page.mouse.wheel(-300, 0) // scroll left

// Scroll at a specific position
await state.page.mouse.move(450, 320)
await state.page.mouse.wheel(0, 500)

// Scroll inside a container
await state.page.locator('.scrollable-list').evaluate((el) => {
  el.scrollTop += 500
})
```

### drag

```js
// By locator (preferred)
await state.page.locator('#item').dragTo(state.page.locator('#target'))

// By coordinates (for canvas, sliders, custom drag targets)
await state.page.mouse.move(100, 200)
await state.page.mouse.down()
await state.page.mouse.move(400, 500, { steps: 10 }) // steps for smooth drag
await state.page.mouse.up()
```

**Freehand drawing, annotation widgets, and canvas tools** use this same `mouse.down → move → up` pattern. If a widget expects a drawn stroke (paint tools, annotation overlays, range sliders, timeline scrubbers), always use held-mouse motion — not `mouse.click()`:

```js
// Draw a stroke across a canvas or annotation layer
await state.page.mouse.move(startX, startY)
await state.page.mouse.down()
await state.page.mouse.move(endX, endY, { steps: 15 }) // steps = smoother stroke
await state.page.mouse.up()
await state.page.waitForTimeout(500) // let the widget process the stroke
```

### key hold / release / repeat

```js
// Hold modifier while pressing another key
await state.page.keyboard.down('Shift')
await state.page.keyboard.press('ArrowDown')
await state.page.keyboard.up('Shift')

// Repeat a key
for (let i = 0; i < 5; i++) await state.page.keyboard.press('ArrowDown')
```

### resize viewport

```js
await state.page.setViewportSize({ width: 1280, height: 720 })
```

### region screenshot (zoom equivalent)

```js
await state.page.screenshot({ path: '/absolute/path/to/region.png', scale: 'css', clip: { x: 100, y: 200, width: 400, height: 300 } })
```

Prefer locator-based actions over coordinates — locators are stable across scroll/resize, auto-wait for elements, and don't require screenshot round-trips that burn ~800 image tokens per cycle.
