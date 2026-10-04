/**
 * Engine-free adapter between DeepSeek Harness compaction and the vendored
 * fast-jev-compaction library. No `@deepseek-ai/*` imports here so the whole
 * decision path is testable under plain node (see test/smoke.mjs).
 *
 * Ported from the Claude Code function hook `hooks/fast-jev.ts` of the
 * fast-jev-compaction plugin v0.2.0 (MIT) — see README.md for provenance.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { compact, reductionRatio } from './vendor/fast-jev/compact.js'
import { buildJevRequest, parseJevResponse } from './vendor/fast-jev/request.js'

/** A reason the Jev path declined; the caller falls back to the LLM summary. */
export class JevFallbackError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'JevFallbackError'
  }
}

/** The key file consulted when neither config nor environment carries a key. */
export const DEFAULT_KEY_FILE = join(homedir(), '.typesafe_key')

/** Resolve the TypeSafe key: explicit config, then env, then key file. */
export function resolveApiKey(options = {}) {
  if (typeof options.apiKey === 'string' && options.apiKey.length > 0) return options.apiKey
  const env = process.env.TYPESAFE_API_KEY
  if (typeof env === 'string' && env.length > 0) return env
  const file = typeof options.apiKeyFile === 'string' && options.apiKeyFile.length > 0
    ? options.apiKeyFile
    : DEFAULT_KEY_FILE
  try {
    const key = readFileSync(file, 'utf8').trim()
    return key.length > 0 ? key : undefined
  } catch {
    return undefined
  }
}

/** A `JevAsker` over any fetch-like transport, forwarding cancellation. */
/** Per-request Jev HTTP timeout, in seconds, unless the caller overrides it. */
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 120
/** Ceiling on simultaneous Jev requests; extra batches queue behind it. */
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 4

/**
 * Jev asker over `fetch`.
 *
 * Every request gets its own timeout signal composed with the caller's
 * cancellation signal, so a stalled connection surfaces as a `TimeoutError`
 * the engine can fall back on instead of hanging the compaction forever
 * (a bare hang never reaches the fallback, which only fires on errors).
 * Requests are also capped at `maxConcurrentRequests` in flight — a huge
 * span can produce many question batches, and firing them all at once
 * invites server-side stalls; the rest queue behind a simple semaphore.
 */
export function makeFetchAsker(params) {
  const doFetch = params.fetchImpl ?? globalThis.fetch
  const timeoutMs = (Number.isFinite(params.requestTimeoutSeconds) && params.requestTimeoutSeconds > 0
    ? params.requestTimeoutSeconds
    : DEFAULT_REQUEST_TIMEOUT_SECONDS) * 1000
  const maxConcurrent = Number.isInteger(params.maxConcurrentRequests) && params.maxConcurrentRequests > 0
    ? params.maxConcurrentRequests
    : DEFAULT_MAX_CONCURRENT_REQUESTS
  let active = 0
  const waiting = []
  const acquire = () => new Promise((resolve) => {
    if (active < maxConcurrent) {
      active++
      resolve()
    } else waiting.push(resolve)
  })
  const release = () => {
    const next = waiting.shift()
    // Hand the slot directly to the next waiter; otherwise free it.
    if (next !== undefined) next()
    else active--
  }
  return {
    async ask(state, questions) {
      await acquire()
      try {
        const request = buildJevRequest(
          {
            apiKey: params.apiKey,
            model: params.model,
            ...(params.baseUrl === undefined ? {} : { baseUrl: params.baseUrl }),
          },
          state,
          questions,
        )
        const timeoutSignal = AbortSignal.timeout(timeoutMs)
        const signal = params.signal === undefined
          ? timeoutSignal
          : AbortSignal.any([params.signal, timeoutSignal])
        const response = await doFetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal,
        })
        return parseJevResponse(response.status, response.ok, await response.text())
      } finally {
        release()
      }
    },
  }
}

/** Parse a tool-call `arguments` JSON string; unparsable input survives raw. */
function parseArguments(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    return { value: parsed }
  } catch {
    return { raw }
  }
}

/** Verbatim-safe text for non-text content blocks. */
function blockPlaceholder(block) {
  switch (block.type) {
    case 'image': return '[image]'
    case 'file': return `[file: ${block.attachment?.name ?? 'attachment'}]`
    case 'tool-addition': return `[tool added: ${block.toolName}]`
    case 'tool-removal': return `[tool removed: ${block.toolName}]`
    default: return `[${String(block.type ?? 'unknown')} block]`
  }
}

