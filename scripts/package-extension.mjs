import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync, zipSync } from 'fflate'

const root = fileURLToPath(new URL('..', import.meta.url))
const extensionRoot = path.join(root, 'extension')
const expectedName = 'Better Playwriter'

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function runBuild({ args, cwd, env }) {
  const result = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, env, stdio: 'inherit' })
    : spawnSync('pnpm', args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Build command failed: pnpm ${args.join(' ')}`)
}

function collectFiles(directory, relative = '', files = Object.create(null)) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name)
    const archivePath = relative + entry.name
    if (entry.isDirectory()) {
      collectFiles(absolute, `${archivePath}/`, files)
    } else if (entry.isFile()) {
      files[archivePath] = fs.readFileSync(absolute)
    } else {
      throw new Error('The extension build contains a file that cannot be packaged.')
    }
  }
  return files
}

export function readExtensionZip(bytes, expectedVersion) {
  const files = unzipSync(bytes)
  for (const entry of Object.keys(files)) {
    const parts = entry.split('/')
    if (parts.some((part) => !part || part.startsWith('.')) || /[\\:]/.test(entry)) {
      throw new Error('The ZIP contains an unsafe extension path.')
    }
    if (/\.(?:map|pem|key|p12|pfx|log)$/i.test(entry)) {
      throw new Error('The ZIP contains an unexpected build or credential file.')
    }
  }

  const manifest = JSON.parse(Buffer.from(files['manifest.json'] ?? []).toString('utf8'))
  if (manifest.name !== expectedName || manifest.manifest_version !== 3 || manifest.version !== expectedVersion) {
    throw new Error('The ZIP manifest must match the Better Playwriter release name and version.')
  }
  if (manifest.key || manifest.update_url || manifest.permissions?.includes('tabs')) {
    throw new Error('The ZIP contains a development manifest or an external update URL.')
  }
  const iconPath = manifest.icons?.['128']
  const icon = iconPath && files[iconPath]
  if (
    !icon ||
    icon.length < 24 ||
    Buffer.from(icon.subarray(0, 8)).toString('hex') !== '89504e470d0a1a0a' ||
    Buffer.from(icon).readUInt32BE(16) !== 128 ||
    Buffer.from(icon).readUInt32BE(20) !== 128
  ) {
    throw new Error('The ZIP must contain a 128 × 128 PNG extension icon.')
  }

  const manifestFiles = [
    manifest.background?.service_worker,
    manifest.options_page,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    ...(manifest.content_scripts ?? []).flatMap(({ js = [], css = [] }) => [...js, ...css]),
  ]
  if (manifestFiles.some((file) => !file || !Object.hasOwn(files, file))) {
    throw new Error('A resource referenced in the production manifest is missing from the ZIP.')
  }
  return files
}

function packageExtension() {
  const sourceManifest = readJson(path.join(extensionRoot, 'manifest.json'))
  const cli = readJson(path.join(root, 'playwriter/package.json'))
  const { version } = sourceManifest
  const versionParts = typeof version === 'string' ? version.split('.') : []
  if (
    versionParts.length < 1 ||
    versionParts.length > 4 ||
    !versionParts.some((part) => Number(part) > 0) ||
    versionParts.some((part) => !/^(?:0|[1-9]\d{0,4})$/.test(part) || Number(part) > 65535)
  ) {
    throw new Error('The extension manifest must use a valid Chrome Web Store version.')
  }
  if (cli.name !== 'better-playwriter' || sourceManifest.name !== expectedName) {
    throw new Error('The extension and npm package must use the Better Playwriter names.')
  }
  if (process.env.CWS_RELEASE_TAG && process.env.CWS_RELEASE_TAG !== `extension@${version}`) {
    throw new Error('The GitHub Release tag must match the extension manifest version.')
  }

  const env = { ...process.env }
  for (const key of [
    'TESTING',
    'PRODUCTION',
    'PLAYWRITER_PORT',
    'PLAYWRITER_OPEN_WELCOME_PAGE',
    'PLAYWRITER_EXTENSION_DIST',
    'PLAYWRITER_REMOTE_URL',
    'BETTER_PLAYWRITER_PORT',
    'BETTER_PLAYWRITER_OPEN_WELCOME_PAGE',
    'BETTER_PLAYWRITER_EXTENSION_DIST',
    'BETTER_PLAYWRITER_REMOTE_URL',
    'BETTER_PLAYWRITER_STORE_ID',
  ])
    delete env[key]

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'better-playwriter-build-'))
  try {
    runBuild({ args: ['--filter', cli.name, 'build'], cwd: root, env })
    runBuild({
      args: ['build'],
      cwd: extensionRoot,
      env: {
        ...env,
        PRODUCTION: 'true',
        PLAYWRITER_EXTENSION_DIST: temporary,
        BETTER_PLAYWRITER_EXTENSION_DIST: temporary,
      },
    })

    const files = collectFiles(temporary)
    files.LICENSE = fs.readFileSync(path.join(root, 'LICENSE'))
    const bytes = zipSync(files, { mtime: new Date(2000, 0, 1), level: 9 })
    readExtensionZip(bytes, version)

    const filename = `better-playwriter-${version}.zip`
    fs.writeFileSync(path.join(root, filename), bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    console.log(`Packaged ${filename} (SHA-256 ${sha256})`)
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `filename=${filename}\nversion=${version}\nsha256=${sha256}\n`)
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) packageExtension()
