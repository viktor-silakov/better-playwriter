import type { Page } from '@xmorse/playwright-core'
import { detectEncoder, supportsInputThreadQueue } from './ffmpeg.js'
import type { CaptureStats, PageCapture } from './rtmp-capture.js'
import { requirePage, type CaptureTargetOptions, type Logger } from './screen-recording.js'

export interface StartStreamOptions {
  page: Page
  /** RTMP destination URLs (or any ffmpeg-writable flv target, e.g. a file path for testing) */
  rtmpUrls: string[]
  /** Output resolution as WxH (default 1920x1080, X Live recommended) */
  resolution?: string
  /** Output frame rate (default 30) */
  fps?: number
  /** Video bitrate in kbps (default 9000, X Live recommended) */
  videoBitrateKbps?: number
  /** Audio bitrate in kbps (default 128) */
  audioBitrateKbps?: number
  /** Keyframe interval in seconds (default 3, X Live recommended and its max; Twitch recommends 2) */
  keyframeSeconds?: number
  /** Stream page audio (default true). When false a silent track is sent, because X Live rejects streams without audio. */
  audio?: boolean
  /** x264 preset (default veryfast). Only applies to libx264. */
  preset?: string
  /** Video codec for ffmpeg -c:v (default: hardware encoder when available, else libx264) */
  codec?: string
  logger?: Logger
}

export interface StreamStatus {
  streaming: boolean
  startedAt?: number
  /** Destinations with stream keys redacted */
  destinations?: string[]
  stats?: CaptureStats
  /** Why the last stream ended unexpectedly (ffmpeg crash, RTMP failure) */
  error?: string
}

/** A live stream of one page to RTMP destinations. Runs until stop() or the page closes. */
export class ScreenStream {
  readonly destinations: string[]
  readonly capture: PageCapture

  private constructor(options: { destinations: string[]; capture: PageCapture }) {
    this.destinations = options.destinations
    this.capture = options.capture
  }

  static async start(options: StartStreamOptions): Promise<ScreenStream> {
    if (!options.rtmpUrls || options.rtmpUrls.length === 0) {
      throw new Error('rtmpUrls is required')
    }
    const resolution = options.resolution || '1920x1080'
    const resolutionMatch = resolution.match(/^(\d+)x(\d+)$/)
    if (!resolutionMatch) {
      throw new Error(`Invalid resolution "${resolution}", expected WxH like 1920x1080`)
    }
    const { PageCapture, buildStreamFfmpegArgs, redactStreamUrl } = await import('./rtmp-capture.js')
    const rawUrls = options.rtmpUrls
    const redact = (line: string) => {
      return rawUrls.reduce((acc, url) => {
        return acc.replaceAll(url, redactStreamUrl(url))
      }, line)
    }
    const codec = options.codec || (await detectEncoder()).codec
    const inputThreadQueue = await supportsInputThreadQueue()
    const capture = await PageCapture.start({
      page: options.page,
      fps: options.fps || 30,
      audio: options.audio !== false,
      size: { width: Number(resolutionMatch[1]), height: Number(resolutionMatch[2]) },
      redact,
      logger: options.logger,
      buildArgs: (input) => {
        return buildStreamFfmpegArgs({
          rtmpUrls: rawUrls,
          width: input.width,
          height: input.height,
          fps: input.fps,
          audio: input.audio,
          videoBitrateKbps: options.videoBitrateKbps || 9000,
          audioBitrateKbps: options.audioBitrateKbps || 128,
          preset: options.preset || 'veryfast',
          codec,
          keyframeSeconds: options.keyframeSeconds || 3,
          inputThreadQueue,
        })
      },
    })
    return new ScreenStream({ destinations: rawUrls.map(redactStreamUrl), capture })
  }

  async stop(): Promise<{ duration: number; frames: number }> {
    const result = await this.capture.stop()
    if (result.error) {
      throw result.error
    }
    return { duration: result.duration, frames: this.capture.stats.videoFrames }
  }

  status(): StreamStatus {
    const error = this.capture.error
    if (error) {
      return { streaming: false, error: error.message }
    }
    return {
      streaming: true,
      startedAt: this.capture.startedAt,
      destinations: this.destinations,
      stats: { ...this.capture.stats },
    }
  }
}

/**
 * `stream.*` in the executor sandbox. Streams run until stopped or until the page
 * closes. stop/status work without a target when exactly one stream is active.
 */
export function createStreamApi(options: { logger: Logger }): {
  start: (opts: Omit<StartStreamOptions, 'logger'>) => Promise<{ startedAt: number; destinations: string[] }>
  stop: (opts?: CaptureTargetOptions) => Promise<{ duration: number; frames: number }>
  status: (opts?: CaptureTargetOptions) => Promise<StreamStatus>
} {
  const { logger } = options
  const active = new Map<Page, ScreenStream>()
  let lastError: string | undefined

  const find = (helper: string, target?: CaptureTargetOptions): ScreenStream | undefined => {
    if (target?.page) {
      return active.get(target.page)
    }
    const streams = [...active.values()]
    if (streams.length > 1) {
      throw new Error(`${helper}: several streams are active. Pass { page } to pick one.`)
    }
    return streams[0]
  }

  return {
    start: async (opts) => {
      const page = requirePage('stream.start', opts)
      if (active.has(page)) {
        throw new Error('A stream is already running for this page. Call stream.stop({ page }) first.')
      }
      const stream = await ScreenStream.start({ ...opts, page, logger })
      active.set(page, stream)
      lastError = undefined
      void stream.capture.done.then((result) => {
        if (active.get(page) === stream) {
          active.delete(page)
        }
        if (result.error) {
          lastError = result.error.message
        }
      })
      return { startedAt: stream.capture.startedAt, destinations: stream.destinations }
    },

    stop: async (opts) => {
      const stream = find('stream.stop', opts)
      if (!stream) {
        throw new Error(lastError ? `No active stream. Last stream failed: ${lastError}` : 'No active stream')
      }
      return stream.stop()
    },

    status: async (opts) => {
      const stream = find('stream.status', opts)
      if (!stream) {
        return { streaming: false, error: lastError }
      }
      return stream.status()
    },
  }
}
