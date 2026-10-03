import type { PluginOptions } from 'claude-code'

// The mod's settings, read from the manifest's `userConfig` (defaults filled
// in by the engine, so every field is here; still checked, never trusted).
export type Language = 'en' | 'fr'
export type BarMode = 'full' | 'compact' | 'off'

export type Config = {
  language: Language
  commitModel: string
  commitLanguage: string
  isBugCheck: boolean
  autoPush: string[]
  prePushCommand: string
  bar: BarMode
  maxFilesPerCommand: number
}

const text = (o: PluginOptions, key: string, fallback: string): string => {
  const v = o[key]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback
}

const list = (o: PluginOptions, key: string): string[] => {
  const v = o[key]
  const raw = typeof v === 'string' ? v.split(/[,\s]+/) : Array.isArray(v) ? [...(v as readonly string[])] : []
  return raw.map(s => s.trim()).filter(s => s !== '')
}

export const readConfig = (o: PluginOptions): Config => {
  const language = text(o, 'language', 'en')
  const bar = text(o, 'bar', 'full')
  const max = o.maxFilesPerCommand
  return {
    language: language === 'fr' ? 'fr' : 'en',
    commitModel: text(o, 'commitModel', 'haiku'),
    commitLanguage: text(o, 'commitLanguage', 'English'),
    isBugCheck: o.bugCheck !== false,
    autoPush: list(o, 'autoPush'),
    prePushCommand: text(o, 'prePushCommand', ''),
    bar: bar === 'compact' || bar === 'off' ? bar : 'full',
    maxFilesPerCommand: typeof max === 'number' && max > 0 ? Math.floor(max) : 40,
  }
}
