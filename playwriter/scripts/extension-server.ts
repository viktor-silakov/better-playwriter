import { startPlayWriterCDPRelayServer } from '../src/cdp-relay.js'

async function main() {
  await startPlayWriterCDPRelayServer()

  console.log('Server running. Press Ctrl+C to stop.')
}

main().catch(console.error)
