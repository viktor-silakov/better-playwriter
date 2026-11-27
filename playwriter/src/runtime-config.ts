import os from 'node:os'
import path from 'node:path'
import { DEFAULT_RELAY_PORT } from './brand.js'

export const DEFAULT_DATA_DIR = path.join(os.homedir(), '.better-playwriter')

/** Prefer the fork's setting. The old variable remains an explicit override. */
export function readEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`BETTER_PLAYWRITER_${name}`] ?? env[`PLAYWRITER_${name}`]
}

export function getRelayPort(): number {
  return Number(readEnv('PORT')) || DEFAULT_RELAY_PORT
}

export function dataPath(...segments: string[]): string {
  const dataDir = readEnv('DATA_DIR') || DEFAULT_DATA_DIR
  return path.resolve(dataDir, ...segments)
}
