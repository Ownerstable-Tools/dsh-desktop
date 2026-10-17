/**
 * Offline smoke test for the DSH fast-compact compaction adapter.
 *
 * Runs under plain `node test/smoke.mjs` with no dsh packages: it exercises
 * the vendored fast-compact library through adapt.js with a fake Jev
 * transport and a temporary archive folder.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FastCompactFallbackError,
  fastCompactSummarize,
  makeFetchTransport,
  mapSpanMessages,
  resolveApiKey,
  settingsOf,
} from '../adapt.js'

const BIG = (tag, n = 6000) => `${tag}-HEAD\n${'x'.repeat(n)}\n${tag}-TAIL`

const assistant = (text, id, name, args) => ({
  role: 'assistant',
  content: [
    { type: 'reasoning', text: 'hidden reasoning' },
    { type: 'text', text },
    { type: 'tool-call', id, name, arguments: args },
  ],
})
const tool = (callId, text, isError) => ({
  role: 'tool',
  toolCallId: callId,
  ...(isError === undefined ? {} : { isError }),
  content: [{ type: 'text', text }],
})

/** A DSH-shaped span: system head, prompts, 14 tool calls (4 old and long, 10 recent). */
function testSpan({ secret = false } = {}) {
  const span = [
    { role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT — must never appear' }] },
    { role: 'user', content: [{ type: 'text', text: 'Fix the failing test. Never edit src/generated.' }] },
  ]
  for (let i = 1; i <= 4; i++) {
    span.push(assistant(`Old step ${i}.`, `old${i}`, 'Bash', JSON.stringify({ command: `step ${i}` })))
    span.push(tool(`old${i}`, BIG(`OLD${i}`) + (secret && i === 1 ? '\nAPI_KEY=supersecretvalue123' : '')))
  }
  span.push(assistant('Writing a long file.', 'w1', 'Write', JSON.stringify({ file_path: 'a.ts', content: BIG('BODY') })))
  span.push(tool('w1', 'ok'))
  for (let i = 1; i <= 10; i++) {
    span.push(assistant(`Recent step ${i}.`, `new${i}`, 'Read', JSON.stringify({ file_path: `r${i}.ts` })))
    span.push(tool(`new${i}`, BIG(`NEW${i}`, 3000)))
  }
  span.push({ role: 'user', content: [{ type: 'text', text: 'latest prompt' }] })
  return span
}

function settings(extra = {}) {
  return settingsOf({ archiveDir: mkdtempSync(join(tmpdir(), 'fc-smoke-')), provider: 'none', ...extra })
}

let passed = 0
async function test(name, fn) {
  await fn()
  passed++
  console.log(`ok - ${name}`)
}

await test('mapSpanMessages drops the system head and reasoning, pairs tool results', () => {
  const mapped = mapSpanMessages(testSpan())
  assert.equal(mapped[0].text, 'Fix the failing test. Never edit src/generated.')
  assert.ok(!JSON.stringify(mapped).includes('SYSTEM PROMPT'))
  assert.ok(!JSON.stringify(mapped).includes('hidden reasoning'))
  assert.ok(!JSON.stringify(mapped).includes('tool-call block'))
  assert.deepEqual(mapped[1].toolUses, [{ tool_use_id: 'old1', tool: 'Bash', input: { command: 'step 1' } }])
  assert.equal(mapped[2].role, 'user')
  assert.equal(mapped[2].toolResults[0].tool_use_id, 'old1')
  const raw = mapSpanMessages([assistant('x', 'b', 'Glob', '{not json')])
  assert.deepEqual(raw[0].toolUses[0].input, { raw: '{not json' })
})

await test('settingsOf: defaults, clamps, unknown provider sends nothing', () => {
  const d = settingsOf({})
  assert.equal(d.provider, 'none', 'Jev is opt-in')
  assert.equal(d.providerNote, undefined)
  assert.equal(settingsOf({ provider: 'openrouter' }).url, 'https://openrouter.ai/api/v1/systemone')
  assert.equal(d.options.keepRecentCalls, 10)
  assert.equal(d.options.cutTo, 1500)
  assert.equal(d.minFreedRatio, 0.2)
  const typo = settingsOf({ provider: 'nnone', cutTo: 10, keepWhole: 7 })
  assert.equal(typo.provider, 'none')
  assert.equal(typo.providerNote, 'unknown provider "nnone"')
  assert.equal(typo.options.cutTo, 200)
  assert.equal(typo.options.keepWhole, 1)
  assert.equal(settingsOf({ provider: 'TypeSafe' }).url, 'https://api.typesafe.ai/v1/systemone')
})

await test('resolveApiKey: config, then env, then key file; none for provider none', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fc-key-')), 'key')
  writeFileSync(file, 'from-file\n')
  const saved = process.env.OPENROUTER_API_KEY
  try {
    delete process.env.OPENROUTER_API_KEY
    assert.equal(resolveApiKey(settingsOf({ provider: 'openrouter', apiKey: 'cfg', apiKeyFile: file })), 'cfg')
    assert.equal(resolveApiKey(settingsOf({ provider: 'openrouter', apiKeyFile: file })), 'from-file')
    assert.equal(resolveApiKey(settingsOf({ provider: 'openrouter', apiKeyFile: `${file}.missing` })), undefined)
    process.env.OPENROUTER_API_KEY = 'from-env'
    assert.equal(resolveApiKey(settingsOf({ provider: 'openrouter', apiKeyFile: file })), 'from-env')
    assert.equal(resolveApiKey(settingsOf({ provider: 'none', apiKey: 'cfg' })), undefined)
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = saved
  }
})

