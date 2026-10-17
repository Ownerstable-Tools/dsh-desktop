import { describe, it } from 'vitest'

/**
 * Offline behavior regression for the fast-compact compaction adapter,
 * imported from the package's own smoke script so plugin and test never drift
 * apart. The script exercises adapt.js and the vendored fast-compact library
 * with a fake Jev transport — no network, no dsh packages — and throws from
 * node:assert on any failure: span mapping, settings and key resolution, cuts
 * archived before they are applied, Jev ranking and its failure path, the
 * fallback conditions and checkpoint stubbing.
 */
describe('dsh-desktop-compaction-fast-compact', () => {
  it('passes the offline adapter smoke assertions', async () => {
    await import('../packages/dsh-desktop-compaction-fast-compact/test/smoke.mjs')
  })
})
