/**
 * RTMP capture pipeline. Chrome provides JPEG frames only when it paints, so
 * a wall-clock ticker repeats the latest frame at the requested output FPS.
 * ffmpeg encodes the frames and an optional PCM audio tap for live delivery.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { Page } from '@xmorse/playwright-core'
import { getCDPSessionForPage, type PlaywrightCDPSessionAdapter } from './cdp-session.js'
import { mergeScreencastParams } from './relay-state.js'
import { fitFilter, type Logger } from './screen-recording.js'

const AUDIO_SAMPLE_RATE = 48000
/** s16le stereo */
const AUDIO_BYTES_PER_SAMPLE = 4
/** Audio is written this far behind the wall clock so page chunks (4096
 *  samples, ~85 ms) arrive before their slot. Smaller values insert gaps. */
const AUDIO_LATENCY_MS = 150
/** If more audio than this is queued, the page clock ran ahead: drop the oldest. */
const AUDIO_MAX_QUEUE_MS = 400
/** Never buffer unbounded in this process: the encoder is too slow or stalled. */
const MAX_PIPE_BUFFERED_BYTES = 64 * 1024 * 1024
const STDERR_TAIL_SIZE = 20
const DEFAULT_JPEG_QUALITY = 90

/** ffmpeg inputs: JPEG frames on stdin, optional s16le PCM on fd 3. */
function captureInputArgs(options: { fps: number; audio: boolean; inputThreadQueue: boolean }): string[] {
  // ffmpeg 9 accepts -thread_queue_size only for outputs and exits when it stands before an input.
  const queue = options.inputThreadQueue ? ['-thread_queue_size', '512'] : []
  const video = ['-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(options.fps), ...queue, '-i', 'pipe:0']
  if (!options.audio) {
    return video
  }
  return [
    ...video,
    '-f', 's16le', '-ar', String(AUDIO_SAMPLE_RATE), '-ac', '2', ...queue, '-i', 'pipe:3',
  ]
}

export interface StreamFfmpegOptions {
  rtmpUrls: string[]
  width: number
  height: number
  fps: number
  videoBitrateKbps: number
  audioBitrateKbps: number
  /** true = page audio tap on pipe:3; false = silent track (X Live rejects streams without audio) */
  audio: boolean
  /** x264 preset, only applied for libx264 */
  preset: string
  /** ffmpeg -c:v value, e.g. libx264 or h264_videotoolbox */
  codec: string
  /** Keyframe interval in seconds. 3 = X Live recommended (and its max), 2 = Twitch. */
  keyframeSeconds: number
  /** Raise the input packet queues. Off for ffmpeg 9+, see supportsInputThreadQueue(). Default true. */
  inputThreadQueue?: boolean
}

/**
 * ffmpeg argv for live RTMP streaming.
 *
 * - GOP = keyframeSeconds * fps with scene-cut keyframes off, for platform rules
 * - `-tune zerolatency` only for libx264 (hardware encoders reject it)
 * - audio is always input 1: the page tap or an infinite anullsrc, which
 *   `-shortest` stops when the video input ends
 * - multiple destinations use the tee muxer with onfail=ignore + use_fifo, so a
 *   dead or stalled endpoint does not stop the others
 */
export function buildStreamFfmpegArgs(options: StreamFfmpegOptions): string[] {
  const { rtmpUrls, width, height, fps, videoBitrateKbps, audioBitrateKbps, audio, preset, codec, keyframeSeconds } = options
  const inputThreadQueue = options.inputThreadQueue ?? true

  if (rtmpUrls.length === 0) {
    throw new Error('At least one RTMP destination is required')
  }

  const gop = Math.round(fps * keyframeSeconds)
  const inputArgs = audio
    ? captureInputArgs({ fps, audio: true, inputThreadQueue })
    : [...captureInputArgs({ fps, audio: false, inputThreadQueue }), '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo']

  const codecArgs: string[] = (() => {
    const base = [
      '-c:v', codec,
      '-b:v', `${videoBitrateKbps}k`,
      '-maxrate', `${videoBitrateKbps}k`,
      '-bufsize', `${videoBitrateKbps * 2}k`,
      '-g', String(gop),
      '-keyint_min', String(gop),
    ]
    if (codec === 'libx264') {
      return [...base, '-preset', preset, '-tune', 'zerolatency', '-sc_threshold', '0']
    }
    if (codec === 'h264_videotoolbox') {
      return [...base, '-realtime', 'true']
    }
    return base
  })()

  const outputArgs: string[] = (() => {
    if (rtmpUrls.length === 1) {
      return ['-f', 'flv', rtmpUrls[0]]
    }
    const tee = rtmpUrls.map((url) => `[f=flv:onfail=ignore]${escapeTeeUrl(url)}`).join('|')
    return [
      '-flags', '+global_header',
      '-f', 'tee',
      '-use_fifo', '1',
      '-fifo_options', 'attempt_recovery=1:recover_any_error=1',
      tee,
    ]
  })()

  return [
    '-hide_banner',
    '-nostdin',
    ...inputArgs,
    '-map', '0:v:0',
    '-map', '1:a:0',
    ...(audio ? [] : ['-shortest']),
    '-vf', fitFilter({ width, height }),
    '-r', String(fps),
    ...codecArgs,
    '-c:a', 'aac',
    '-b:a', `${audioBitrateKbps}k`,
    '-ar', '44100',
    '-ac', '2',
    ...outputArgs,
  ]
}

/** Escape characters that are special to ffmpeg's tee muxer slave syntax. */
export function escapeTeeUrl(url: string): string {
  return url.replace(/([\\|\[\]])/g, '\\$1')
}

/**
 * Redact the stream key from an RTMP URL for logging/status.
 * File paths (used in tests) are returned as-is.
 */
export function redactStreamUrl(url: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return url
  }
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}/…`
  } catch {
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/]+).*$/i, '$1/…')
  }
}

/** Parse an ffmpeg progress line like:
 *  `frame=  123 fps= 30 q=28.0 size=1024KiB time=00:00:04.10 bitrate=2045.6kbits/s drop=0 speed=1x` */
export function parseFfmpegProgressLine(line: string): {
  fps?: number
  bitrateKbps?: number
  droppedFrames?: number
} | null {
  if (!line.includes('frame=')) {
    return null
  }
  const fpsMatch = line.match(/\bfps=\s*([\d.]+)/)
  const bitrateMatch = line.match(/\bbitrate=\s*([\d.]+)kbits\/s/)
  const dropMatch = line.match(/\bdrop=\s*(\d+)/)
  return {
    fps: fpsMatch ? Number(fpsMatch[1]) : undefined,
    bitrateKbps: bitrateMatch ? Number(bitrateMatch[1]) : undefined,
    droppedFrames: dropMatch ? Number(dropMatch[1]) : undefined,
  }
}

// ============================================================================
// PageCapture: screencast + audio tap + ffmpeg, paced by a wall-clock ticker
// ============================================================================

/** Captures per page. They share one CDP session, so one Page.stopScreencast
 *  would stop all of them: the last one to stop sends it. */
const capturesByPage = new Map<Page, Set<PageCapture>>()

let audioTapCode: string | null = null

function getAudioTapCode(): string {
  if (audioTapCode) {
    return audioTapCode
  }
  const currentDir = path.dirname(fileURLToPath(import.meta.url))
  audioTapCode = fs.readFileSync(path.join(currentDir, '..', 'dist', 'audio-tap-client.js'), 'utf-8')
  return audioTapCode
}

export interface CaptureStats {
  /** Frames written to ffmpeg (constant rate, repeats included) */
  videoFrames: number
  /** Frames received from Chrome's screencast */
  capturedFrames: number
  /** Non-silent audio chunks received from the page */
  audioChunks: number
  /** Encoder output fps parsed from ffmpeg progress lines */
  ffmpegFps?: number
  /** Encoder output bitrate in kbps parsed from ffmpeg progress lines */
  ffmpegBitrateKbps?: number
  /** Dropped frames parsed from ffmpeg progress lines */
  droppedFrames?: number
}

export interface CaptureResult {
  /** Media duration in ms (frames written / fps) */
  duration: number
  /** Set when ffmpeg failed, was stalled, or exited non-zero */
  error?: Error
}

interface PageCaptureOptions {
  page: Page
  fps: number
  audio: boolean
  size: { width: number; height: number }
  quality?: number
  buildArgs: (input: { width: number; height: number; fps: number; audio: boolean }) => string[]
  /** Applied to stderr lines before they are kept (hide RTMP stream keys) */
  redact?: (line: string) => string
  logger?: Logger
}

export class PageCapture {
  readonly page: Page
  readonly fps: number
  readonly audio: boolean
  readonly width: number
  readonly height: number
  readonly startedAt = Date.now()
  readonly stats: CaptureStats = { videoFrames: 0, capturedFrames: 0, audioChunks: 0 }
  /** Resolves once ffmpeg exited and page hooks are removed */
  readonly done: Promise<CaptureResult>

  private readonly session: PlaywrightCDPSessionAdapter
  private readonly ffmpeg: ChildProcess
  private readonly videoIn: Writable
  private readonly audioIn: Writable | null
  private readonly logger?: Logger
  private readonly redact: (line: string) => string
  private readonly stderrTail: string[] = []
  private clockStart = performance.now()
  private ticker: ReturnType<typeof setInterval> | null = null
  /** Hooks on the page, removed at the end */
  private pageCleanups: Array<() => Promise<unknown>> = []
  private latestFrame: Buffer = Buffer.alloc(0)
  private screencastParams: { format: 'jpeg'; quality: number; maxWidth: number; maxHeight: number; everyNthFrame: number }
  private rateWindow = { startedAt: performance.now(), frames: 0 }
  private audioQueue: Buffer[] = []
  private audioQueuedBytes = 0
  private samplesWritten = 0
  private failure: Error | null = null
  private finishing = false
  private killed = false
  private resolveDone!: (result: CaptureResult) => void

  private constructor(options: {
    opts: PageCaptureOptions
    session: PlaywrightCDPSessionAdapter
    ffmpeg: ChildProcess
    size: { width: number; height: number }
  }) {
    const { opts, session, ffmpeg, size } = options
    this.page = opts.page
    this.fps = opts.fps
    this.audio = opts.audio
    this.width = size.width
    this.height = size.height
    this.logger = opts.logger
    this.redact = opts.redact || ((line) => line)
    this.session = session
    this.ffmpeg = ffmpeg
    this.videoIn = ffmpeg.stdin!
    this.audioIn = opts.audio ? (ffmpeg.stdio[3] as Writable) : null
    this.screencastParams = {
      format: 'jpeg',
      quality: opts.quality ?? DEFAULT_JPEG_QUALITY,
      maxWidth: size.width,
      maxHeight: size.height,
      everyNthFrame: 1,
    }
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve
    })
  }

  static async start(opts: PageCaptureOptions): Promise<PageCapture> {
    const { page, fps, audio, size } = opts
    const session = await getCDPSessionForPage({ page })
    const args = opts.buildArgs({ width: size.width, height: size.height, fps, audio })
    opts.logger?.log(`[capture] ffmpeg ${args.map(opts.redact || ((arg) => arg)).join(' ')}`)
    const ffmpeg = spawn('ffmpeg', args, {
      stdio: ['pipe', 'ignore', 'pipe', audio ? 'pipe' : 'ignore'],
      windowsHide: true,
    })
    const spawnError = await new Promise<Error | null>((resolve) => {
      ffmpeg.once('spawn', () => {
        resolve(null)
      })
      ffmpeg.once('error', (error) => {
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
        resolve(missing ? new Error('ffmpeg not found. Install ffmpeg to stream.') : error)
      })
    })
    if (spawnError) {
      throw spawnError
    }

    const capture = new PageCapture({ opts, session, ffmpeg, size })
    capture.wireProcess()
    try {
      await capture.attachPage()
      capture.startTicker()
    } catch (error) {
      await capture.abort()
      throw new Error('Could not start page capture', { cause: error })
    }
    return capture
  }

  /** Stop capturing, flush, and wait for ffmpeg to finish the output. */
  stop(): Promise<CaptureResult> {
    if (!this.finishing) {
      this.finishing = true
      this.stopTicker()
      this.tick({ final: true })
      void this.detach().finally(() => {
        this.videoIn.end()
        this.audioIn?.end()
        this.killAfter(30_000)
      })
    }
    return this.done
  }

  /** Stop without finishing the output. */
  abort(): Promise<CaptureResult> {
    if (!this.finishing) {
      this.finishing = true
      this.stopTicker()
      void this.detach()
    }
    this.killed = true
    this.failure ||= new Error('Capture was cancelled')
    this.ffmpeg.kill('SIGKILL')
    return this.done
  }

  get error(): Error | null {
    return this.failure
  }

  get stderr(): string[] {
    return [...this.stderrTail]
  }

  private wireProcess(): void {
    this.ffmpeg.stdin?.on('error', () => {})
    this.audioIn?.on('error', () => {})
    this.wireStderr()
    this.ffmpeg.once('close', (code, signal) => {
      this.stopTicker()
      const error = (() => {
        if (this.failure) {
          return this.failure
        }
        if (this.killed) {
          return undefined
        }
        if (code === 0) {
          return this.finishing ? undefined : new Error('ffmpeg exited before the capture was stopped')
        }
        const tail = this.stderrTail.slice(-5).join('\n')
        return new Error(`ffmpeg exited with ${signal || `code ${code}`}${tail ? `:\n${tail}` : ''}`)
      })()
      if (error) {
        this.failure = error
      }
      if (error && !this.killed) {
        this.logger?.error('[capture] failed:', error.message)
      }
      void this.detach().finally(() => {
        this.resolveDone({ duration: Math.round((this.stats.videoFrames * 1000) / this.fps), error })
      })
    })
  }

  private startTicker(): void {
    this.clockStart = performance.now()
    this.ticker = setInterval(() => {
      this.tick({ final: false })
    }, 1000 / this.fps)
  }

  private stopTicker(): void {
    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }

  /** Hook the page: frame source, close listeners, audio tap. */
  private async attachPage(): Promise<void> {
    const page = this.page

    const onClose = () => {
      void this.stop()
    }
    page.once('close', onClose)
    const browser = page.context().browser()
    browser?.once('disconnected', onClose)
    this.pageCleanups.push(async () => {
      page.off('close', onClose)
      browser?.off('disconnected', onClose)
    })

    await this.attachScreencast()
    if (this.audio) {
      await this.attachAudio()
    }
  }

  private async attachScreencast(): Promise<void> {
    const { session, page } = this
    const capturedFrames = this.stats.capturedFrames
    let resolveFirstFrame!: () => void
    const firstFrame = new Promise<void>((resolve) => {
      resolveFirstFrame = resolve
    })
    const onFrame = (event: { data: string }) => {
      this.latestFrame = Buffer.from(event.data, 'base64')
      this.stats.capturedFrames += 1
      this.rateWindow.frames += 1
      resolveFirstFrame()
    }
    session.on('Page.screencastFrame', onFrame)
    const siblings = capturesByPage.get(page) || new Set<PageCapture>()
    siblings.add(this)
    capturesByPage.set(page, siblings)
    this.pageCleanups.push(async () => {
      session.off('Page.screencastFrame', onFrame)
      siblings.delete(this)
      if (siblings.size > 0) {
        await this.sendScreencast({ page, session })
        return
      }
      capturesByPage.delete(page)
      await session.send('Page.stopScreencast')
    })
    await this.sendScreencast({ page, session })
    if (this.stats.capturedFrames > capturedFrames) {
      return
    }
    // Start screencast first: it wakes the compositor on pages where screenshots stall.
    // A live frame makes the seed optional; a late seed must not overwrite newer frames.
    await Promise.race([
      firstFrame,
      this.screenshot().then((frame) => {
        if (!this.finishing && this.stats.capturedFrames === capturedFrames) {
          this.latestFrame = frame
        }
      }),
    ])
  }

  private async attachAudio(): Promise<void> {
    const { session } = this
    const bindingName = `__playwriterAudio_${crypto.randomUUID().replace(/-/g, '')}`
    const source = `${getAudioTapCode()}\n;globalThis.__playwriterAudioTap(${JSON.stringify(bindingName)})`

    const onBinding = (event: { name: string; payload: string }) => {
      if (event.name !== bindingName) {
        return
      }
      const pcm = (() => {
        try {
          return (JSON.parse(event.payload) as { pcm?: string }).pcm
        } catch {
          return undefined
        }
      })()
      if (!pcm || this.finishing) {
        return
      }
      const chunk = Buffer.from(pcm, 'base64')
      this.audioQueue.push(chunk)
      this.audioQueuedBytes += chunk.length
      this.stats.audioChunks += 1
    }
    session.on('Runtime.bindingCalled', onBinding)
    await session.send('Runtime.addBinding', { name: bindingName })
    const { identifier } = await session.send('Page.addScriptToEvaluateOnNewDocument', { source })
    this.pageCleanups.push(async () => {
      session.off('Runtime.bindingCalled', onBinding)
      await Promise.allSettled([
        session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }),
        session.send('Runtime.evaluate', { expression: `globalThis.__playwriterAudioTapStop?.(${JSON.stringify(bindingName)})` }),
        session.send('Runtime.removeBinding', { name: bindingName }),
      ])
    })
    await session.send('Runtime.evaluate', { expression: source })
  }

  private async screenshot(): Promise<Buffer> {
    const { data } = await this.session.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: this.screencastParams.quality,
      optimizeForSpeed: true,
    })
    return Buffer.from(data, 'base64')
  }

  /**
   * Captures of one page share one CDP session, so the relay sees one client:
   * merge their params here. The relay merges across clients (skill recorder,
   * other sessions), so neither ever stops the other's frames.
   */
  private sendScreencast(target: { page: Page; session: PlaywrightCDPSessionAdapter } = { page: this.page, session: this.session }): Promise<unknown> {
    const siblings = [...(capturesByPage.get(target.page) || [])]
    return target.session.send('Page.startScreencast', mergeScreencastParams(siblings.map((capture) => {
      return capture.screencastParams
    })))
  }

  private detachPromise: Promise<void> | null = null

  /** Final cleanup. Runs once. */
  private detach(): Promise<void> {
    this.detachPromise ||= this.detachPage()
    return this.detachPromise
  }

  private async detachPage(): Promise<void> {
    const cleanups = this.pageCleanups.splice(0).reverse()
    for (const cleanup of cleanups) {
      await cleanup().catch(() => {})
    }
  }

  private killAfter(ms: number): void {
    const timer = setTimeout(() => {
      this.failure ||= new Error('Timeout waiting for ffmpeg to finish')
      this.ffmpeg.kill('SIGKILL')
    }, ms)
    void this.done.finally(() => {
      clearTimeout(timer)
    })
  }

  private wireStderr(): void {
    let remainder = ''
    this.ffmpeg.stderr?.on('data', (data: Buffer) => {
      remainder += data.toString()
      // progress lines end with \r, errors with \n
      const lines = remainder.split(/[\r\n]+/)
      remainder = lines.pop() || ''
      lines.forEach((raw) => {
        const line = this.redact(raw.trim())
        if (!line) {
          return
        }
        const progress = parseFfmpegProgressLine(line)
        if (progress) {
          this.stats.ffmpegFps = progress.fps ?? this.stats.ffmpegFps
          this.stats.ffmpegBitrateKbps = progress.bitrateKbps ?? this.stats.ffmpegBitrateKbps
          this.stats.droppedFrames = progress.droppedFrames ?? this.stats.droppedFrames
          return
        }
        this.stderrTail.push(line)
        if (this.stderrTail.length > STDERR_TAIL_SIZE) {
          this.stderrTail.shift()
        }
      })
    })
  }

  /** Write every output frame slot and audio sample due up to now. */
  private tick({ final }: { final: boolean }): void {
    if (this.failure) {
      return
    }
    const elapsedMs = performance.now() - this.clockStart
    const frameTarget = Math.floor((elapsedMs * this.fps) / 1000)
    while (this.stats.videoFrames < frameTarget) {
      this.videoIn.write(this.latestFrame)
      this.stats.videoFrames += 1
    }
    this.adaptFrameRate()
    if (this.audioIn) {
      const audioMs = final ? elapsedMs : elapsedMs - AUDIO_LATENCY_MS
      this.writeAudio(Math.floor((audioMs * AUDIO_SAMPLE_RATE) / 1000))
    }
    const buffered = this.videoIn.writableLength + (this.audioIn?.writableLength || 0)
    if (buffered > MAX_PIPE_BUFFERED_BYTES) {
      this.failure = new Error(`ffmpeg is too slow: ${buffered} bytes buffered. Lower fps or maxSize.`)
      this.logger?.error('[capture]', this.failure.message)
      this.ffmpeg.kill('SIGKILL')
    }
  }

  /**
   * Chrome sends a frame per compositor frame: 120-144 per second on ProMotion
   * and gaming displays, each a JPEG encode. Above 1.5x the output fps, ask for
   * every Nth frame only. Adapts once: other clients can change the delivered
   * rate, and static moments undercount.
   */
  private adaptFrameRate(): void {
    const windowMs = performance.now() - this.rateWindow.startedAt
    if (this.screencastParams.everyNthFrame > 1 || windowMs < 1000) {
      return
    }
    const deliveredRate = (this.rateWindow.frames * 1000) / windowMs
    this.rateWindow = { startedAt: performance.now(), frames: 0 }
    if (deliveredRate < this.fps * 1.5) {
      return
    }
    this.screencastParams = { ...this.screencastParams, everyNthFrame: Math.floor(deliveredRate / this.fps) }
    this.sendScreencast().catch(() => {})
  }

  /** Write queued page audio up to targetSamples, filling gaps with silence. */
  private writeAudio(targetSamples: number): void {
    const audioIn = this.audioIn
    if (!audioIn) {
      return
    }
    const maxQueued = ((AUDIO_MAX_QUEUE_MS * AUDIO_SAMPLE_RATE) / 1000) * AUDIO_BYTES_PER_SAMPLE
    while (this.audioQueuedBytes > maxQueued && this.audioQueue.length > 1) {
      this.audioQueuedBytes -= this.audioQueue.shift()!.length
    }
    let needed = (targetSamples - this.samplesWritten) * AUDIO_BYTES_PER_SAMPLE
    while (needed > 0) {
      const chunk = this.audioQueue[0]
      const bytes = chunk ? Math.min(chunk.length, needed) : needed
      audioIn.write(chunk ? chunk.subarray(0, bytes) : Buffer.alloc(bytes))
      if (chunk && bytes === chunk.length) {
        this.audioQueue.shift()
      } else if (chunk) {
        this.audioQueue[0] = chunk.subarray(bytes)
      }
      if (chunk) {
        this.audioQueuedBytes -= bytes
      }
      this.samplesWritten += bytes / AUDIO_BYTES_PER_SAMPLE
      needed -= bytes
    }
  }
}