function blocksToText(content) {
  const parts = []
  for (const block of content ?? []) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type !== 'reasoning') parts.push(blockPlaceholder(block))
  }
  return parts.join('\n')
}

/**
 * Map derived DSH span messages onto the library transcript shape. The system
 * head is skipped (it is replay context, not compacted history); `tool`-role
 * results become user-role messages carrying `toolResults`, which the library
 * pairs with their calls by id. Reasoning blocks are transient and dropped;
 * images and files become short placeholders because the checkpoint is text.
 */
export function mapSpanMessages(messages) {
  const mapped = []
  for (const message of messages ?? []) {
    if (message === null || typeof message !== 'object') continue
    if (message.role === 'system') continue
    if (message.role === 'tool') {
      mapped.push({
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [{
          tool_use_id: String(message.toolCallId),
          text: blocksToText(message.content),
          isError: message.isError === true,
        }],
      })
      continue
    }
    const toolUses = []
    for (const block of message.content ?? []) {
      if (block !== null && typeof block === 'object' && block.type === 'tool-call') {
        toolUses.push({
          tool_use_id: String(block.id),
          tool: String(block.name ?? 'tool'),
          input: parseArguments(block.arguments),
        })
      }
    }
    mapped.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      text: blocksToText(message.content),
      toolUses,
    })
  }
  return mapped
}

function stableStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Default ceiling on checkpoint text. The chat UI renders the compaction
 * summary and the checkpoint message through its full markdown pipeline and
 * blanks out on six-figure payloads (observed crash at ~210 KB), so the
 * adapter declines oversized transcripts so the caller can use the normal
 * summary without silently discarding kept content. Raise `jev.maxCheckpointChars` for consumers that
 * render plain text (terminal hooks, replays).
 */
export const DEFAULT_MAX_CHECKPOINT_CHARS = 48000

/**
 * Render the pruned transcript as the checkpoint text. Everything the library
 * kept is emitted verbatim and in order. An oversized checkpoint throws
 * JevFallbackError; truncation notes for dropped results come from the library.
 */
export function renderTranscript(result, ratio, budgetChars = DEFAULT_MAX_CHECKPOINT_CHARS) {
  const stats = result.stats
  const chunks = []
  for (const message of result.messages) {
    const lines = []
    const results = message.toolResults ?? []
    const bareResults = message.role === 'user'
      && message.text.trim().length === 0
      && message.toolUses.length === 0
      && results.length > 0
    if (!bareResults) {
      lines.push(`<${message.role}>`)
      if (message.text.trim().length > 0) lines.push(message.text)
      for (const tool of message.toolUses) {
        lines.push(`[tool call ${tool.tool} id=${tool.tool_use_id}] ${stableStringify(tool.input)}`)
      }
    }
    for (const entry of results) {
      lines.push(`[tool result id=${entry.tool_use_id}${entry.isError ? ' (error)' : ''}]`)
      lines.push(entry.text)
      if (bareResults) lines.push('')
    }
    if (!bareResults) {
      lines.push(`</${message.role}>`)
      lines.push('')
    }
    chunks.push(lines.join('\n'))
  }
  const lines = [
    '[Jev-pruned verbatim transcript] The compacted span below is the original '
    + 'conversation, verbatim and in order, minus the tool calls and tool results '
    + 'Jev judged no longer needed; truncated results keep their head plus a note. '
    + `Kept ${stats.messagesAfter}/${stats.messagesBefore} messages `
    + `(${Math.round((ratio ?? 0) * 100)}% smaller): ${stats.kept} tool calls kept, `
    + `${stats.resultsDropped} results truncated, ${stats.callsDropped} calls removed. `
    + 'Anything removed can be re-fetched by running its tool again.',
    '',
  ]
  const text = [...lines, ...chunks].join('\n').trimEnd() + '\n'
  if (text.length > budgetChars) {
    throw new JevFallbackError(`checkpoint ${text.length} chars exceeds limit ${budgetChars}`)
  }
  return text
}

/**
 * Run one Jev-guided compaction of a DSH span.
 * @param spanMessages - derived messages of the span, optionally led by the system head.
 * @param asker - the Jev transport (see makeFetchAsker).
 * @param options - library pass-throughs plus `minReductionRatio` and `minSpanMessages`.
 * @returns the rendered checkpoint text plus stats, ratio, and decisions.
 * @throws JevFallbackError when the span is too small or the reduction is too low;
 *   any other error (Jev failure, unfittable state) propagates for the caller to catch.
 */
