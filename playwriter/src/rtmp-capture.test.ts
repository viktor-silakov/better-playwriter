import { describe, test, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { once } from 'node:events'
import { chromium } from '@xmorse/playwright-core'
import WebSocket, { WebSocketServer } from 'ws'
import {
  buildStreamFfmpegArgs,
  escapeTeeUrl,
  parseFfmpegProgressLine,
  redactStreamUrl,
  type StreamFfmpegOptions,
} from './rtmp-capture.js'
import { ScreenStream } from './screen-stream.js'

test('starts capturing a static page without waiting for a seed screenshot', async () => {
  const server = await chromium.launchServer({ headless: true, channel: 'chromium', executablePath: process.env.PLAYWRITER_TEST_BROWSER })
  const proxy = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const commands: string[] = []
  const pendingScreenshots: Array<() => void> = []
  const pendingFrames: Array<() => void> = []
  const peers = new Set<WebSocket>()
  proxy.on('connection', (socket) => {
    const upstream = new WebSocket(server.wsEndpoint())
    peers.add(socket)
    peers.add(upstream)
    const connected = once(upstream, 'open')
    socket.on('message', async (data) => {
      await connected
      const message = JSON.parse(data.toString()) as { method: string; params?: { method?: string } }
      const command = message.method === 'send' ? message.params?.method : undefined
      if (command) commands.push(command)
      // Delay only the seed command. All frames and other commands use real Chrome.
      if (command === 'Page.captureScreenshot' && commands.includes('Page.startScreencast')) {
        pendingScreenshots.push(() => upstream.send(data.toString()))
        pendingFrames.splice(0).forEach((send) => send())
        return
      }
      upstream.send(data.toString())
    })
    upstream.on('message', (data) => {
      const message = JSON.parse(data.toString()) as { method?: string; params?: { method?: string } }
      if (message.method === 'event' && message.params?.method === 'Page.screencastFrame' && !commands.includes('Page.captureScreenshot')) {
        pendingFrames.push(() => socket.send(data.toString()))
        return
      }
      socket.send(data.toString())
    })
  })
  await once(proxy, 'listening')
  const address = proxy.address()
  if (!address || typeof address === 'string') throw new Error('Proxy did not listen')
  const outputPath = path.join(process.cwd(), 'tmp', `capture-${crypto.randomUUID()}.flv`)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  let stream: ScreenStream | undefined
  try {
    const browser = await chromium.connect(`ws://127.0.0.1:${address.port}`)
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.setContent('<body style="background: red">Static page</body>')
    stream = await ScreenStream.start({
      page,
      rtmpUrls: [outputPath],
      resolution: '640x360',
      fps: 30,
      audio: false,
      videoBitrateKbps: 1000,
      codec: 'libx264',
      keyframeSeconds: 2,
    })
    const screenshotIndex = commands.indexOf('Page.captureScreenshot')
    if (screenshotIndex !== -1) {
      expect(commands.indexOf('Page.startScreencast')).toBeLessThan(screenshotIndex)
    }
    expect(pendingScreenshots).toHaveLength(1)
    pendingScreenshots.splice(0).forEach((send) => send())
    await new Promise((resolve) => setTimeout(resolve, 200))
    const result = await stream.stop()
    expect(result.frames).toBeGreaterThan(0)
    expect(stream.capture.stats.capturedFrames).toBeGreaterThan(0)
    const decoded = spawnSync('ffmpeg', [
      '-v', 'error', '-xerror', '-i', outputPath, '-map', '0:v:0', '-progress', 'pipe:1', '-f', 'null', '-',
    ], { encoding: 'utf8' })
    expect(decoded.status, decoded.error?.message ?? decoded.stderr).toBe(0)
    expect(decoded.stdout).toMatch(/^frame=[1-9]\d*$/m)
    await context.close()
  } finally {
    pendingScreenshots.splice(0).forEach((send) => send())
    await stream?.capture.abort()
    for (const peer of peers) peer.terminate()
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
    await server.close()
    fs.rmSync(outputPath, { force: true })
  }
}, 10_000)

describe('buildStreamFfmpegArgs', () => {
  const base: StreamFfmpegOptions = {
    rtmpUrls: ['rtmp://broadcast.example/app/streamkey'],
    width: 1280,
    height: 720,
    fps: 30,
    videoBitrateKbps: 4500,
    audioBitrateKbps: 128,
    audio: true,
    preset: 'veryfast',
    codec: 'libx264',
    keyframeSeconds: 3,
  }

  test('page audio, silent audio, hardware encoder', () => {
    expect([
      buildStreamFfmpegArgs(base).join(' '),
      buildStreamFfmpegArgs({ ...base, audio: false }).join(' '),
      buildStreamFfmpegArgs({ ...base, codec: 'h264_videotoolbox' }).join(' '),
    ]).toMatchInlineSnapshot(`
      [
        "-hide_banner -nostdin -f image2pipe -c:v mjpeg -framerate 30 -thread_queue_size 512 -i pipe:0 -f s16le -ar 48000 -ac 2 -thread_queue_size 512 -i pipe:3 -map 0:v:0 -map 1:a:0 -vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p,setsar=1 -r 30 -c:v libx264 -b:v 4500k -maxrate 4500k -bufsize 9000k -g 90 -keyint_min 90 -preset veryfast -tune zerolatency -sc_threshold 0 -c:a aac -b:a 128k -ar 44100 -ac 2 -f flv rtmp://broadcast.example/app/streamkey",
        "-hide_banner -nostdin -f image2pipe -c:v mjpeg -framerate 30 -thread_queue_size 512 -i pipe:0 -f lavfi -i anullsrc=r=44100:cl=stereo -map 0:v:0 -map 1:a:0 -shortest -vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p,setsar=1 -r 30 -c:v libx264 -b:v 4500k -maxrate 4500k -bufsize 9000k -g 90 -keyint_min 90 -preset veryfast -tune zerolatency -sc_threshold 0 -c:a aac -b:a 128k -ar 44100 -ac 2 -f flv rtmp://broadcast.example/app/streamkey",
        "-hide_banner -nostdin -f image2pipe -c:v mjpeg -framerate 30 -thread_queue_size 512 -i pipe:0 -f s16le -ar 48000 -ac 2 -thread_queue_size 512 -i pipe:3 -map 0:v:0 -map 1:a:0 -vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p,setsar=1 -r 30 -c:v h264_videotoolbox -b:v 4500k -maxrate 4500k -bufsize 9000k -g 90 -keyint_min 90 -realtime true -c:a aac -b:a 128k -ar 44100 -ac 2 -f flv rtmp://broadcast.example/app/streamkey",
      ]
    `)
  })

  test('multi destination uses tee muxer with onfail=ignore', () => {
    const args = buildStreamFfmpegArgs({
      ...base,
      rtmpUrls: ['rtmp://live.example/app/key1', 'rtmp://broadcast.example/app/key2'],
    })
    expect(args.slice(-7).join(' ')).toMatchInlineSnapshot(`"-f tee -use_fifo 1 -fifo_options attempt_recovery=1:recover_any_error=1 [f=flv:onfail=ignore]rtmp://live.example/app/key1|[f=flv:onfail=ignore]rtmp://broadcast.example/app/key2"`)
  })

  test('throws without destinations', () => {
    expect(() => {
      buildStreamFfmpegArgs({ ...base, rtmpUrls: [] })
    }).toThrowErrorMatchingInlineSnapshot(`[Error: At least one RTMP destination is required]`)
  })
})

describe('stream url helpers', () => {
  test('escapeTeeUrl and redactStreamUrl', () => {
    expect([
      escapeTeeUrl('rtmp://broadcast.example/app/key|with[brackets]'),
      redactStreamUrl('rtmp://live.example/app/live_123456_SECRET'),
      redactStreamUrl('rtmps://va.pscp.tv:443/x/SECRETKEY'),
      redactStreamUrl('fixture.flv'),
    ]).toMatchInlineSnapshot(`
      [
        "rtmp://broadcast.example/app/key\\|with\\[brackets\\]",
        "rtmp://live.example/…",
        "rtmps://va.pscp.tv:443/…",
        "fixture.flv",
      ]
    `)
  })

  test('parseFfmpegProgressLine', () => {
    expect([
      parseFfmpegProgressLine('frame=  123 fps= 30 q=28.0 size=    1024KiB time=00:00:04.10 bitrate=2045.6kbits/s drop=2 speed=1.01x'),
      parseFfmpegProgressLine('[flv @ 0x7f8] Failed to update header'),
    ]).toMatchInlineSnapshot(`
      [
        {
          "bitrateKbps": 2045.6,
          "droppedFrames": 2,
          "fps": 30,
        },
        null,
      ]
    `)
  })
})
