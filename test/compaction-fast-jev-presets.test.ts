import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { projectRoot } from './patch-path'

const PACKAGE_NAME = 'dsh-desktop-compaction-fast-jev'
const PRESET_IDS = ['preset-standard', 'preset-cordis', 'preset-ptc'] as const

const profileConfigTags = [
  {
    tag: 'tag:yaml.org,2002:js',
    resolve: (value: string) => value
  }
]

interface PresetRow {
  id?: string
  name?: string
  config?: { id?: string; plugins?: unknown[] }
}

const packageDir = path.join(projectRoot, 'packages', PACKAGE_NAME)
// The presets the installed Desktop actually ships; present after `npm ci`.
const shippedPresetsDir = path.join(
  projectRoot,
  'node_modules',
  '@deepseek-ai',
  'dsh-web-app',
  'presets'
)

function readOverrides(): PresetRow[] {
  return parseYaml(
    readFileSync(path.join(packageDir, 'cordis.patch.yml'), 'utf8'),
    { customTags: profileConfigTags }
  ) as PresetRow[]
}

function readShippedPreset(name: string): NonNullable<PresetRow['config']> {
  const rows = parseYaml(
    readFileSync(path.join(shippedPresetsDir, `${name}.patch.yml`), 'utf8'),
    { customTags: profileConfigTags }
  ) as { insert?: { config?: PresetRow['config'] }[] }[]
  const config = rows[0]?.insert?.[0]?.config
  if (config === undefined) throw new Error(`shipped preset ${name} has no insert config`)
  return config
}

/** Deep-diff two parsed YAML values into `path: a vs b` strings. */
function diff(a: unknown, b: unknown, base = ''): string[] {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return a === b ? [] : [`${base}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`]
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return [`${base}: array vs object`]
    if (a.length !== b.length) return [`${base}: length ${a.length} vs ${b.length}`]
    return a.flatMap((item, index) => diff(item, b[index], `${base}[${index}]`))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...keys].sort().flatMap((key) => {
    if (!(key in left) || !(key in right)) return [`${base}.${key}: presence differs`]
    return diff(left[key], right[key], `${base}.${key}`)
  })
}

/**
 * The bundle patch replaces each preset's COMPLETE config, so the pinned
 * copies must stay byte-equivalent to the shipped presets except for the one
 * compaction row swap. Any other difference means a harness upgrade changed
 * the shipped presets and this override would silently revert them —
 * regenerate with `packages/dsh-desktop-compaction-fast-jev/scripts/
 * regenerate-presets.py` (see its README).
 */
describe('dsh-desktop-compaction-fast-jev preset overrides', () => {
  it('overrides exactly the three presets that ship a compaction-basic row', () => {
    const overrides = readOverrides()
    expect(overrides.map((row) => row.id)).toEqual([...PRESET_IDS])
    for (const row of overrides) {
      expect(row.name).toBe('@deepseek-ai/dsh-agent-preset')
    }
  })

  it('swaps in the Jev engine with its budget config and leaves no basic row', () => {
    for (const row of readOverrides()) {
      const serialized = JSON.stringify(row.config)
      expect(serialized).toContain('"id":"compaction-fast-jev"')
      expect(serialized).toContain(`"name":"${PACKAGE_NAME}"`)
      expect(serialized).not.toContain('compaction-basic')
      expect(serialized).toContain('"preserveRecentMessages":6')
      expect(serialized).toContain('"maxStateTokens":27000')
      expect(serialized).toContain('"maxRequestTokens":32000')
    }
  })

  // Before `npm ci` the shipped presets are not on disk; the check below then
  // has nothing to diff against and is skipped instead of guessing.
  const hasShippedPresets = existsSync(shippedPresetsDir)

  it.each([
    ['preset-standard', 'standard'],
    ['preset-cordis', 'cordis'],
    ['preset-ptc', 'ptc']
  ] as const)(
    '%s differs from the shipped preset only by the compaction row swap',
    { skip: !hasShippedPresets },
    (overrideId, shippedName) => {
      const row = readOverrides().find((entry) => entry.id === overrideId)
      const shipped = readShippedPreset(shippedName)
      expect(row?.config?.id).toBe(shipped.id)

      const differences = diff(row?.config, shipped)
      // Exactly the swapped row's id, name and added config — one common row.
      expect(differences).toHaveLength(3)
      const suffixes = differences
        .map((entry) => (entry.split(': ')[0] ?? '').split('.').pop() ?? '')
        .sort()
      expect(suffixes).toEqual(['config', 'id', 'name'])
      // Every difference sits on the same swapped row's first config entry.
      const prefixes = new Set(
        differences.map((entry) => {
          expect(entry).toContain('.config[0].')
          return entry.split('.config[0].')[0] ?? ''
        })
      )
      expect(prefixes.size).toBe(1)
      expect(differences.some((entry) => entry.includes('compaction-fast-jev'))).toBe(true)
      expect(differences.some((entry) => entry.includes('dsh-compaction-basic'))).toBe(true)
    }
  )
})
