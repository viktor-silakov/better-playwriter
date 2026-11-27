import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const api = 'https://chromewebstore.googleapis.com'
const pendingStates = new Set(['PENDING_REVIEW', 'STAGED'])
const publishedStates = new Set(['PUBLISHED', 'PUBLISHED_TO_TESTERS'])

function revisions(status, field) {
  const revision = status[field]
  return (revision?.distributionChannels ?? []).map(({ crxVersion }) => ({ state: revision.state, crxVersion }))
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 4; index++) {
    const difference = (a[index] || 0) - (b[index] || 0)
    if (difference) return difference
  }
  return 0
}

export function createStoreClient({ publisherId, extensionId, accessToken, request = fetch }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(publisherId ?? '') || !/^[a-p]{32}$/.test(extensionId ?? '') || !accessToken) {
    throw new Error('Configure the Chrome Web Store publisher ID, extension ID and access token.')
  }
  const itemPath = `/v2/publishers/${publisherId}/items/${extensionId}`

  async function call(method, { body, contentType, upload = false } = {}) {
    const safeToRetry = body === undefined
    const attempts = safeToRetry ? 3 : 1
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const response = await request(`${api}${upload ? '/upload' : ''}${itemPath}:${method}`, {
        method: safeToRetry ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, ...(contentType && { 'Content-Type': contentType }) },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(safeToRetry ? 10_000 : 45_000),
      }).catch(() => null)
      if (response?.ok) {
        const data = await response.json().catch(() => null)
        if (data?.itemId !== extensionId) throw new Error(`Chrome Web Store returned an unexpected item for ${method}.`)
        return data
      }
      const transient = !response || response.status === 429 || response.status >= 500
      if (!transient || attempt === attempts) {
        // API errors can include private item details. Keep those in the Developer Dashboard.
        throw new Error(
          `Chrome Web Store ${method} failed (${response ? `HTTP ${response.status}` : 'network error'}). Check the Developer Dashboard.`,
        )
      }
      await response?.body?.cancel()
      await sleep(attempt * 1000)
    }
  }

  return {
    status: () => call('fetchStatus'),
    upload: (bytes) => call('upload', { body: bytes, contentType: 'application/zip', upload: true }),
    publish: () => call('publish', { body: '{}', contentType: 'application/json' }),
  }
}

export async function publishVersion({ client, bytes, version, wait = sleep }) {
  const before = await client.status()
  if (before.takenDown || before.warned)
    throw new Error('Resolve the store warning or takedown in the Developer Dashboard.')
  const submitted = revisions(before, 'submittedItemRevisionStatus')
  const published = revisions(before, 'publishedItemRevisionStatus')
  const current = [...published, ...submitted]
  if (current.some(({ crxVersion }) => crxVersion && compareVersions(crxVersion, version) > 0)) {
    throw new Error('The store already has a newer extension version.')
  }
  const known = current.find(
    ({ state, crxVersion }) =>
      compareVersions(crxVersion ?? '', version) === 0 && (publishedStates.has(state) || pendingStates.has(state)),
  )
  if (known) return known.state
  if (pendingStates.has(before.submittedItemRevisionStatus?.state) || before.lastAsyncUploadState === 'IN_PROGRESS') {
    throw new Error(
      'Another store upload or submission is still active. Check the Developer Dashboard before retrying.',
    )
  }

  const uploaded = await client.upload(bytes)
  if ((uploaded.crxVersion != null || uploaded.uploadState === 'SUCCEEDED') && uploaded.crxVersion !== version) {
    throw new Error('The uploaded extension version does not match the release version.')
  }

  let state = uploaded.uploadState
  for (let attempt = 0; state === 'IN_PROGRESS' && attempt < 20; attempt++) {
    await wait(3000)
    state = (await client.status()).lastAsyncUploadState
  }
  if (state !== 'SUCCEEDED')
    throw new Error('The upload could not be confirmed. Check the Developer Dashboard before retrying.')

  const submission = await client.publish()
  if (!pendingStates.has(submission.state) && !publishedStates.has(submission.state)) {
    throw new Error('The store did not accept this submission. Check the Developer Dashboard.')
  }
  return submission.state
}

function describeStatus(status) {
  return [
    '### Chrome Web Store status',
    ...[
      ['Published', 'publishedItemRevisionStatus'],
      ['Submitted', 'submittedItemRevisionStatus'],
    ].map(([label, field]) => {
      const revision = status[field]
      const versions = revisions(status, field)
        .map(({ crxVersion }) => crxVersion)
        .filter((version) => /^\d+(?:\.\d+){0,3}$/.test(version))
      return `${label}: ${formatState(revision?.state)}${versions.length ? ` (${versions.join(', ')})` : ''}`
    }),
    `Last async upload: ${formatState(status.lastAsyncUploadState)}`,
    `Policy warning: ${status.warned ? 'yes' : 'no'} · Taken down: ${status.takenDown ? 'yes' : 'no'}`,
  ].join('\n\n')
}

function formatState(value) {
  return /^[A-Z_]+$/.test(value ?? '') ? value : 'none'
}

function report(value) {
  console.log(value)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${value}\n`)
}

async function main() {
  const [command, filename, version, expectedHash] = process.argv.slice(2)
  if (command !== 'publish' && command !== 'status') throw new Error('Expected publish or status.')
  const client = createStoreClient({
    publisherId: process.env.CWS_PUBLISHER_ID,
    extensionId: process.env.CWS_EXTENSION_ID,
    accessToken: process.env.CWS_ACCESS_TOKEN,
  })
  if (command === 'status') {
    report(describeStatus(await client.status()))
    return
  }
  if (
    !/^\d+(?:\.\d+){0,3}$/.test(version ?? '') ||
    !/^[a-f0-9]{64}$/.test(expectedHash ?? '') ||
    path.basename(filename ?? '') !== `better-playwriter-${version}.zip`
  ) {
    throw new Error('The release version, ZIP filename and SHA-256 are required.')
  }
  const bytes = fs.readFileSync(filename)
  if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
    throw new Error('The ZIP does not match the artifact verified in CI.')
  }
  const state = await publishVersion({ client, bytes, version })
  report(`Chrome Web Store version ${version}: ${state}. Run the status workflow to check the review and live version.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
