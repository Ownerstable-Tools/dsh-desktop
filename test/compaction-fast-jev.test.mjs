import { describe, it } from 'vitest'

/**
 * Offline behavior regression for the Jev compaction adapter, imported from
 * the package's own smoke script so plugin and test never drift apart. The
 * script exercises jev-adapt.js and the vendored fast-jev library with a fake
 * asker — no network, no dsh packages — and throws from node:assert on any
 * failure: span mapping, happy-path prune, reduction guard, timeout and
 * concurrency guards, chunked split-span scoring, key resolution chain and
 * transcript rendering.
 */
describe('dsh-desktop-compaction-fast-jev', () => {
  it('passes the offline adapter smoke assertions', async () => {
    await import('../packages/dsh-desktop-compaction-fast-jev/test/smoke.mjs')
  })
})
