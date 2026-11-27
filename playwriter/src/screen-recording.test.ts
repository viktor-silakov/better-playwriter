/**
 * Tests viewport sizing, capture size and ffmpeg argument builders.
 */
import { describe, test, expect } from 'vitest'
import { buildTranscodeFfmpegArgs, computeCaptureSize, fitToAspectRatio } from './screen-recording.js'

describe('fitToAspectRatio', () => {
  test('common sizes → 16:9', () => {
    const ratio = { width: 16, height: 9 }

    // Already 16:9 — no change
    expect(fitToAspectRatio({ width: 1920, height: 1080 }, ratio)).toMatchInlineSnapshot(`
      {
        "height": 1080,
        "width": 1920,
      }
    `)
    expect(fitToAspectRatio({ width: 1280, height: 720 }, ratio)).toMatchInlineSnapshot(`
      {
        "height": 720,
        "width": 1280,
      }
    `)

    // 16:10 (MacBook default) — too tall, shrink height
    expect(fitToAspectRatio({ width: 1440, height: 900 }, ratio)).toMatchInlineSnapshot(`
      {
        "height": 810,
        "width": 1440,
      }
    `)
    expect(fitToAspectRatio({ width: 1680, height: 1050 }, ratio)).toMatchInlineSnapshot(`
      {
        "height": 945,
        "width": 1680,
      }
    `)

    // 4:3 — too tall, shrink height
    expect(fitToAspectRatio({ width: 1024, height: 768 }, ratio)).toMatchInlineSnapshot(`
      {
        "height": 576,
        "width": 1024,
      }
    `)

    // Ultra-wide 21:9 — too wide, shrink width
    expect(fitToAspectRatio({ width: 2560, height: 1080 }, ratio)).toMatchInlineSnapshot(`
      {
        "height": 1080,
        "width": 1920,
      }
    `)
    expect(fitToAspectRatio({ width: 3440, height: 1440 }, ratio)).toMatchInlineSnapshot(`
      {
        "height": 1440,
        "width": 2560,
      }
    `)

    // Square — too tall, shrink height
    expect(fitToAspectRatio({ width: 1000, height: 1000 }, ratio)).toMatchInlineSnapshot(`
      {
        "height": 563,
        "width": 1000,
      }
    `)
  })

  test('custom aspect ratios', () => {
    // 4:3
    expect(fitToAspectRatio({ width: 1920, height: 1080 }, { width: 4, height: 3 })).toMatchInlineSnapshot(`
      {
        "height": 1080,
        "width": 1440,
      }
    `)

    // 1:1
    expect(fitToAspectRatio({ width: 1920, height: 1080 }, { width: 1, height: 1 })).toMatchInlineSnapshot(`
      {
        "height": 1080,
        "width": 1080,
      }
    `)

    // 9:16 vertical
    expect(fitToAspectRatio({ width: 1920, height: 1080 }, { width: 9, height: 16 })).toMatchInlineSnapshot(`
      {
        "height": 1080,
        "width": 608,
      }
    `)
  })

  test('never increases dimensions', () => {
    const ratio = { width: 16, height: 9 }
    const sizes = [
      { width: 800, height: 600 },
      { width: 1440, height: 900 },
      { width: 2560, height: 1080 },
      { width: 1000, height: 1000 },
    ]
    for (const size of sizes) {
      const result = fitToAspectRatio(size, ratio)
      expect(result.width).toBeLessThanOrEqual(size.width)
      expect(result.height).toBeLessThanOrEqual(size.height)
    }
  })
})

describe('computeCaptureSize', () => {
  test('retina viewport is capped at maxSize, sizes stay even', () => {
    expect([
      computeCaptureSize({ cssWidth: 1280, cssHeight: 720, devicePixelRatio: 2, maxSize: 1920 }),
      computeCaptureSize({ cssWidth: 1280, cssHeight: 720, devicePixelRatio: 1, maxSize: 1920 }),
      computeCaptureSize({ cssWidth: 1437, cssHeight: 809, devicePixelRatio: 1, maxSize: 1920 }),
      computeCaptureSize({ cssWidth: 390, cssHeight: 844, devicePixelRatio: 3, maxSize: 1920 }),
    ]).toMatchInlineSnapshot(`
      [
        {
          "height": 1080,
          "width": 1920,
        },
        {
          "height": 720,
          "width": 1280,
        },
        {
          "height": 810,
          "width": 1438,
        },
        {
          "height": 1920,
          "width": 888,
        },
      ]
    `)
  })
})

describe('buildTranscodeFfmpegArgs', () => {
  test('native AV1 from stdin to H.264 at a fixed size', () => {
    expect([
      buildTranscodeFfmpegArgs({ width: 3840, height: 2160, fps: 60, audio: true, codec: 'h264_videotoolbox', outputPath: '/out/a.mp4' }).join(' '),
      buildTranscodeFfmpegArgs({ width: 1920, height: 1080, fps: 60, audio: false, codec: 'libx264', outputPath: '/out/a.mkv' }).join(' '),
    ]).toMatchInlineSnapshot(`
      [
        "-hide_banner -loglevel error -nostdin -f mp4 -i pipe:0 -map 0:v:0 -map 0:a:0? -vf scale=3840:2160:force_original_aspect_ratio=decrease,pad=3840:2160:(ow-iw)/2:(oh-ih)/2,format=yuv420p,setsar=1 -fps_mode passthrough -c:v h264_videotoolbox -b:v 20000k -realtime true -c:a aac -b:a 160k -video_track_timescale 90000 -movflags +faststart -y /out/a.mp4",
        "-hide_banner -loglevel error -nostdin -f mp4 -i pipe:0 -map 0:v:0 -vf scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p,setsar=1 -fps_mode passthrough -c:v libx264 -preset veryfast -crf 20 -y /out/a.mkv",
      ]
    `)
  })
})
