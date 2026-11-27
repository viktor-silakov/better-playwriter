import { chromium } from '@xmorse/playwright-core'
import { getCdpUrl } from '../src/utils.js'

async function main() {
  const cdpEndpoint = getCdpUrl()
  const browser = await chromium.connectOverCDP(cdpEndpoint)

  const contexts = browser.contexts()
  console.log(`Found ${contexts.length} browser context(s)`)

  // Sleep 200 ms
  await new Promise((resolve) => setTimeout(resolve, 200))
  for (const context of contexts) {
    const pages = context.pages()
    console.log(`Context has ${pages.length} page(s):`)
    // Create a new page
    const newPage = await context.newPage()
    // Evaluate a sum (e.g., 2 + 3) and log the result
    const sumResult = await newPage.evaluate(() => 2 + 3)
    console.log(`Evaluated sum 2 + 3 = ${sumResult}`)

    // Sleep 1 second
    await new Promise((resolve) => setTimeout(resolve, 1000))
    // Close the page
    await newPage.close()
  }
}

main()
