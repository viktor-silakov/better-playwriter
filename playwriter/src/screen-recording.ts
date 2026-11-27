/**
 * Screen recording to a file.
 *
 * Recording uses Chrome's native Page.startScreenRecording (Chrome 153+). Chrome
 * encodes AV1 + Opus fragmented MP4 out of process; we drain the IO stream while
 * it records, so stop is instant and a crash leaves a playable partial file:
 *
 *   Page.startScreenRecording ──> IO.read loop ──> .partial.mp4 (codec: 'av1')
 *                                       └──> ffmpeg -i pipe:0 ──> H.264 file (codec: 'h264')
 *
 * Native recording and Page.startScreencast exclude each other per tab: Chrome
 * answers "Screencast is already active" to the second one.
 *
 * Recordings live in the executor process, tied to the Playwright Page.
 * The relay stops native recordings of a client that disconnects.
 */

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import type { Page } from '@xmorse/playwright-core'
import { evaluateInPlaywriterWorld, getCDPSessionForPage, type PlaywrightCDPSessionAdapter } from './cdp-session.js'
import { detectEncoder, runCommand } from './ffmpeg.js'
import type { GhostCursorController } from './ghost-cursor-controller.js'

const STDERR_TAIL_SIZE = 20
const DEFAULT_ASPECT_RATIO = { width: 16, height: 9 }
const DEFAULT_RECORDING_MAX_DURATION_MS = 60 * 60 * 1000
/** Longest output edge: Retina 4K. Chrome never upscales past the viewport's device pixels. */
const DEFAULT_RECORDING_MAX_SIZE = 3840
const DEFAULT_RECORDING_FPS = 60
const MAX_RECORDING_FPS = 120
/** Chrome writes a fragment about every 2 s; poll faster so stop has little left to read. */
const DRAIN_INTERVAL_MS = 200
const IO_READ_CHUNK_BYTES = 4 * 1024 * 1024
const FFMPEG_FINISH_TIMEOUT_MS = 60_000
const MS_PER_SECOND = 1000

export interface Logger {
  log(...args: unknown[]): void
  error(...args: unknown[]): void
}

// ============================================================================
// Pure helpers (snapshot tested)
// ============================================================================

/**
 * Compute the largest viewport that fits inside `current` at the target aspect ratio.
 * Never increases width or height beyond current values.
 */
export function fitToAspectRatio(
  current: { width: number; height: number },
  ratio: { width: number; height: number } = DEFAULT_ASPECT_RATIO,
): { width: number; height: number } {
  const targetRatio = ratio.width / ratio.height
  const currentRatio = current.width / current.height
  if (currentRatio > targetRatio) {
    return { width: Math.round(current.height * targetRatio), height: current.height }
  }
  return { width: current.width, height: Math.round(current.width / targetRatio) }
}

/** Output size in device pixels, longest edge capped at maxSize, even for yuv420p. */
export function computeCaptureSize(options: {
  cssWidth: number
  cssHeight: number
  devicePixelRatio: number
  maxSize: number
}): { width: number; height: number } {
  const { cssWidth, cssHeight, devicePixelRatio, maxSize } = options
  const scale = Math.min(devicePixelRatio || 1, maxSize / Math.max(cssWidth, cssHeight))
  const even = (value: number) => {
    return Math.max(2, Math.round((value * scale) / 2) * 2)
  }
  return { width: even(cssWidth), height: even(cssHeight) }
}