await test('without Jev: old outputs cut and archived, recent and prose verbatim', async () => {
  const s = settings()
  const out = await fastCompactSummarize(testSpan(), s, { sessionId: 'sess/1', now: () => 0 })
  assert.equal(out.decision.ranking, 'newest')
  assert.match(out.decision.jevSkipped, /provider is none/)
  assert.ok(out.freed >= 0.2, `freed ${out.freed}`)
  assert.match(out.dir, /sess_1-[0-9a-f]{8}$/)
  // Recent outputs and every prose line stay whole.
  assert.ok(out.text.includes(BIG('NEW1', 3000)))
  assert.ok(out.text.includes('Fix the failing test. Never edit src/generated.'))
  assert.ok(out.text.includes('latest prompt'))
  assert.ok(!out.text.includes('SYSTEM PROMPT'))
  // At least one old output is cut, and its file holds the original.
  const cut = out.decision.cuts.find(c => c.kind === 'output')
  assert.ok(cut, 'an output was cut')
  const file = join(out.dir, `output-${cut.key}.txt`)
  assert.equal(readFileSync(file, 'utf8'), cut.original)
  assert.ok(out.text.includes(`the full text is in ${file}`))
  assert.ok(out.text.includes(`${cut.key.toUpperCase()}-HEAD`))
  assert.ok(!out.text.includes(cut.original))
  // The long Write body is cut as an input field.
  assert.ok(out.decision.cuts.some(c => c.kind === 'input' && c.field === 'content'))
  assert.ok(!out.text.includes(BIG('BODY')))
})

await test('with Jev: the output Jev needs stays whole; secrets are masked in the request', async () => {
  const s = settings({ provider: 'openrouter', apiKey: 'k' })
  const bodies = []
  const transport = {
    async post(url, headers, body) {
      assert.equal(url, 'https://openrouter.ai/api/v1/systemone')
      assert.equal(headers.authorization, 'Bearer k')
      bodies.push(body)
      const { questions } = JSON.parse(body)
      const answers = {}
      for (const name of Object.keys(questions)) answers[name] = { noul: name === 'need_t1' ? 0.9 : 0.1 }
      return { status: 200, text: JSON.stringify({ answers, model: 'jev-test', usage: { input_tokens: 10, cost: 0.0001 } }) }
    },
    sleep: async () => {},
  }
  const out = await fastCompactSummarize(testSpan({ secret: true }), s, { sessionId: 's2', transport })
  assert.equal(out.decision.ranking, 'jev')
  assert.equal(out.decision.jev.model, 'jev-test')
  assert.ok(out.decision.whole.has('old1'))
  assert.ok(out.text.includes(BIG('OLD1')))
  assert.ok(!out.decision.cuts.some(c => c.key === 'old1'))
  assert.ok(bodies.length >= 1)
  assert.ok(!bodies.join('').includes('supersecretvalue123'))
})

