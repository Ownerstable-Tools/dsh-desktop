import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { FastCompactEngine } from '../packages/dsh-desktop-compaction-fast-compact/index.js'
import { settingsOf } from '../packages/dsh-desktop-compaction-fast-compact/adapt.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('offers a size preflight using the same framing and selected span as durable compaction', async () => {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  const meter = new TokenMeter(ctx)
  const session = Session.create('size-preflight')
  session.append('turn/start', { turn: 1 })
  const first = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'constraint '.repeat(100) }], source: { kind: 'user' }
  }), { surfaceOp: 'append' })
  const second = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'details '.repeat(100) }], source: { kind: 'user' }
  }), { surfaceOp: 'append' })
  const summary = [{ type: 'text', text: 'Keep the constraint.' }]
  const owner = { session }
  const engine = {
    regionDependencies: () => ({ meter, recover: () => false, summarize: async (input) => {
      expect(typeof input.canAcceptSummary).toBe('function')
      expect(input.canAcceptSummary([{ type: 'text', text: 'x'.repeat(10000) }])).toBe(false)
      expect(input.canAcceptSummary(summary)).toBe(true)
      return { summary, provider: 'test', model: 'test' }
    } })
  }
  const result = await BasicCompactionEngine.prototype.compactRegion.call(
    engine, first.seq, second.seq, owner, new AbortController().signal)
  expect(result.summary).toEqual(summary)
  expect(session.deriveMessages().flatMap(m => m.content).some(b => b.text === 'Keep the constraint.')).toBe(true)
})

it.each([false, undefined, true])('honors the host size preflight result %s', async (accepted) => {
  vi.stubGlobal('fetch', async (_url, options) => {
    const { questions } = JSON.parse(options.body)
    return new Response(JSON.stringify({ answers: Object.fromEntries(
      Object.keys(questions).map(key => [key, { type: 'noul', noul: 0 }])) }))
  })
  const fallback = { summary: [{ type: 'text', text: 'Stock summary' }], provider: 'stock', model: 'stock' }
  vi.spyOn(BasicCompactionEngine.prototype, 'summarize').mockResolvedValue(fallback)
  const engine = {
    settings: settingsOf({
      provider: 'typesafe',
      apiKey: 'synthetic-test-key',
      keepRecentCalls: 1,
      archiveDir: mkdtempSync(join(tmpdir(), 'fast-compact-preflight-')),
    }),
    ctx: { logger: { info() {}, warn() {}, debug() {} } }
  }
  const call = (id) => [
    { role: 'assistant', content: [{ type: 'tool-call', id, name: 'Read', arguments: '{}' }] },
    { role: 'tool', toolCallId: id, content: [{ type: 'text', text: `${id} ` + 'x'.repeat(5000) }] },
  ]
  const input = { canAcceptSummary: accepted === undefined ? undefined : () => accepted, messages: [
    { role: 'user', content: [{ type: 'text', text: 'Keep this constraint' }] },
    ...call('t1'), ...call('t2'), ...call('t3'),
    { role: 'user', content: [{ type: 'text', text: 'Continue' }] }
  ] }
  const result = await FastCompactEngine.prototype.summarize.call(
    engine, input, { session: { id: 'preflight' } }, new AbortController().signal)
  if (accepted === true) {
    expect(result.provider).toBe('fast-compact/typesafe')
    expect(result.summary[0].text).toContain('Keep this constraint')
    expect(result.summary[0].text).toContain('[fast-compact: cut ')
  } else {
    expect(result).toEqual(fallback)
  }
})
