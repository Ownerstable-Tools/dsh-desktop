/**
 * Offline smoke test for the DSH fast-jev compaction adapter.
 *
 * Runs under plain `node test/smoke.mjs` with no dsh packages: it exercises
 * the vendored fast-jev-compaction library through jev-adapt.js with a fake
 * Jev asker, exactly like the upstream library's own fake-driven tests.
 *
 * Recorded kill: this suite caught (a) an inverted `ratio < min` reduction
 * guard and (b) a dropped `role === 'tool'` branch in mapSpanMessages during
 * development — see README.md "Kill record".
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  JevFallbackError,
  jevSummarize,
  makeFetchAsker,
  mapSpanMessages,
  renderTranscript,
  resolveApiKey,
  splitSpanForState,
} from '../jev-adapt.js'

const LONG_RESULT = `HEAD-MARKER\n${'x'.repeat(880)}\nTAIL-MARKER`

/** A DSH-shaped span: system head, user/assistant text, tool-call blocks, tool-role results. */
function testSpan() {
  const assistant = (text, call) => ({
    role: 'assistant',
    content: [
      { type: 'text', text },
      { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments },
    ],
    source: { kind: 'model', provider: 'p', model: 'm' },
  })
  const tool = (callId, text, isError) => ({
    role: 'tool',
    toolCallId: callId,
    ...(isError === undefined ? {} : { isError }),
    content: [{ type: 'text', text }],
    source: { kind: 'tool', callId },
  })
  return [
    { role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT — must never appear' }], source: { kind: 'system-prompt' } },
    { role: 'user', content: [{ type: 'text', text: 'Fix the failing test. Never edit src/generated.' }], source: { kind: 'user' } },
    assistant('Reading the file.', { id: 'tu1', name: 'Read', arguments: '{"file_path":"src/a.ts"}' }),
    tool('tu1', 'FILE-CONTENTS-A verbatim body'),
    assistant('Running the tests.', { id: 'tu2', name: 'Bash', arguments: '{"command":"npm test"}' }),
    tool('tu2', LONG_RESULT),
    assistant('Searching for callers.', { id: 'tu3', name: 'Grep', arguments: '{"pattern":"staleFn"}' }),
    tool('tu3', 'RESULT-C-BODY-VERBATIM'),
    { role: 'user', content: [{ type: 'text', text: 'midway question' }], source: { kind: 'user' } },
    { role: 'assistant', content: [{ type: 'text', text: 'midway answer' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    assistant('Listing files.', { id: 'tu4', name: 'Glob', arguments: '{not json' }),
    tool('tu4', 'RESULT-D-KEEP', true),
    { role: 'user', content: [{ type: 'text', text: 'latest prompt' }], source: { kind: 'user' } },
  ]
}

/** Fake Jev: per-call keep probabilities keyed by the tN id in the question name. */
function fakeAsker(rules, seen = []) {
  return {
    async ask(state, questions) {
      seen.push({ state, questionNames: Object.keys(questions) })
      const answers = {}
      for (const name of Object.keys(questions)) {
        const match = /^(call|result)_t(\d+)$/.exec(name)
        assert.ok(match, `unexpected question name ${name}`)
        const rule = rules[`t${match[2]}`] ?? { call: 0.9, result: 0.9 }
        answers[name] = { type: 'noul', noul: match[1] === 'call' ? rule.call : rule.result }
      }
      return { answers }
    },
  }
}

const OPTIONS = {
  // A call is pinned when its call OR result message sits in the preserved
  // window; 1 keeps only the final user message pinned so all four calls are
  // scoring candidates.
  preserveRecentMessages: 1,
  minReductionRatio: 0.25,
  truncateHeadChars: 300,
}

// ---------------------------------------------------------------- mapping

{
  const mapped = mapSpanMessages(testSpan())
  assert.equal(mapped.length, 12, 'system head must be dropped, everything else kept')
  assert.equal(mapped[0].role, 'user')
  assert.equal(mapped[0].text, 'Fix the failing test. Never edit src/generated.')
  assert.deepEqual(mapped[1].toolUses, [
    { tool_use_id: 'tu1', tool: 'Read', input: { file_path: 'src/a.ts' } },
  ])
  // tu4 has unparsable arguments: they survive as a raw string, never throw.
  assert.deepEqual(mapped[9].toolUses[0].input, { raw: '{not json' })
  // tool-role results map to user-role messages carrying toolResults.
  assert.equal(mapped[2].role, 'user')
  assert.deepEqual(mapped[2].toolResults, [
    { tool_use_id: 'tu1', text: 'FILE-CONTENTS-A verbatim body', isError: false },
  ])
  assert.equal(mapped[10].toolResults[0].isError, true, 'tool error flag survives mapping')
  assert.ok(
    mapped.every((m) => !m.text.includes('SYSTEM PROMPT')),
    'system prompt must not leak into mapped messages',
  )
}

// ------------------------------------------------------- happy-path prune

{
  const seen = []
  const asker = fakeAsker(
    {
      t1: { call: 0.9, result: 0.9 },   // keep verbatim
      t2: { call: 0.9, result: 0.1 },   // keep call, truncate result
      t3: { call: 0.1, result: 0.1 },   // drop call and result
      t4: { call: 0.8, result: 0.8 },   // keep
    },
    seen,
  )
  const outcome = await jevSummarize(testSpan(), asker, OPTIONS)

  assert.equal(seen.length, 1, 'one Jev request for four calls')
  assert.ok(seen[0].questionNames.includes('call_t1') && seen[0].questionNames.includes('result_t4'))
  // Base-stage state: text-bearing and call-bearing messages, results replaced
  // by `ok, N chars (omitted)` notes on their call's entry.
  const history = seen[0].state.history
  assert.ok(Array.isArray(history) && history.length === 8, `history entries: ${history.length}`)
  assert.ok(
    history.some((entry) => entry.tool_calls?.some((call) => call.id === 't2' && /^\d+ chars \(omitted\)$/.test(String(call.result).replace(/^ok, /, '')))),
    'tool results are replaced by omission notes in the state',
  )
  assert.ok(seen[0].state.goal.length > 0, 'goal defaults from user prompts')

  const text = outcome.text
  assert.ok(text.includes('Fix the failing test. Never edit src/generated.'), 'user text verbatim')
  assert.ok(text.includes('FILE-CONTENTS-A verbatim body'), 'kept result verbatim')
  assert.ok(text.includes('RESULT-D-KEEP'), 'kept error result verbatim')
  assert.ok(text.includes('HEAD-MARKER'), 'truncated result keeps its head')
  assert.ok(text.includes('fast-jev-compaction truncated'), 'truncation note present')
  assert.ok(!text.includes('TAIL-MARKER'), 'truncated result drops its tail')
  assert.ok(!text.includes('RESULT-C-BODY-VERBATIM'), 'dropped result body gone')
  assert.ok(!text.includes('staleFn'), 'dropped call input gone')
  assert.ok(!text.includes('SYSTEM PROMPT'), 'system prompt never rendered')
  assert.ok(text.includes('[tool call Read id=tu1]'), 'kept call rendered with id')
  assert.ok(text.includes('(error)'), 'error result flagged in render')

  assert.equal(outcome.stats.kept, 2)
  assert.equal(outcome.stats.resultsDropped, 1)
  assert.equal(outcome.stats.callsDropped, 1)
  assert.ok(outcome.ratio >= 0.25, `reduction ratio ${outcome.ratio} below guard`)
  assert.deepEqual(
    outcome.decisions.map((d) => d.action),
    ['keep', 'drop_result', 'drop_call', 'keep'],
  )
}

// ------------------------------------------------- fallback signal paths

{
  // Everything kept → no reduction → JevFallbackError so the engine can fall back.
  const outcome = jevSummarize(testSpan(), fakeAsker({}), OPTIONS)
  await assert.rejects(outcome, (error) => {
    assert.ok(error instanceof JevFallbackError)
    assert.match(error.message, /below minimum/)
    return true
  })

  // Span too small to be worth scoring.
  const small = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', provider: 'p', model: 'm' } },
  ]
  await assert.rejects(
    jevSummarize(small, fakeAsker({}), OPTIONS),
    (error) => {
      assert.ok(error instanceof JevFallbackError)
      assert.match(error.message, /too small/)
      return true
    },
  )

  // An asker failure propagates (the engine catches and falls back).
  await assert.rejects(
    jevSummarize(testSpan(), { async ask() { throw new Error('Jev request failed (500): boom') } }, OPTIONS),
    /Jev request failed/,
  )
}

// ---------------------------------------------------------------- asker

{
  const captured = []
  const asker = makeFetchAsker({
    apiKey: 'TESTKEY',
    model: 'jev-test',
    fetchImpl: async (url, init) => {
      captured.push({ url, init })
      return { status: 200, ok: true, text: async () => JSON.stringify({ answers: { a: { noul: 1 } } }) }
    },
  })
  const response = await asker.ask({ context: 'c', goal: 'g', history: [] }, { a: { type: 'noul', instructions: 'i' } })
  assert.deepEqual(response.answers.a, { noul: 1 })
  assert.equal(captured[0].url, 'https://api.typesafe.ai/v1/systemone')
  assert.equal(captured[0].init.method, 'POST')
  assert.equal(captured[0].init.headers.authorization, 'Bearer TESTKEY')
  const body = JSON.parse(captured[0].init.body)
  assert.equal(body.model, 'jev-test')
  assert.deepEqual(body.questions.a, { type: 'noul', instructions: 'i' })

  const failing = makeFetchAsker({
    apiKey: 'K',
    fetchImpl: async () => ({ status: 503, ok: false, text: async () => 'upstream down' }),
  })
  await assert.rejects(failing.ask({}, {}), /Jev request failed \(503\)/)

  const malformed = makeFetchAsker({
    apiKey: 'K',
    fetchImpl: async () => ({ status: 200, ok: true, text: async () => 'not json' }),
  })
  await assert.rejects(malformed.ask({}, {}), /malformed JSON/)
}

// ------------------------------------------- asker timeout + concurrency cap
// Kill record (2026-09-29): removing the per-request AbortSignal.timeout from
// makeFetchAsker makes the timeout test below hit its 3s guard and fail;
// removing the semaphore lets maxInFlight exceed the cap assertion.

{
  // A fake fetch emulating real abort semantics: rejects with signal.reason
  // when (or before) the composed signal aborts, otherwise never settles.
  const stallingFetch = (url, init) => new Promise((resolve, reject) => {
    if (init.signal?.aborted) { reject(init.signal.reason); return }
    init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  })

  // Guard keeps the loop alive: AbortSignal.timeout's internal timer is
  // unref'd, so without a ref'd guard node would exit before either side
  // of the race settles (exit 13, unsettled top-level await).
  const slow = makeFetchAsker({
    apiKey: 'K',
    requestTimeoutSeconds: 0.05,
    fetchImpl: stallingFetch,
  })
  let guardTimer
  const guard = new Promise((_, reject) => {
    guardTimer = setTimeout(() => reject(new Error('TIMEOUT GUARD: per-request timeout never fired')), 3000)
  })
  try {
    await Promise.race([
      assert.rejects(slow.ask({}, {}), (error) => error.name === 'TimeoutError'),
      guard,
    ])
  } finally {
    clearTimeout(guardTimer)
  }

  // The caller's cancellation survives composition with the timeout signal.
  const controller = new AbortController()
  controller.abort()
  const aborted = makeFetchAsker({ apiKey: 'K', signal: controller.signal, fetchImpl: stallingFetch })
  await assert.rejects(aborted.ask({}, {}), (error) => error.name === 'AbortError')

  // Concurrency cap: 6 simultaneous asks, at most 2 in flight.
  let inFlight = 0
  let maxInFlight = 0
  const gated = makeFetchAsker({
    apiKey: 'K',
    maxConcurrentRequests: 2,
    fetchImpl: async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inFlight--
      return { status: 200, ok: true, text: async () => JSON.stringify({ answers: {} }) }
    },
  })
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map(() => gated.ask({}, {})))
  assert.equal(results.length, 6)
  assert.ok(maxInFlight <= 2, `maxInFlight ${maxInFlight} exceeds cap 2`)
  assert.equal(maxInFlight, 2, 'cap never saturated — test proves nothing')
}

// ---------------------------------------------------- split-span scoring
// Kill record (2026-09-29): letting the `history too large for Jev` error
// propagate instead of splitting makes the end-to-end leg below reject; and
// allowing a cut before a tool-result message (dropping the `!isResult`
// guard in splitSpanForState) trips the orphaned-result assertion.

{
  // 120 calls — far over any single state floor at the tiny budget below.
  const big = [{ role: 'user', content: [{ type: 'text', text: 'initial task prompt' }], source: { kind: 'user' } }]
  for (let i = 1; i <= 120; i++) {
    big.push({
      role: 'assistant',
      content: [{ type: 'tool-call', id: `c${i}`, name: 'Bash', arguments: JSON.stringify({ command: `step ${i}` }) }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    })
    big.push({
      role: 'tool',
      toolCallId: `c${i}`,
      content: [{ type: 'text', text: `output of step ${i} — ${'detail '.repeat(12)}` }],
      source: { kind: 'tool', callId: `c${i}` },
    })
  }
  big.push({ role: 'assistant', content: [{ type: 'text', text: 'done with all steps' }], source: { kind: 'model', provider: 'p', model: 'm' } })
  big.push({ role: 'user', content: [{ type: 'text', text: 'final prompt' }], source: { kind: 'user' } })

  // Unit leg: the chunker never orphans a result from its call.
  const mapped = mapSpanMessages(big)
  const chunks = splitSpanForState(mapped, 1600)
  assert.ok(chunks.length >= 4, `expected several chunks, got ${chunks.length}`)
  const chunkOfCall = new Map()
  chunks.forEach((chunk, ci) => {
    assert.equal((chunk[0].toolResults ?? []).length, 0, 'a chunk must not start with a tool result')
    for (const m of chunk) {
      for (const u of m.toolUses ?? []) chunkOfCall.set(u.tool_use_id, ci)
      for (const r of m.toolResults ?? []) {
        assert.equal(chunkOfCall.get(r.tool_use_id), ci, `result ${r.tool_use_id} orphaned from its call`)
      }
    }
  })
  assert.equal(chunkOfCall.size, 120)
  assert.equal(chunks.flat().length, mapped.length, 'chunks must preserve every message in order')

  // End-to-end leg: single pass overflows (120 calls ≫ 1600-token budget),
  // chunked passes fit; odd calls drop so the reduction guard passes.
  const rules = {}
  for (let i = 1; i <= 120; i += 2) rules[`t${i}`] = { call: 0.1, result: 0.1 }
  const seen = []
  const outcome = await jevSummarize(big, fakeAsker(rules, seen), {
    preserveRecentMessages: 2,
    maxStateTokens: 1600,
    maxRequestTokens: 2600,
    truncateHeadChars: 300,
    minReductionRatio: 0.25,
  })
  assert.ok(outcome.stats.chunks >= 4, `chunks stat ${outcome.stats.chunks}`)
  assert.equal(outcome.stats.calls, 120, 'every call scored across chunks')
  assert.ok(outcome.stats.requests >= outcome.stats.chunks, 'at least one request per chunk')
  assert.ok(outcome.stats.callsDropped > 0 && outcome.stats.kept > 0, 'mixed decisions merged')
  assert.ok(outcome.ratio >= 0.25, `merged ratio ${outcome.ratio}`)
  assert.ok(outcome.text.startsWith('[Jev-pruned verbatim transcript]'), 'one merged checkpoint')
  assert.ok(outcome.text.includes('final prompt'), 'true span tail survives (last-chunk recency window)')
  assert.equal(seen.length, outcome.stats.requests)

  // A failing chunk fails the whole compaction (caller falls back; no partial prune).
  let asks = 0
  const flaky = {
    async ask(state, questions) {
      if (++asks === 3) throw new Error('boom mid-span')
      const answers = {}
      for (const name of Object.keys(questions)) answers[name] = { type: 'noul', noul: 0.9 }
      return { answers }
    },
  }
  await assert.rejects(
    jevSummarize(big, flaky, { preserveRecentMessages: 2, maxStateTokens: 1600, maxRequestTokens: 2600 }),
    /boom mid-span/,
  )
}

// ------------------------------------------------------------- key chain

{
  const dir = mkdtempSync(join(tmpdir(), 'jev-key-'))
  const keyFile = join(dir, 'key')
  writeFileSync(keyFile, 'FILE-KEY\n')

  const savedEnv = process.env.TYPESAFE_API_KEY
  try {
    delete process.env.TYPESAFE_API_KEY
    assert.equal(resolveApiKey({ apiKey: 'CONFIG-KEY', apiKeyFile: keyFile }), 'CONFIG-KEY')
    process.env.TYPESAFE_API_KEY = 'ENV-KEY'
    assert.equal(resolveApiKey({ apiKeyFile: keyFile }), 'ENV-KEY', 'env beats file')
    delete process.env.TYPESAFE_API_KEY
    assert.equal(resolveApiKey({ apiKeyFile: keyFile }), 'FILE-KEY', 'file key is trimmed')
    assert.equal(resolveApiKey({ apiKeyFile: join(dir, 'missing') }), undefined)
    // Hermetic only: never probe DEFAULT_KEY_FILE (~/.typesafe_key) — a failed
    // assertion diff would print the real key into whatever log captures it.
    const emptyFile = join(dir, 'empty')
    writeFileSync(emptyFile, '\n')
    assert.equal(resolveApiKey({ apiKeyFile: emptyFile }), undefined, 'an empty key file resolves to nothing')
  } finally {
    if (savedEnv === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = savedEnv
  }
}

// ---------------------------------------------------- renderTranscript id

{
  const rendered = renderTranscript(
    {
      messages: [
        { role: 'user', text: 'question', toolUses: [] },
        { role: 'assistant', text: 'answer', toolUses: [{ tool_use_id: 'x', tool: 'Read', input: { a: 1 } }] },
        { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'x', text: 'body', isError: false }] },
      ],
      stats: { messagesBefore: 3, messagesAfter: 3, kept: 1, resultsDropped: 0, callsDropped: 0 },
    },
    0.4,
  )
  assert.ok(rendered.startsWith('[Jev-pruned verbatim transcript]'))
  assert.ok(rendered.includes('<user>\nquestion\n</user>'))
  assert.ok(rendered.includes('[tool call Read id=x] {"a":1}'))
  assert.ok(rendered.includes('[tool result id=x]\nbody'))
}

// ------------------------------------------------- checkpoint char budget
// A renderer limit must never silently drop content Jev chose to preserve.
{
  const msg = (text) => ({ role: 'user', text, toolUses: [] })
  const result = {
    messages: [msg('NEVER EDIT src/generated'), msg('recent '.repeat(1000))],
    stats: { messagesBefore: 2, messagesAfter: 2, kept: 0, resultsDropped: 0, callsDropped: 0 },
  }
  assert.throws(() => renderTranscript(result, 0.5, 700), JevFallbackError,
    'overflow must request a summary rather than dropping the original constraint')
  const oversizedNewest = { ...result, messages: [msg('newest '.repeat(30000))] }
  assert.throws(() => renderTranscript(oversizedNewest, 0.5), JevFallbackError,
    'even a single newest message must respect the checkpoint limit')
  const complete = renderTranscript(result, 0.5)
  assert.ok(complete.includes('NEVER EDIT src/generated'))
  assert.ok(complete.includes('recent '.repeat(1000).trimEnd()))
  assert.equal(renderTranscript(result, 0.5, complete.length), complete,
    'the exact limit includes the header and final newline')
  assert.throws(() => renderTranscript(result, 0.5, complete.length - 1), JevFallbackError)
}

console.log('smoke: all assertions passed')
