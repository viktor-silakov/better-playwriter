# Recording workflows and video

## Recording user actions for skill generation

Load the [core skill](../SKILL.md) before recording.

The toolbar's **Record Skill** button records the selected tab. `better-playwriter recorder start` records the pages visible to its CLI session. Both produce the same event format.

`better-playwriter recorder start` records everything the user does in the browser (clicks, typing, navigations, xhr/fetch, toast and alert text) as events with generated locator strings. It also saves a jpeg of each visual change into a frames folder. User clicks flash a ripple in those frames. To see the screen at an event, open the path printed by `better-playwriter recorder frame <eventId>`. When the user asks you to "start recording", run it and let them perform their workflow. You may run better-playwriter commands on that session if they ask (snapshot, inspect, click something). If they did not ask, ask first. Do not drive the workflow yourself.

```bash
better-playwriter recorder start            # reuse the only session, or create one
better-playwriter recorder start -s 1       # attach to an existing session
better-playwriter recorder status           # active recordings + current page urls
better-playwriter recorder stop             # stop the only active recording
better-playwriter recorder stop 3           # stop recording 3 when several are active
better-playwriter recorder events           # thin timeline of the latest recording
better-playwriter recorder events -r 3      # events of recording 3
better-playwriter recorder events 4 7       # full details of events 4 and 7
better-playwriter recorder events --errors   # failed requests, console errors, toasts
better-playwriter recorder frame 7 --offset 1000  # screenshot path 1s after event 7
```

Run `better-playwriter recorder stop` when they say done, then `better-playwriter recorder events -r <id>` to read the events. If stop fails because **more than one recording is active**, the error lists each recording id, session, and current or last page URL. Pick the one that matches the workflow (or ask the user), then `better-playwriter recorder stop <id>`. Replay the flow with **better-playwriter** commands only (`better-playwriter -s <id> -e '...'`), never raw Playwright. The `recorder start` output prints full instructions for turning a recording into a reusable skill: a SKILL.md of markdown instructions with example better-playwriter commands, plus an importable helper script (`submit.js`, `sdk.js`) for cheap replay. Recording runs inside the relay daemon, so it survives CLI exits. Pass `-s <id>` to record an existing session; the recorder attaches to all Better Playwriter-enabled tabs and does not open a new tab. A recording auto-stops after 20 minutes or 500 MB of frames and events (`reason: "max-size"`).

If the user started from the toolbar and then says "done", still run `better-playwriter recorder stop` (or `stop <id>` if several are listed). The toolbar **Stop recording…** button also works.

## Recording the page as video

**recording.start** - record the page as a video with Chrome's native recorder (**Chrome 153+**), up to 4K 60 fps. Returns a handle; keep it in `state` to stop it in a later call. No user click needed; works in extension, direct CDP, headless, and remote sessions. **Recording survives page navigation**. Auto-overlays a ghost cursor that follows mouse actions. Auto-resizes viewport to 16:9 (only shrinks, override with `aspectRatio: null`). **Set the viewport before start**: output size is fixed at start. Output is H.264 `.mp4`/`.mov`/`.mkv` (`ffmpeg` **must be on PATH**) or `codec: 'av1'` (no ffmpeg, also `.webm`). Auto-stops after 60 min and saves the file (override with `maxDurationMs`). A closed page also saves the file; the next output shows a warning. One recording per page; a recording tab cannot stream or show the live view. `audio: true` records tab audio.

For demos, use interaction methods (`locator.click()`, `page.mouse.move()`) instead of `goto()` to show realistic cursor motion.

```js
state.video = await recording.start({
  page: state.page,
  outputPath: 'demo.mp4', // relative to the session cwd
  codec: 'h264', // default. 'av1' needs no ffmpeg
  frameRate: 60, // default, max 120
  clock: 'real', // default. 'manual' records only inside wait(ms), see below
  audio: false, // default
  maxSize: 3840, // default, longest output edge. Pass 1920 for X uploads
  aspectRatio: { width: 16, height: 9 }, // default, set null to skip
  maxDurationMs: 60 * 60 * 1000, // default, set 0 to disable
})

// Recording survives navigation
await state.page.click('a')
await state.page.waitForLoadState('domcontentloaded')

await state.video.setPage(otherPage) // record another tab from now on

// Stop and save the recording result
state.recordingResult = await state.video.stop() // { path, duration, size, endReason, executionTimestamps }

// Lost the handle: await recording.stop({ page: state.page })
// Other: state.video.isRecording, state.video.cancel(), console.log(state.video) for elapsed time and bytes
```

**Prefer `clock: 'manual'` for demo videos.** With the default `'real'` clock every second you spend thinking is in the video. `'manual'` writes frames only inside `wait(ms)`; the page runs normally in between, so the video has no idle time:

```js
state.video = await recording.start({ page: state.page, outputPath: '/abs/demo.mp4', clock: 'manual' })
await state.page.getByRole('button', { name: 'Open' }).click()
await state.video.wait(800) // records the next 800ms, animation included
await state.video.stop()
```

Put each action and its `wait()` in the **same execute call**, or the animation is over before recording resumes. Use `wait(ms)` instead of `waitForTimeout()` when the viewer should see time pass.

For editing an existing real-time recording with `createDemoVideo()`, see **Demo video acceleration** in the MCP resource `recording-guide.md` or in `dist/recording-guide.md` in the installed package.

**ghostCursor.show / ghostCursor.hide** - the ghost cursor overlay is always on: the extension injects it hidden on every Better Playwriter-attached tab, it appears on the first Playwright mouse action (click, move, wheel) and fades out after 5s idle. These methods only matter if you want to change the cursor style or temporarily hide it:

```js
await ghostCursor.show({ page: state.page, style: 'screenstudio' }) // 'minimal' (default), 'dot', 'screenstudio'
await ghostCursor.hide({ page: state.page }) // hide until next show() or hard navigation
```