/** Fix dimensions and SAR so viewport changes never reconfigure the encoder. */
export function fitFilter(options: { width: number; height: number }): string {
  const { width, height } = options
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p,setsar=1`
}

/** Bitrate for hardware encoders, sized for screen content. */
function screenBitrateKbps(options: { width: number; height: number; fps: number }): number {
  const kbps = Math.round((options.width * options.height * options.fps * 0.1) / 1000)
  return Math.min(20000, Math.max(2000, kbps))
}

/** H.264 video args for a file, hardware encoder when available. */
function h264Args(options: { codec: string; kbps: number }): string[] {
  const { codec, kbps } = options
  if (codec === 'libx264') {
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20']
  }
  if (codec === 'h264_videotoolbox') {
    return ['-c:v', codec, '-b:v', `${kbps}k`, '-realtime', 'true']
  }
  return ['-c:v', codec, '-b:v', `${kbps}k`]
}

/**
 * ffmpeg argv that transcodes Chrome's native AV1/Opus fragmented MP4 from stdin
 * to H.264/AAC while recording. Frames keep Chrome's variable timestamps; the
 * fixed size makes segments of one recording concat with `-c copy`.
 */
export function buildTranscodeFfmpegArgs(options: {
  width: number
  height: number
  fps: number
  audio: boolean
  codec: string
  outputPath: string
}): string[] {
  const { width, height, fps, audio, codec, outputPath } = options
  const extension = path.extname(outputPath).toLowerCase()
  const kbps = screenBitrateKbps({ width, height, fps })
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'mp4', '-i', 'pipe:0',
    '-map', '0:v:0', ...(audio ? ['-map', '0:a:0?'] : []),
    '-vf', fitFilter({ width, height }),
    '-fps_mode', 'passthrough',
    ...h264Args({ codec, kbps }),
    ...(audio ? ['-c:a', 'aac', '-b:a', '160k'] : []),
    // MP4 picks the track timescale from the guessed frame rate. Segments of one recording
    // need the same one, else concat -c copy stretches the later ones. mkv always uses 1 ms.
    ...(extension === '.mkv' ? [] : ['-video_track_timescale', '90000', '-movflags', '+faststart']),
    '-y', outputPath,
  ]
}

// ============================================================================
// Recording to a file: Chrome's native Page.startScreenRecording
// ============================================================================

/**
 * Which wall-clock time ends up in the video:
 * - `real`: all of it, from start to stop. Agent think time is in the video.
 * - `manual`: only time inside `wait(ms)`. The page keeps running in between,
 *   but nothing is recorded, so agent latency between execute calls is cut.
 */
export type RecordingClock = 'real' | 'manual'

/** `h264`: transcoded live by ffmpeg, plays everywhere. `av1`: Chrome's own output, no ffmpeg. */
export type RecordingCodec = 'h264' | 'av1'

/** Why a recording ended. Anything but `stopped` means nobody called stop(). */
export type RecordingEndReason = 'stopped' | 'max-duration' | 'page-closed' | 'chrome-ended'

/** Codecs each container can hold, default first */
const RECORDING_CODECS: Record<string, RecordingCodec[]> = {
  '.mp4': ['h264', 'av1'],
  '.mov': ['h264'],
  '.mkv': ['h264', 'av1'],
  '.webm': ['av1'],
}

// TODO: drop this augmentation once the devtools-protocol dependency ships Page.startScreenRecording.
// https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreenRecording
declare module 'devtools-protocol/types/protocol-mapping.js' {
  namespace ProtocolMapping {
    interface Commands {
      'Page.startScreenRecording': {
        paramsType: [{ frameRate?: number; maxWidth?: number; maxHeight?: number; audio?: boolean }?]
        returnType: { stream: string }
      }
      'Page.stopScreenRecording': {
        paramsType: []
        returnType: { stream: string }
      }
    }
  }
}

function nativeStartError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes("wasn't found")) {
    return new Error('Recording needs Chrome 153 or newer (CDP Page.startScreenRecording is missing). Update Chrome.', { cause: error })
  }
  if (message.includes('Screencast is already active')) {
    return new Error(
      'This tab already has a screencast: another recording, a stream, the skill recorder or a live view. Stop it first.',
      { cause: error },
    )
  }
  return new Error(`Could not start recording: ${message}`, { cause: error })
}

/** Where drained bytes go: a file (av1) or ffmpeg's stdin (h264) */
interface SegmentSink {
  /** Resolves with an error when the writer failed (ffmpeg exited, disk full) */
  write(chunk: Buffer): Promise<Error | undefined>
  /** Flush and close. Resolves with the writer's error, if any. */
  close(): Promise<Error | undefined>
  abort(): void
}

function openFileSink(filePath: string): SegmentSink {
  const file = fs.createWriteStream(filePath)
  let failure: Error | undefined
  const finished = new Promise<void>((resolve) => {
    file.once('close', () => {
      resolve()
    })
    file.once('error', (error) => {
      failure ||= error
      resolve()
    })
  })
  return {
    async write(chunk) {
      if (!file.write(chunk)) {
        await Promise.race([once(file, 'drain'), finished])
      }
      return failure
    },
    async close() {
      file.end()
      await finished
      return failure
    },
    abort() {
      file.destroy()
    },
  }
}

async function openFfmpegSink(options: { args: string[]; logger?: Logger }): Promise<SegmentSink> {
  const { args, logger } = options
  logger?.log(`[recording] ffmpeg ${args.join(' ')}`)
  const ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
  const spawnError = await new Promise<Error | null>((resolve) => {
    ffmpeg.once('spawn', () => {
      resolve(null)
    })
    ffmpeg.once('error', (error) => {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      resolve(missing ? new Error("ffmpeg not found. Install ffmpeg for H.264 output, or pass codec: 'av1' to record without it.") : error)
    })
  })
  if (spawnError) {
    throw spawnError
  }
  const stderrTail: string[] = []
  ffmpeg.stderr?.on('data', (data: Buffer) => {
    stderrTail.push(...data.toString().split('\n').filter(Boolean))
    stderrTail.splice(0, Math.max(0, stderrTail.length - STDERR_TAIL_SIZE))
  })
  const stdin = ffmpeg.stdin!
  stdin.on('error', () => {})
  const exited = new Promise<Error | undefined>((resolve) => {
    ffmpeg.once('close', (code, signal) => {
      if (code === 0) {
        resolve(undefined)
        return
      }
      const tail = stderrTail.slice(-5).join('\n')
      resolve(new Error(`ffmpeg exited with ${signal || `code ${code}`}${tail ? `:\n${tail}` : ''}`))
    })
  })
  return {
    async write(chunk) {
      const accepted = stdin.write(chunk)
      const error = accepted ? undefined : await Promise.race([once(stdin, 'drain').then(() => undefined), exited])
      return error || (ffmpeg.exitCode !== null ? new Error('ffmpeg exited while recording') : undefined)
    },
    async close() {
      stdin.end()
      const timer = setTimeout(() => {
        ffmpeg.kill('SIGKILL')
      }, FFMPEG_FINISH_TIMEOUT_MS)
      const error = await exited
      clearTimeout(timer)
      return error
    },
    abort() {
      ffmpeg.kill('SIGKILL')
    },
  }
}

type SegmentEnd = Exclude<RecordingEndReason, 'max-duration'>

/**
 * One native recording run on one page, drained into a sink while it records.
 * Chrome writes `ftyp moov (moof mdat)*`, so the bytes drained so far are always
 * a playable file. A recording uses several segments for `wait()` windows and
 * tab switches, joined at stop.
 */
class NativeSegment {
  readonly page: Page
  readonly path: string
  readonly startedAt = performance.now()
  /** Bytes received from Chrome */
  bytes = 0
  /** Resolves once every byte is written and the sink is closed */
  readonly done: Promise<{ end: SegmentEnd; error?: Error }>
  private endedAt: number | null = null
  private readonly cdp: PlaywrightCDPSessionAdapter
  private readonly handle: string
  private readonly sink: SegmentSink
  /** Aborted to stop waiting between reads: stop requested or page gone */
  private readonly wake = new AbortController()
  private chromeStopped = false
  private end: SegmentEnd = 'stopped'
  private stopPromise: Promise<{ end: SegmentEnd; error?: Error }> | null = null

  private constructor(options: { page: Page; path: string; cdp: PlaywrightCDPSessionAdapter; handle: string; sink: SegmentSink }) {
    this.page = options.page
    this.path = options.path
    this.cdp = options.cdp
    this.handle = options.handle
    this.sink = options.sink
    this.done = this.run()
  }

  static async start(options: {
    page: Page
    path: string
    fps: number
    maxSize: number
    audio: boolean
    /** Set for h264: live transcode to this size with this ffmpeg encoder */
    transcode: { encoder: string; width: number; height: number } | null
    logger?: Logger
  }): Promise<NativeSegment> {
    const { page, fps, maxSize, audio, transcode, logger } = options
    const sink = transcode
      ? await openFfmpegSink({
          args: buildTranscodeFfmpegArgs({ ...transcode, codec: transcode.encoder, fps, audio, outputPath: options.path }),
          logger,
        })
      : openFileSink(options.path)
    const cdp = await getCDPSessionForPage({ page })
    // maxWidth and maxHeight are always sent: Chrome's own box is 800x600
    const started = await cdp
      .send('Page.startScreenRecording', { frameRate: fps, maxWidth: maxSize, maxHeight: maxSize, audio })
      .then(
        (result) => result,
        (error: unknown) => nativeStartError(error),
      )
    if (started instanceof Error) {
      sink.abort()
      fs.rmSync(options.path, { force: true })
      throw started
    }
    return new NativeSegment({ page, path: options.path, cdp, handle: started.stream, sink })
  }

  /** Wall time from start to the end of recording */
  get wallMs(): number {
    return (this.endedAt ?? performance.now()) - this.startedAt
  }

  /** Stop recording and wait until the file is complete. Safe to call more than once. */
  stop(): Promise<{ end: SegmentEnd; error?: Error }> {
    this.stopPromise ||= (async () => {
      if (!this.page.isClosed()) {
        const stopped = await this.cdp.send('Page.stopScreenRecording').then(
          () => true,
          () => false,
        )
        // "No active screen recording": Chrome ended it on its own
        if (!stopped && !this.page.isClosed()) {
          this.end = 'chrome-ended'
        }
      }
      this.endedAt ??= performance.now()
      this.chromeStopped = true
      this.wake.abort()
      return this.done
    })()
    return this.stopPromise
  }

  private async run(): Promise<{ end: SegmentEnd; error?: Error }> {
    const onGone = () => {
      this.wake.abort()
    }
    const browser = this.page.context().browser()
    this.page.once('close', onGone)
    browser?.once('disconnected', onGone)
    const drainError = await this.drain()
    this.page.off('close', onGone)
    browser?.off('disconnected', onGone)
    this.endedAt ??= performance.now()
    await this.cdp.send('IO.close', { handle: this.handle }).catch(() => {})
    const sinkError = await this.sink.close()
    return { end: this.end, error: drainError || sinkError }
  }

  /** Read the stream until Chrome stopped and everything is read, or the page is gone. */
  private async drain(): Promise<Error | undefined> {
    while (true) {
      if (this.page.isClosed()) {
        this.end = 'page-closed'
        return undefined
      }
      if (this.page.context().browser()?.isConnected() === false) {
        this.end = 'chrome-ended'
        return undefined
      }
      // A read sent before stop can answer after it: only a read sent after stop proves the end
      const stoppedBeforeRead = this.chromeStopped
      const read = await this.cdp.send('IO.read', { handle: this.handle, size: IO_READ_CHUNK_BYTES }).then(
        (result) => result,
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      )
      if (read instanceof Error) {
        if (this.page.isClosed()) {
          continue
        }
        // Chrome answers "Read failed" until it writes the first fragment (~2 s)
        if (read.message.includes('Read failed') && this.bytes === 0) {
          if (stoppedBeforeRead) {
            return undefined
          }
          await this.pause()
          continue
        }
        this.end = 'chrome-ended'
        return read
      }
      if (read.data) {
        const chunk = Buffer.from(read.data, read.base64Encoded ? 'base64' : 'utf8')
        this.bytes += chunk.length
        const writeError = await this.sink.write(chunk)
        if (writeError) {
          await this.cdp.send('Page.stopScreenRecording').catch(() => {})
          this.end = 'chrome-ended'
          return writeError
        }
      }
      // While recording, eof only means "caught up"
      if (!read.eof) {
        continue
      }
      if (stoppedBeforeRead) {
        return undefined
      }
      await this.pause()
    }
  }

  private async pause(): Promise<void> {
    await delay(DRAIN_INTERVAL_MS, undefined, { signal: this.wake.signal }).catch(() => {})
  }
}

export interface StartRecordingOptions {
  page: Page
  /** Output file. Container from the extension: .mp4 (default choice), .mov, .mkv, .webm */
  outputPath: string
  /** `h264` (default; needs ffmpeg) or `av1` (Chrome's own output, no ffmpeg). .webm is always av1. */
  codec?: RecordingCodec
  /** Max frame rate (default 60, max 120). Chrome writes only changed frames, so idle pages cost little. */
  frameRate?: number
  /** Record tab audio (default false) */
  audio?: boolean
  /** Longest output edge in pixels (default 3840). Output is the viewport in device pixels, never upscaled. */
  maxSize?: number
  /** `real` (default) records all wall-clock time. `manual` records only inside `wait(ms)`. */
  clock?: RecordingClock
  logger?: Logger
}

export interface RecordingResult {
  path: string
  /** Recorded wall time in ms (for clock: 'manual', the sum of wait() windows) */
  duration: number
  /** File size in bytes */
  size: number
  endReason: RecordingEndReason
}

interface RecordedSegment {
  segment: NativeSegment
  /** clock: 'manual' window length; the video gets exactly this much time */
  windowMs: number | null
}

/** A screen recording of one page (or several, with setPage), written to outputPath on stop. */
export class ScreenRecording {
  readonly outputPath: string
  readonly codec: RecordingCodec
  readonly clock: RecordingClock
  readonly startedAt = Date.now()
  /** Settles once the file is finished, also when the page closed on its own */
  readonly result: Promise<RecordingResult>
  private readonly fps: number
  private readonly audio: boolean
  private readonly maxSize: number
  private readonly encoder: string | null
  private readonly logger?: Logger
  private currentPage: Page
  private readonly segments: RecordedSegment[] = []
  private active: NativeSegment | null = null
  /** h264 output size, fixed by the first segment so segments concat with -c copy */
  private outputSize: { width: number; height: number } | null = null
  private ending: RecordingEndReason | null = null
  private cancelled = false
  /** Segment being started; finish() waits for it so no recording is left running */
  private starting: Promise<unknown> | null = null
  /** Unique prefix of the visible partial files, so recordings to one path never collide */
  private readonly partialBase: string
  private resolveEnding!: (reason: RecordingEndReason) => void
  private unwatchPage: () => void = () => {}

  private constructor(options: {
    outputPath: string
    codec: RecordingCodec
    encoder: string | null
    clock: RecordingClock
    fps: number
    audio: boolean
    maxSize: number
    page: Page
    logger?: Logger
  }) {
    this.outputPath = options.outputPath
    this.codec = options.codec
    this.encoder = options.encoder
    this.clock = options.clock
    this.fps = options.fps
    this.audio = options.audio
    this.maxSize = options.maxSize
    this.currentPage = options.page
    this.logger = options.logger
    const extension = path.extname(this.outputPath)
    this.partialBase = path.join(
      path.dirname(this.outputPath),
      `${path.basename(this.outputPath, extension)}.${crypto.randomUUID().slice(0, 8)}.partial`,
    )
    const ended = new Promise<RecordingEndReason>((resolve) => {
      this.resolveEnding = resolve
    })
    this.result = ended.then((reason) => {
      return this.finish(reason)
    })
    // stop() and cancel() surface errors; avoid unhandled rejections otherwise
    this.result.catch(() => {})
    this.watchPage()
  }

  static async start(options: StartRecordingOptions): Promise<ScreenRecording> {
    const outputPath = path.resolve(options.outputPath)
    const extension = path.extname(outputPath).toLowerCase()
    const codecs: RecordingCodec[] | undefined = RECORDING_CODECS[extension]
    if (!codecs) {
      throw new Error(`Unsupported recording extension "${extension}". Use .mp4, .mov, .mkv or .webm.`)
    }
    const codec = options.codec ?? codecs[0]
    if (!codecs.includes(codec)) {
      throw new Error(`${extension} files cannot hold ${codec} video. Use ${codecs.join(' or ')}, or another extension.`)
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    const recording = new ScreenRecording({
      outputPath,
      codec,
      encoder: codec === 'h264' ? (await detectEncoder()).codec : null,
      clock: options.clock ?? 'real',
      fps: Math.min(MAX_RECORDING_FPS, Math.max(1, Math.round(options.frameRate ?? DEFAULT_RECORDING_FPS))),
      audio: options.audio ?? false,
      maxSize: options.maxSize ?? DEFAULT_RECORDING_MAX_SIZE,
      page: options.page,
      logger: options.logger,
    })
    if (recording.clock === 'real') {
      await recording.startSegment({ windowMs: null }).catch(async (error: unknown) => {
        await recording.cancel()
        throw error
      })
    }
    return recording
  }

  get page(): Page {
    return this.currentPage
  }

  get isRecording(): boolean {
    return this.ending === null
  }

  get isCancelled(): boolean {
    return this.cancelled
  }

  /** Bytes received from Chrome so far */
  get bytes(): number {
    return this.segments.reduce((sum, entry) => sum + entry.segment.bytes, 0)
  }

  /** Record another page from now on. The output size stays the same. */
  async setPage(page: Page): Promise<void> {
    if (this.ending) {
      throw new Error('Recording already stopped')
    }
    if (page === this.currentPage) {
      return
    }
    this.unwatchPage()
    this.currentPage = page
    this.watchPage()
    if (this.clock === 'manual') {
      return
    }
    await this.stopActive()
    await this.startSegment({ windowMs: null }).catch(async (error: unknown) => {
      await this.stop()
      throw new Error('Could not move the recording to the new page. The recording was stopped.', { cause: error })
    })
  }

  /**
   * Manual clock only. Record the next `ms` of real time, then pause again.
   * The video grows by exactly `ms`.
   */
  async wait(ms: number): Promise<void> {
    if (this.clock !== 'manual') {
      throw new Error('wait() needs a recording started with clock: "manual"')
    }
    if (this.ending) {
      throw new Error('Recording already stopped')
    }
    if (this.active) {
      throw new Error('wait() is already running. Await it before calling it again.')
    }
    const segment = await this.startSegment({ windowMs: ms })
    await Promise.race([delay(ms), segment.done])
    if (this.active === segment) {
      await this.stopActive()
    }
  }

  /** Stop and finish the file. */
  stop(reason: RecordingEndReason = 'stopped'): Promise<RecordingResult> {
    this.end(reason)
    return this.result
  }

  /** Stop and delete everything recorded. */
  async cancel(): Promise<void> {
    this.cancelled = true
    this.end('stopped')
    await this.result.catch(() => {})
  }

  private end(reason: RecordingEndReason): void {
    if (this.ending) {
      return
    }
    this.ending = reason
    this.resolveEnding(reason)
  }

  private watchPage(): void {
    const page = this.currentPage
    const browser = page.context().browser()
    const onClose = () => {
      this.end('page-closed')
    }
    const onDisconnect = () => {
      this.end('chrome-ended')
    }
    page.once('close', onClose)
    browser?.once('disconnected', onDisconnect)
    this.unwatchPage = () => {
      page.off('close', onClose)
      browser?.off('disconnected', onDisconnect)
    }
  }

  private startSegment({ windowMs }: { windowMs: number | null }): Promise<NativeSegment> {
    if (this.ending) {
      return Promise.reject(new Error('Recording already stopped'))
    }
    const starting = this.openSegment({ windowMs })
    this.starting = starting
    void starting.catch(() => {}).finally(() => {
      if (this.starting === starting) {
        this.starting = null
      }
    })
    return starting
  }

  private async openSegment({ windowMs }: { windowMs: number | null }): Promise<NativeSegment> {
    const page = this.currentPage
    const index = this.segments.length
    // h264 segments are already in the output container; av1 segments are Chrome's MP4
    const segmentExtension = this.codec === 'h264' ? path.extname(this.outputPath) : '.mp4'
    const segmentPath = `${this.partialBase}${index === 0 ? '' : `-${index + 1}`}${segmentExtension}`
    const transcode = this.encoder ? { encoder: this.encoder, ...(this.outputSize ||= await this.measure(page)) } : null
    const segment = await NativeSegment.start({
      page,
      path: segmentPath,
      fps: this.fps,
      maxSize: this.maxSize,
      audio: this.audio,
      transcode,
      logger: this.logger,
    })
    this.segments.push({ segment, windowMs })
    this.active = segment
    void segment.done.then((result) => {
      if (this.active === segment && result.end !== 'stopped') {
        this.end(result.end)
      }
    })
    return segment
  }

  private async stopActive(): Promise<void> {
    const segment = this.active
    if (!segment) {
      return
    }
    this.active = null
    await segment.stop()
  }

  /** Chrome's output size: viewport in device pixels, fit in maxSize, never upscaled. */
  private async measure(page: Page): Promise<{ width: number; height: number }> {
    const viewport = await evaluateInPlaywriterWorld<{ width: number; height: number; dpr: number }>({
      page,
      expression: '({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })',
    })
    return computeCaptureSize({
      cssWidth: viewport.width,
      cssHeight: viewport.height,
      devicePixelRatio: viewport.dpr,
      maxSize: this.maxSize,
    })
  }

  private async finish(reason: RecordingEndReason): Promise<RecordingResult> {
    this.unwatchPage()
    await this.starting?.catch(() => {})
    await this.stopActive()
    const results = await Promise.all(this.segments.map((entry) => entry.segment.done))
    const partials = this.segments.map((entry) => entry.segment.path)
    if (this.cancelled) {
      partials.forEach((file) => fs.rmSync(file, { force: true }))
      throw new Error('Recording was cancelled')
    }
    const failed = results.find((result) => result.error)?.error
    if (failed) {
      throw new Error(`Recording failed: ${failed.message}\nPartial files kept: ${partials.join(', ')}`, { cause: failed })
    }
    const recorded = this.segments.filter((entry) => entry.segment.bytes > 0)
    this.segments.filter((entry) => entry.segment.bytes === 0).forEach((entry) => fs.rmSync(entry.segment.path, { force: true }))
    if (recorded.length === 0) {
      throw new Error(this.clock === 'manual' ? 'Nothing was recorded. Call wait(ms) to record.' : 'Chrome sent no video. The page closed or Chrome ended the recording right away.')
    }
    const durations = recorded.map((entry) => {
      const wallMs = entry.segment.wallMs
      return entry.windowMs === null ? wallMs : Math.min(entry.windowMs, wallMs)
    })
    await this.join({ files: recorded.map((entry) => entry.segment.path), durations })
    return {
      path: this.outputPath,
      duration: Math.round(durations.reduce((sum, ms) => sum + ms, 0)),
      size: fs.statSync(this.outputPath).size,
      endReason: reason,
    }
  }

  /** Move or concat segments into the output file. */
  private async join({ files, durations }: { files: string[]; durations: number[] }): Promise<void> {
    const extension = path.extname(this.outputPath).toLowerCase()
    if (files.length === 1 && (this.codec === 'h264' || extension === '.mp4')) {
      fs.renameSync(files[0], this.outputPath)
      return
    }
    const listPath = `${this.partialBase}-list.txt`
    const joinedPath = `${this.partialBase}-joined${path.extname(this.outputPath)}`
    // The concat demuxer starts each file at the sum of the previous durations
    const list = files
      .map((file, index) => {
        return `file '${file.replaceAll("'", "'\\''")}'\nduration ${(durations[index] / MS_PER_SECOND).toFixed(3)}`
      })
      .join('\n')
    fs.writeFileSync(listPath, `${list}\n`)
    try {
      await runCommand({
        bin: 'ffmpeg',
        args: [
          '-hide_banner', '-loglevel', 'error', '-nostdin',
          '-f', 'concat', '-safe', '0', '-i', listPath,
          '-c', 'copy',
          ...(extension === '.mp4' || extension === '.mov' ? ['-movflags', '+faststart'] : []),
          '-y', joinedPath,
        ],
      })
    } catch (error) {
      fs.rmSync(joinedPath, { force: true })
      throw new Error(`Could not join recording segments. Partial files kept: ${files.join(', ')}`, { cause: error })
    } finally {
      fs.rmSync(listPath, { force: true })
    }
    fs.renameSync(joinedPath, this.outputPath)
    files.forEach((file) => fs.rmSync(file, { force: true }))
  }
}

/** Start recording a page to a video file. Call `stop()` on the result to save it. */
export function startRecording(options: StartRecordingOptions): Promise<ScreenRecording> {
  return ScreenRecording.start(options)
}

// ============================================================================
// Executor sandbox API: `recording.*`
// ============================================================================

export interface ExecutionTimestamp {
  start: number
  end: number
}

export interface CaptureTargetOptions {
  page?: Page
}

const RECORDING_TARGET_REQUIRED =
  'requires an explicit target tab, e.g. ({ page: state.page }). There is no default page; create one with `state.page = await context.newPage()`.'

export function requirePage(helper: string, target?: CaptureTargetOptions): Page {
  if (!target?.page) {
    throw new Error(`${helper} ${RECORDING_TARGET_REQUIRED}`)
  }
  return target.page
}

export interface SandboxStartRecordingOptions extends Omit<StartRecordingOptions, 'page' | 'logger'> {
  page: Page
  /** Fit the viewport to this aspect ratio first (default 16:9, only shrinks). null skips resizing. */
  aspectRatio?: { width: number; height: number } | null
  /** Auto-stop after this many ms of wall time (default 60 min). 0 or Infinity disables it. */
  maxDurationMs?: number
}

export type RecordingHandleResult = RecordingResult & { executionTimestamps: ExecutionTimestamp[] }

type AspectRatio = { width: number; height: number } | null
type ViewportSize = { width: number; height: number }

/** Set the viewport, returning a function that restores the old one. */
async function setViewport(options: { page: Page; size: ViewportSize | null }): Promise<() => Promise<void>> {
  const { page, size } = options
  const current = page.viewportSize()
  if (!size || !current || (size.width === current.width && size.height === current.height)) {
    return async () => {}
  }
  await page.setViewportSize(size)
  return async () => {
    if (!page.isClosed()) {
      await page.setViewportSize(current).catch(() => {})
    }
  }
}

/** Shrink the viewport to the aspect ratio. Returns a function that restores it. */
async function fitViewport(options: { page: Page; aspectRatio: AspectRatio }): Promise<() => Promise<void>> {
  const { page, aspectRatio } = options
  const current = page.viewportSize()
  if (!aspectRatio || !current) {
    return async () => {}
  }
  return setViewport({ page, size: fitToAspectRatio(current, aspectRatio) })
}

type RecordingOutcome = { result?: RecordingResult; error?: unknown }

/**
 * Returned by `recording.start()` in the sandbox. Keep it in `state` to stop
 * it, add frames or switch tabs in later execute calls.
 */
export class RecordingHandle {
  private readonly recording: ScreenRecording
  private readonly ghostCursorController: GhostCursorController
  /** Settles when the recording ends for any reason: stop, max duration, page closed, failure */
  private readonly settled: Promise<RecordingOutcome & { executionTimestamps: ExecutionTimestamp[] }>
  private readonly autoStopAt: number | null
  private restoreViewport: () => Promise<void>
  private completed = false

  constructor(options: {
    recording: ScreenRecording
    restoreViewport: () => Promise<void>
    ghostCursorController: GhostCursorController
    maxDurationMs: number
    onFinish: (outcome: RecordingOutcome) => void
    getExecutionTimestamps: () => ExecutionTimestamp[]
  }) {
    const { recording, maxDurationMs, onFinish, getExecutionTimestamps } = options
    this.recording = recording
    this.restoreViewport = options.restoreViewport
    this.ghostCursorController = options.ghostCursorController

    const autoStop = maxDurationMs > 0 && maxDurationMs < Infinity
    this.autoStopAt = autoStop ? Date.now() + maxDurationMs : null
    const maxDurationTimer = autoStop
      ? setTimeout(() => {
          void recording.stop('max-duration').catch(() => {})
        }, maxDurationMs)
      : null

    this.settled = recording.result
      .then(
        (result): RecordingOutcome => {
          return { result }
        },
        (error: unknown): RecordingOutcome => {
          return { error }
        },
      )
      .then(async (outcome) => {
        // Idle detection for createDemoVideo only makes sense on wall-clock video
        const executionTimestamps = this.clock === 'real' ? [...getExecutionTimestamps()] : []
        this.completed = true
        if (maxDurationTimer) {
          clearTimeout(maxDurationTimer)
        }
        onFinish(outcome)
        await this.restoreViewport()
        return { ...outcome, executionTimestamps }
      })
  }

  get page(): Page {
    return this.recording.page
  }

  get clock(): RecordingClock {
    return this.recording.clock
  }

  get outputPath(): string {
    return this.recording.outputPath
  }

  get startedAt(): number {
    return this.recording.startedAt
  }

  get isRecording(): boolean {
    return !this.completed
  }

  /** Record another tab from now on, at the same viewport size. The ghost cursor moves with it. */
  async setPage(page: Page): Promise<void> {
    if (this.completed) {
      throw new Error('Recording already stopped')
    }
    if (page === this.page) {
      return
    }
    this.ghostCursorController.attachToPage({ page })
    // Same CSS size on the new tab, so every segment has the output size
    const restoreNewViewport = await setViewport({ page, size: this.page.viewportSize() })
    try {
      await this.recording.setPage(page)
    } catch (error) {
      await restoreNewViewport()
      throw error
    }
    await this.restoreViewport()
    this.restoreViewport = restoreNewViewport
    // Ended while switching: the final cleanup already ran with the old restore
    if (this.completed) {
      await restoreNewViewport()
    }
  }

  /** clock: 'manual' only. Record the next `ms` of real time. */
  wait(ms: number): Promise<void> {
    return this.recording.wait(ms)
  }

  /** Finish the file. Also returns the file if the recording already ended on its own. */
  async stop(): Promise<RecordingHandleResult> {
    await this.recording.stop().catch(() => {})
    const outcome = await this.settled
    if (!outcome.result) {
      throw outcome.error
    }
    return { ...outcome.result, executionTimestamps: outcome.executionTimestamps }
  }

  /** Stop without saving the file. */
  async cancel(): Promise<void> {
    await this.recording.cancel()
    await this.settled
  }

  /** Short summary when an agent logs or returns the handle */
  [util.inspect.custom](): object {
    return {
      outputPath: this.outputPath,
      clock: this.clock,
      isRecording: this.isRecording,
      page: this.page.isClosed() ? '(closed)' : this.page.url(),
      elapsedSec: Math.round((Date.now() - this.startedAt) / MS_PER_SECOND),
      bytes: this.recording.bytes,
      autoStopInSec: this.autoStopAt === null || this.completed ? null : Math.max(0, Math.round((this.autoStopAt - Date.now()) / MS_PER_SECOND)),
    }
  }
}

export function createRecordingApi(options: {
  ghostCursorController: GhostCursorController
  logger: Logger
  /** Session cwd: relative output paths resolve against it */
  cwd: string | null
  onStart: () => void
  onFinish: () => void
  /** Shown in the next execute output: recordings that ended without stop() or failed */
  onWarning: (message: string) => void
  getExecutionTimestamps: () => ExecutionTimestamp[]
}): {
  start: (opts: SandboxStartRecordingOptions) => Promise<RecordingHandle>
  stop: (opts?: CaptureTargetOptions) => Promise<RecordingHandleResult>
} {
  const { ghostCursorController, logger, cwd, onStart, onFinish, onWarning, getExecutionTimestamps } = options
  const active = new Set<RecordingHandle>()

  return {
    start: async (opts) => {
      const page = requirePage('recording.start', opts)
      const existing = [...active].find((handle) => handle.page === page)
      if (existing) {
        throw new Error(`This page is already recording to ${existing.outputPath}. Call recording.stop({ page }) first.`)
      }
      if (!opts.outputPath) {
        throw new Error('recording.start needs an outputPath, e.g. { outputPath: "demo.mp4" }')
      }
      const outputPath = path.resolve(cwd || process.cwd(), opts.outputPath)
      ghostCursorController.attachToPage({ page })
      const restoreViewport = await fitViewport({ page, aspectRatio: opts.aspectRatio === undefined ? DEFAULT_ASPECT_RATIO : opts.aspectRatio })
      const recording = await ScreenRecording.start({ ...opts, outputPath, page, logger }).catch(async (error: unknown) => {
        await restoreViewport()
        throw error
      })
      const realClock = recording.clock === 'real'
      if (realClock) {
        onStart()
      }
      const handle: RecordingHandle = new RecordingHandle({
        recording,
        restoreViewport,
        ghostCursorController,
        maxDurationMs: opts.maxDurationMs ?? DEFAULT_RECORDING_MAX_DURATION_MS,
        onFinish: (outcome) => {
          active.delete(handle)
          if (realClock) {
            onFinish()
          }
          if (outcome.error && !recording.isCancelled) {
            const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
            onWarning(`Recording to ${outputPath} failed: ${message}`)
          }
          const reason = outcome.result?.endReason
          if (reason && reason !== 'stopped') {
            onWarning(`Recording ended without stop() (${reason}). Saved ${outcome.result?.path}`)
          }
        },
        getExecutionTimestamps,
      })
      active.add(handle)
      return handle
    },

    stop: async (opts) => {
      const handles = [...active]
      const handle = opts?.page ? handles.find((item) => item.page === opts.page) : handles[0]
      if (!opts?.page && handles.length > 1) {
        throw new Error('recording.stop: several recordings are active. Pass { page } to pick one.')
      }
      if (!handle) {
        throw new Error('No active recording')
      }
      return handle.stop()
    },
  }
}
