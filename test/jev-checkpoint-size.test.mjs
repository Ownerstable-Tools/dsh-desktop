import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { JevCompactionEngine } from '../packages/dsh-desktop-compaction-fast-jev/index.js'

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
    jevOptions: { apiKey: 'synthetic-test-key', preserveRecentMessages: 1 },
    ctx: { logger: { info() {}, warn() {}, debug() {} } }
  }
  const input = { canAcceptSummary: accepted === undefined ? undefined : () => accepted, messages: [
    { role: 'user', content: [{ type: 'text', text: 'Keep this constraint' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 't1', name: 'Read', arguments: '{}' }] },
    { role: 'tool', toolCallId: 't1', content: [{ type: 'text', text: 'x'.repeat(5000) }] },
    { role: 'user', content: [{ type: 'text', text: 'Continue' }] }
  ] }
  const result = await JevCompactionEngine.prototype.summarize.call(engine, input, {}, new AbortController().signal)
  if (accepted === true) {
    expect(result.provider).toBe('typesafe-jev')
    expect(result.summary[0].text).toContain('Keep this constraint')
  } else {
    expect(result).toEqual(fallback)
  }
})
