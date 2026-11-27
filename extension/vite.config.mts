import { DEFAULT_RELAY_PORT } from '../playwriter/src/brand.js'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Bundle the playwriter package version into the extension so it can report
// which playwriter version it was built against. CLI/MCP use this to warn
// when the extension is outdated.
const playwriterPkg = JSON.parse(readFileSync(resolve(__dirname, '../playwriter/package.json'), 'utf-8'))

const port = process.env.BETTER_PLAYWRITER_PORT ?? process.env.PLAYWRITER_PORT ?? String(DEFAULT_RELAY_PORT)
const configuredRemoteUrl = process.env.BETTER_PLAYWRITER_REMOTE_URL ?? process.env.PLAYWRITER_REMOTE_URL
const remoteUrl = configuredRemoteUrl ? new URL(configuredRemoteUrl) : null
if (remoteUrl && remoteUrl.href !== `https://${remoteUrl.host}/`) {
  throw new Error('BETTER_PLAYWRITER_REMOTE_URL must be an HTTPS origin.')
}

const defineEnv: Record<string, string> = {
  'process.env.PLAYWRITER_PORT': JSON.stringify(port),
  __BETTER_PLAYWRITER_REMOTE_URL__: JSON.stringify(remoteUrl?.origin ?? null),
  __PLAYWRITER_VERSION__: JSON.stringify(playwriterPkg.version),
  __PLAYWRITER_OPEN_WELCOME_PAGE__: JSON.stringify((process.env.BETTER_PLAYWRITER_OPEN_WELCOME_PAGE ?? process.env.PLAYWRITER_OPEN_WELCOME_PAGE) !== '0'),
}
if (process.env.TESTING) {
  defineEnv['import.meta.env.TESTING'] = 'true'
}

// Allow tests to build per-port extension outputs to avoid parallel run conflicts.
const outDir = process.env.BETTER_PLAYWRITER_EXTENSION_DIST || process.env.PLAYWRITER_EXTENSION_DIST || 'dist'

export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: resolve(__dirname, 'icons/*'),
          dest: 'icons',
        },

        {
          src: resolve(__dirname, 'manifest.json'),
          dest: '.',
          transform: (content) => {
            const manifest = JSON.parse(content)

            // Only include tabs permission during testing
            if (process.env.TESTING) {
              if (!manifest.permissions.includes('tabs')) {
                manifest.permissions.push('tabs')
              }
            }

            // Inject key for stable extension ID in dev/test builds (not production)
            // This ensures all developers get the same extension ID: gihncbkonfpgnppockcmfgfcpojpodlf
            if (!process.env.PRODUCTION) {
              manifest.key =
                'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAi+FsHizysLFjuunJPBbuiUBXgh3tsYwOHwiXgwqU461J2bX+a3tqZqPgPOqyGgCigp+raPD/szeFYDKCGGyK07H2v+iQghJ5KsMJy7UW3IXsMAGHtkiBpTAVom5kdmQ/znCV5Gnu7FWlFHk0McsT7gkIqTIsHs+cXgyHdhWKahKni8aE50Xketr1FaBHG/Y/+JEGuWcm6Xn7KybXTC8qPODHuoQzuTMAK2LGfYhhqSotbMF+g9eOknAYUfVWroJ/wGQb7XGD2USYn0qVzyqC9A47uyFI/fIE0VCw7XF0vw9W/uuVvKMic9iX8S2LCtdkS/g3Zk+DDheNJEKgIjQC+QIDAQAB'
            }

            return JSON.stringify(manifest, null, 2)
          },
        },
      ],
    }),
  ],

  build: {
    outDir,
    emptyOutDir: false,
    minify: false,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background.ts'),
        'content-script': resolve(__dirname, 'src/content-script.ts'),
        offscreen: resolve(__dirname, 'src/offscreen.html'),
        welcome: resolve(__dirname, 'src/welcome.html'),
        tutorial: resolve(__dirname, 'src/tutorial.html'),
        'profile-options': resolve(__dirname, 'src/profile-options.html'),
      },
      output: {
        entryFileNames: '[name].js',
        format: 'es',
      },
    },
  },
  define: defineEnv,
})