await test('Jev failing never fails the compaction: newest kept whole instead', async () => {
  const s = settings({ provider: 'typesafe', apiKey: 'k' })
  let calls = 0
  const transport = { post: async () => { calls++; return { status: 500, text: 'boom' } }, sleep: async () => {} }
  const out = await fastCompactSummarize(testSpan(), s, { sessionId: 's3', transport })
  assert.equal(out.decision.ranking, 'newest')
  assert.match(out.decision.jevSkipped, /HTTP 500/)
  assert.equal(calls, 3)
})

await test('provider none and missing key never reach the transport', async () => {
  const transport = { post: async () => assert.fail('must not post'), sleep: async () => {} }
  await fastCompactSummarize(testSpan(), settings(), { transport })
  const saved = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  try {
    const out = await fastCompactSummarize(
      testSpan(),
      settings({ provider: 'openrouter', apiKeyFile: '/nonexistent/key' }),
      { transport },
    )
    assert.match(out.decision.jevSkipped, /no OPENROUTER_API_KEY key/)
  } finally {
    if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved
  }
})

await test('falls back when the span is small, nothing is cuttable, or too little is freed', async () => {
  await assert.rejects(
    fastCompactSummarize(testSpan().slice(0, 3), settings(), {}),
    e => e instanceof FastCompactFallbackError && /span too small/.test(e.message),
  )
  const short = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  for (let i = 0; i < 4; i++) short.push(assistant('a', `c${i}`, 'Read', '{}'), tool(`c${i}`, 'short'))
  await assert.rejects(
    fastCompactSummarize(short, settings(), {}),
    e => e instanceof FastCompactFallbackError && /nothing old enough/.test(e.message),
  )
  await assert.rejects(
    fastCompactSummarize(testSpan(), settings({ minFreedRatio: 0.99 }), {}),
    e => e instanceof FastCompactFallbackError && /below minimum 99%/.test(e.message),
  )
})

await test('tool ids are required, an oversized newest message falls back, abort writes nothing', async () => {
  const noId = testSpan()
  delete noId[3].toolCallId
  await assert.rejects(
    fastCompactSummarize(noId, settings(), {}),
    e => e instanceof FastCompactFallbackError && /no tool call id/.test(e.message),
  )
  const huge = testSpan()
  huge.push({ role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(20000) }] })
  await assert.rejects(
    fastCompactSummarize(huge, settings({ maxCheckpointChars: 8000 }), {}),
    e => e instanceof FastCompactFallbackError && /exceeds limit 8000/.test(e.message),
  )
  const s = settings()
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await assert.rejects(fastCompactSummarize(testSpan(), s, { sessionId: 'ab', signal: controller.signal }), /cancelled/)
  assert.deepEqual(readdirSync(s.archiveDir), [])
  const objectArgs = mapSpanMessages([{ role: 'assistant', content: [{ type: 'tool-call', id: 'o', name: 'X', arguments: { a: 1 } }] }])
  assert.deepEqual(objectArgs[0].toolUses[0].input, { a: 1 })
})

await test('checkpoint ceiling stubs the oldest messages and saves the whole span', async () => {
  const s = settings({ maxCheckpointChars: 8000 })
  const out = await fastCompactSummarize(testSpan(), s, { sessionId: 's4', now: () => 0 })
  assert.ok(out.stubbed > 0)
  const span = readdirSync(out.dir).find(f => f.startsWith('span-'))
  assert.ok(span, 'span file written')
  assert.ok(out.text.includes(join(out.dir, span)))
  assert.ok(readFileSync(join(out.dir, span), 'utf8').includes('Fix the failing test.'))
  assert.ok(out.text.includes('latest prompt'))
  assert.ok(out.text.length < 8000 + 2000)
})

await test('makeFetchTransport: posts, times out, and honours cancellation', async () => {
  const seen = []
  const transport = makeFetchTransport({
    fetchImpl: async (url, init) => {
      seen.push([url, init.method, init.headers['content-type'], init.body])
      return { status: 200, text: async () => 'ok' }
    },
  })
  assert.deepEqual(await transport.post('u', { 'content-type': 'application/json' }, 'b'), { status: 200, text: 'ok' })
  assert.deepEqual(seen, [['u', 'POST', 'application/json', 'b']])
  const controller = new AbortController()
  const slow = makeFetchTransport({ signal: controller.signal })
  const pending = slow.sleep(10_000)
  controller.abort(new Error('cancelled'))
  await assert.rejects(pending, /cancelled/)
})

console.log(`\n${passed} passed`)
