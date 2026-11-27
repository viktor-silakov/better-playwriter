export const AUTO_ATTACH_STORAGE_KEY = 'playwriterAutoAttach'

type AutoAttachMask = {
  origin: string
  path: string
  prefix: boolean
}

export type AutoAttachSettings = { masks: string[]; remember: boolean }

function parseHttpUrl(value: string): URL | null {
  if (!/^https?:\/\/[^/\\\s]/i.test(value) || !URL.canParse(value)) return null
  const url = new URL(value)
  return url.username || url.password ? null : url
}

function parseMask(value: string): AutoAttachMask | null {
  const prefix = value.endsWith('*')
  const address = prefix ? value.slice(0, -1) : value
  if (/[?#*\\\s]/.test(address)) return null
  const url = parseHttpUrl(address)
  return url && { origin: url.origin, path: url.pathname, prefix }
}

export function normalizeAutoAttachMask(value: string): string | null {
  const mask = parseMask(value.trim())
  if (!mask) return null
  const path = mask.prefix && mask.path === '/' ? '' : mask.path
  return mask.origin + path + (mask.prefix ? '*' : '')
}

export function autoAttachMaskForUrl(value?: string): string | null {
  const url = value && parseHttpUrl(value)
  return url ? url.origin + '*' : null
}

export function matchesAutoAttachMask(value: string | undefined, masks: string[]): boolean {
  const url = value && parseHttpUrl(value)
  if (!url) return false
  return masks.some((mask) => {
    const rule = parseMask(mask)
    if (!rule || url.origin !== rule.origin) return false
    return rule.prefix ? url.pathname.startsWith(rule.path) : url.pathname === rule.path
  })
}

export function readAutoAttachSettings(value: unknown): AutoAttachSettings {
  if (!value || typeof value !== 'object') return { masks: [], remember: true }
  const settings = value as { masks?: unknown; remember?: unknown }
  const masks: string[] = []
  if (Array.isArray(settings.masks)) {
    for (const value of settings.masks) {
      const mask = typeof value === 'string' && normalizeAutoAttachMask(value)
      if (mask) masks.push(mask)
    }
  }
  return { masks: [...new Set(masks)], remember: settings.remember !== false }
}