export async function jevSummarize(spanMessages, asker, options = {}) {
  const mapped = mapSpanMessages(spanMessages)
  const minSpan = options.minSpanMessages ?? 4
  if (mapped.length < minSpan) {
    throw new JevFallbackError(`span too small for Jev scoring (${mapped.length} messages)`)
  }
  const compactOptions = {}
  for (const key of [
    'goal',
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ]) {
    if (options[key] !== undefined) compactOptions[key] = options[key]
  }
  let result
  try {
    result = await compact(mapped, asker, compactOptions)
  } catch (error) {
    // The state digest has a floor of roughly STATE_TOKENS_PER_CALL per tool
    // call even fully truncated; spans past that floor cannot fit one state.
    // Score them in chunks instead, each with its own state, and merge.
    if (!(error instanceof Error) || !/history too large for Jev/.test(error.message)) throw error
    result = await compactInChunks(mapped, asker, compactOptions)
  }
  const ratio = reductionRatio(result)
  const min = options.minReductionRatio ?? 0.25
  if (ratio < min) {
    throw new JevFallbackError(
      `Jev reduction ${(ratio * 100).toFixed(1)}% below minimum ${(min * 100).toFixed(0)}%`,
    )
  }
  return {
    text: renderTranscript(result, ratio, options.maxCheckpointChars),
    stats: result.stats,
    ratio,
    decisions: result.decisions,
  }
}

/** Measured state-floor cost of one tool-call entry at full truncation. */
const STATE_TOKENS_PER_CALL = 65

/**
 * Split mapped span messages into chunks whose call counts fit one Jev state.
 * A cut never lands on a tool-result message, so a result is never orphaned
 * from the call it answers; chunks end after a result or text message and the
 * next begins with fresh content.
 * @param messages - mapped transcript messages.
 * @param maxStateTokens - the state budget one chunk must fit under.
 * @returns the ordered chunks (a single chunk when the span already fits).
 */
export function splitSpanForState(messages, maxStateTokens) {
  const target = Math.max(20, Math.floor((maxStateTokens * 0.9) / STATE_TOKENS_PER_CALL))
  const chunks = []
  let current = []
  let calls = 0
  for (const message of messages) {
    const isResult = (message.toolResults ?? []).length > 0
    if (calls >= target && !isResult && current.length > 0) {
      chunks.push(current)
      current = []
      calls = 0
    }
    current.push(message)
    calls += (message.toolUses ?? []).length
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * Score an over-floor span chunk by chunk and merge into one library-shaped
 * result. The recency window applies only to the final chunk — mid-span tails
 * are ordinary history. Any chunk failure propagates: the caller's fallback
 * covers the whole compaction, never a partially pruned span.
 */
async function compactInChunks(mapped, asker, compactOptions) {
  const maxState = compactOptions.maxStateTokens ?? 25000
  const chunks = splitSpanForState(mapped, maxState)
  if (chunks.length < 2) {
    throw new JevFallbackError(
      `span cannot be split to fit the Jev state (${mapped.length} messages, floor exceeds ${maxState} tokens)`,
    )
  }
  const parts = []
  for (const [index, chunk] of chunks.entries()) {
    const isLast = index === chunks.length - 1
    parts.push(await compact(
      chunk,
      asker,
      isLast ? compactOptions : { ...compactOptions, preserveRecentMessages: 0 },
    ))
  }
  const sum = (key) => parts.reduce((total, part) => total + part.stats[key], 0)
  const stats = {
    messagesBefore: sum('messagesBefore'),
    messagesAfter: sum('messagesAfter'),
    charsBefore: sum('charsBefore'),
    charsAfter: sum('charsAfter'),
    calls: sum('calls'),
    kept: sum('kept'),
    resultsDropped: sum('resultsDropped'),
    callsDropped: sum('callsDropped'),
    pinned: sum('pinned'),
    stateTokens: Math.max(...parts.map(part => part.stats.stateTokens)),
    stateStage: [...new Set(parts.map(part => part.stats.stateStage))].join('+'),
    requests: sum('requests'),
    ms: sum('ms'),
    chunks: parts.length,
  }
  return {
    messages: parts.flatMap(part => part.messages),
    decisions: parts.flatMap(part => part.decisions),
    stats,
  }
}
