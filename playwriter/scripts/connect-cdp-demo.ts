/**
 * Minimal proof: connect a Playwright client straight to the running
 * Better Playwriter relay via its CDP WebSocket URL.
 *
 * Prereqs:
 *   1. `better-playwriter serve --token <token> --replace` is running
 *   2. The Better Playwriter Chrome extension is connected (toggled on a tab)
 *
 * Run:
 *   tsx playwriter/scripts/connect-cdp-demo.ts
 */

import { chromium } from '@xmorse/playwright-core'
import { getRelayPort, readEnv } from '../src/runtime-config.js'

const TOKEN = readEnv('TOKEN')
if (!TOKEN) {
  throw new Error('Set BETTER_PLAYWRITER_TOKEN to the token passed to `better-playwriter serve --token`.')
}
const CLIENT_ID = `cdp-demo-${Date.now()}`
const host = readEnv('CDP_HOST') || `ws://127.0.0.1:${getRelayPort()}`
const cdpUrl = new URL(`${host.replace(/\/$/, '')}/cdp/${CLIENT_ID}`)
cdpUrl.searchParams.set('token', TOKEN)

async function main(): Promise<void> {
  console.log('Connecting to the Better Playwriter relay…')

  const browser = await chromium.connectOverCDP(cdpUrl.href)

  const contexts = browser.contexts()
  console.log(`Got ${contexts.length} browser context(s)`)

  const pages = contexts.flatMap((ctx) => {
    return ctx.pages()
  })
  console.log(`Got ${pages.length} page(s):`)
  pages.forEach((page, i) => {
    console.log(`  [${i}] ${page.url()}`)
  })

  if (pages.length === 0) {
    console.error('No pages — toggle the Better Playwriter extension on a tab first.')
    await browser.close()
    process.exit(1)
  }

  const page = pages[0]
  console.log('\nDriving page[0]...')
  await page.goto('https://example.com')
  console.log('Title:', await page.title())

  await browser.close()
  console.log('Done.')
}

main().catch((err) => {
  const message = String(err)
    .replaceAll(cdpUrl.href, '[relay URL]')
    .replaceAll(cdpUrl.search, '?[redacted]')
  console.error(message)
  process.exit(1)
})
