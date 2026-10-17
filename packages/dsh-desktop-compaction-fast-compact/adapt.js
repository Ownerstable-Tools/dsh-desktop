/**
 * Engine-free adapter between DeepSeek Harness compaction and the vendored
 * fast-compact library. No `@deepseek-ai/*` imports here so the whole
 * decision path is testable under plain node (see test/smoke.mjs).
 *
 * Ported from the Claude Code plugin `fast-compact` v0.3.0 (MIT): old tool
 * output is cut to its start and end, Jev (optional) choosing which outputs
 * stay whole, and every cut is saved to a file named in its place before
 * anything is cut. See README.md for provenance.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { applyCuts, decide, sizeOf } from './vendor/fast-compact/compact.js'
import { DEFAULT_MODEL, ENDPOINTS } from './vendor/fast-compact/jev.js'
import { DEFAULT_OPTIONS } from './vendor/fast-compact/types.js'

/** A reason the cut path declined; the caller falls back to the LLM summary. */
export class FastCompactFallbackError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'FastCompactFallbackError'
  }
}

/** Environment variable and key file consulted for each Jev provider. */
export const PROVIDER_KEYS = {
  openrouter: { env: 'OPENROUTER_API_KEY', file: join(homedir(), '.openrouter_key') },
  typesafe: { env: 'TYPESAFE_API_KEY', file: join(homedir(), '.typesafe_key') },
}

/** Per-Jev-request timeout unless the row overrides it. */
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 20
/**
 * The cut is used only when it frees at least this share of the span: with
 * less, the context stays near the pressure threshold and compacts again a few
 * turns later, so the built-in summary runs instead (fast-compact's
 * AUTO_MIN_FREED).
 */
export const DEFAULT_MIN_FREED_RATIO = 0.2
/**
 * Ceiling on checkpoint text. The chat UI renders the checkpoint through its
 * full markdown pipeline and blanks out on six-figure payloads (observed crash
 * at ~210 KB), so the newest messages are kept and the older overflow is
 * stubbed with a pointer to the saved full span.
 */
export const DEFAULT_MAX_CHECKPOINT_CHARS = 48000

/** Where cuts are saved: `<DSH_HOME or ~/.dsh>/fast-compact`. */
export function defaultArchiveRoot() {
  const home = process.env.DSH_HOME
  return join(typeof home === 'string' && home.length > 0 ? home : join(homedir(), '.dsh'), 'fast-compact')
}

function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function str(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Row `config.fastCompact` → settings, with fast-compact's defaults and clamps. */
export function settingsOf(raw = {}) {
  // Jev is opt-in: with no provider named, nothing is sent even when a key
  // happens to be in the environment. Anything but a known provider sends
  // nothing either: a mistyped `none` must not reach a Jev endpoint.
  const named = str(raw.provider)?.toLowerCase()
  const provider = named === 'openrouter' || named === 'typesafe' ? named : 'none'
  const d = DEFAULT_OPTIONS
  return {
    provider,
    providerNote: provider === 'none' && named !== undefined && named !== 'none' && named !== 'off'
      ? `unknown provider "${named}"`
      : undefined,
    url: str(raw.baseUrl) ?? (provider === 'none' ? '' : ENDPOINTS[provider]),
    model: str(raw.model) ?? DEFAULT_MODEL,
    apiKey: str(raw.apiKey),
    apiKeyFile: str(raw.apiKeyFile),
    archiveDir: str(raw.archiveDir),
    requestTimeoutSeconds: Math.max(1, num(raw.requestTimeoutSeconds, DEFAULT_REQUEST_TIMEOUT_SECONDS)),
    concurrency: Math.max(1, Math.floor(num(raw.maxConcurrentRequests, 4))),
    minFreedRatio: Math.min(1, Math.max(0, num(raw.minFreedRatio, DEFAULT_MIN_FREED_RATIO))),
    minSpanMessages: Math.max(1, Math.floor(num(raw.minSpanMessages, 4))),
    maxCheckpointChars: Math.max(1, Math.floor(num(raw.maxCheckpointChars, DEFAULT_MAX_CHECKPOINT_CHARS))),
    focus: str(raw.focus),
    options: {
      ...d,
      keepRecentCalls: Math.max(0, Math.floor(num(raw.keepRecentCalls, d.keepRecentCalls))),
      cutTo: Math.max(200, Math.floor(num(raw.cutTo, d.cutTo))),
      keepWhole: Math.min(1, Math.max(0, num(raw.keepWhole, d.keepWhole))),
      minKeepScore: Math.min(1, Math.max(0, num(raw.minKeepScore, d.minKeepScore))),
      cutInputs: bool(raw.cutInputs, d.cutInputs),
      sendSamples: bool(raw.sendSamples, d.sendSamples),
      maxStateTokens: Math.max(1, Math.floor(num(raw.maxStateTokens, d.maxStateTokens))),
      maxRequestTokens: Math.max(1, Math.floor(num(raw.maxRequestTokens, d.maxRequestTokens))),
    },
  }
}

/** The Jev key for `settings.provider`: row config, then env, then key file. */
export function resolveApiKey(settings) {
  if (settings.provider === 'none') return undefined
  if (settings.apiKey !== undefined) return settings.apiKey
  const source = PROVIDER_KEYS[settings.provider]
  const env = process.env[source.env]
  if (typeof env === 'string' && env.trim().length > 0) return env.trim()
  try {
    const key = readFileSync(settings.apiKeyFile ?? source.file, 'utf8').trim()
    return key.length > 0 ? key : undefined
  } catch {
    return undefined
  }
}

/**
 * fast-compact `Transport` over `fetch`. Each request gets its own timeout
 * composed with the caller's cancellation signal; a timeout is a transport
 * error, which fast-compact retries and then answers by ranking newest first.
 */
export function makeFetchTransport({ fetchImpl, requestTimeoutSeconds, signal } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch
  const timeoutMs = (requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS) * 1000
  return {
    async post(url, headers, body) {
      const timeout = AbortSignal.timeout(timeoutMs)
      const response = await doFetch(url, {
        method: 'POST',
        headers,
        body,
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      })
      return { status: response.status, text: await response.text() }
    },
    sleep(ms) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(signal.reason)
        }, { once: true })
      })
    },
  }
}

/** Parse a tool-call `arguments` JSON string; unparsable input survives raw. */
function parseArguments(raw) {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw
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
    else if (block.type !== 'reasoning' && block.type !== 'tool-call') parts.push(blockPlaceholder(block))
  }
  return parts.join('\n')
}

/**
 * Map derived DSH span messages onto fast-compact's transcript shape. The
 * system head is skipped (it is replay context, not compacted history);
 * `tool`-role results become user-role messages carrying `toolResults`, which
 * the library pairs with their calls by id. Reasoning blocks are transient and
 * dropped; images and files become short placeholders because the checkpoint
 * is text.
 */
export function mapSpanMessages(messages) {
  const mapped = []
  for (const message of messages ?? []) {
    if (message === null || typeof message !== 'object') continue
    if (message.role === 'system') continue
    if (message.role === 'tool') {
      // A cut is archived under its tool call id; without one two outputs
      // would share a file.
      if (message.toolCallId === undefined || message.toolCallId === null || message.toolCallId === '') {
        throw new FastCompactFallbackError('a tool result has no tool call id')
      }
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
        if (block.id === undefined || block.id === null || block.id === '') {
          throw new FastCompactFallbackError('a tool call has no id')
        }
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

/**
 * What `decide` needs to ask Jev, or a string saying why it is not asked.
 * @param env - `{ transport, now }`; `transport` absent means no Jev.
 */
export function jevAccess(settings, env = {}) {
  if (settings.provider === 'none') return settings.providerNote ?? 'provider is none'
  const apiKey = resolveApiKey(settings)
  if (apiKey === undefined) return `no ${PROVIDER_KEYS[settings.provider].env} key`
  if (env.transport === undefined) return 'no transport'
  return {
    transport: env.transport,
    config: { url: settings.url, apiKey, model: settings.model, concurrency: settings.concurrency },
    now: async () => (env.now ?? Date.now)(),
  }
}

/** A file-name-safe timestamp. */
export function stampOf(now = Date.now) {
  return new Date(now()).toISOString().replace(/[:.]/g, '-')
}

/**
 * Save each cut's full text under `dir` (created private) and return the
 * `pathOf` that names its file in the cut's marker. Throws on any write
 * failure, before anything is cut.
 */
export function archiveCuts(cuts, dir, stamp) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const pathOf = (cut) => join(
    dir,
    `${cut.kind}-${safeName(cut.kind === 'notice' ? `${stamp}-${cut.key}` : cut.key)}.txt`,
  )
  for (const cut of cuts) writeFileSync(pathOf(cut), cut.original, { mode: 0o600 })
  return pathOf
}

/** A short, stable hash of `text` (FNV-1a, 8 hex digits). */
export function hashOf(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** A file-name-safe form of `key`; a key that had unsafe characters gets its hash, so `a/b` and `a_b` never collide. */
export function safeName(key) {
  const safe = key.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')
  return safe === key ? safe : `${safe}-${hashOf(key)}`
}

function stableStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** One message as checkpoint text. */
function renderMessage(message) {
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
  return lines.join('\n')
}

/**
 * Render the cut span as checkpoint text: every message in order, newest
 * kept first within `budgetChars`; older overflow is replaced by one line
 * naming `spanFile`, where the caller saves the whole cut span.
 * @returns the text and how many messages were left out.
 */
export function renderTranscript(messages, header, budgetChars, spanFile) {
  const chunks = messages.map(renderMessage)
  const kept = []
  let total = 0
  let stubbed = 0
  for (let index = chunks.length - 1; index >= 0; index--) {
    const chunk = chunks[index]
    if (kept.length > 0 && total + chunk.length + 1 > budgetChars) {
      stubbed = index + 1
      break
    }
    kept.unshift(chunk)
    total += chunk.length + 1
  }
  const lines = [header]
  if (stubbed > 0) {
    lines.push(
      `[fast-compact: the ${stubbed} oldest message(s) of this span are left out to keep this checkpoint `
      + `within ${budgetChars} chars; the whole span as cut is in ${spanFile} — read it before relying on them]`,
    )
  }
  lines.push('')
  return { text: [...lines, ...kept].join('\n').trimEnd() + '\n', stubbed }
}

/**
 * Run one fast-compact pass over a DSH span.
 * @param spanMessages - derived messages of the span, optionally led by the system head.
 * @param settings - from `settingsOf`.
 * @param env - `{ sessionId, transport, now, signal }`; `transport` absent means no Jev;
 *   an aborted `signal` stops the pass before anything is written.
 * @returns the checkpoint text plus the decision, sizes and archive dir.
 * @throws FastCompactFallbackError when the span is too small, nothing can be
 *   cut, or the cut frees less than `minFreedRatio`; archive write failures
 *   propagate for the caller to catch.
 */
export async function fastCompactSummarize(spanMessages, settings, env = {}) {
  const messages = mapSpanMessages(spanMessages)
  if (messages.length < settings.minSpanMessages) {
    throw new FastCompactFallbackError(`span too small to cut (${messages.length} messages)`)
  }
  const decision = await decide(messages, settings.options, jevAccess(settings, env), settings.focus)
  if (decision.cuts.length === 0) {
    throw new FastCompactFallbackError(
      `nothing old enough and long enough to cut (the newest ${settings.options.keepRecentCalls} tool calls are kept as they are)`,
    )
  }
  const before = sizeOf(messages)
  const probe = sizeOf(applyCuts(messages, decision.cuts, () => '', settings.options))
  const freed = before === 0 ? 0 : (before - probe) / before
  if (freed < settings.minFreedRatio) {
    throw new FastCompactFallbackError(
      `cut frees ${(freed * 100).toFixed(1)}%, below minimum ${(settings.minFreedRatio * 100).toFixed(0)}%`,
    )
  }

  if (env.signal?.aborted) throw env.signal.reason
  const stamp = stampOf(env.now)
  const dir = join(settings.archiveDir ?? defaultArchiveRoot(), safeName(String(env.sessionId ?? 'session')))
  // Nothing is cut before its full text is on disk; a failed write fails the
  // whole pass, and the caller falls back to the built-in summary.
  const pathOf = archiveCuts(decision.cuts, dir, stamp)
  const after = applyCuts(messages, decision.cuts, pathOf, settings.options)
  const spanFile = join(dir, `span-${stamp}.txt`)

  const outputs = decision.cuts.filter(c => c.kind === 'output').length
  const inputs = decision.cuts.filter(c => c.kind === 'input').length
  const notices = decision.cuts.filter(c => c.kind === 'notice').length
  const header = '[fast-compact checkpoint] The compacted span below is the original conversation, '
    + 'verbatim and in order, except that old tool outputs, long old tool inputs and old host notices '
    + 'are cut to their start and end. Every cut names the file holding its full text; read that file '
    + `before relying on what was cut. ${outputs} output(s), ${inputs} input(s) and ${notices} notice(s) cut`
    + (decision.whole.size > 0
      ? `; ${decision.whole.size} output(s) kept whole ${decision.ranking === 'jev' ? 'on Jev\'s ranking' : 'as the newest'}`
      : '')
    + '.'
  const { text, stubbed } = renderTranscript(after, header, settings.maxCheckpointChars, spanFile)
  if (text.length > settings.maxCheckpointChars + header.length + 1000) {
    // The newest message alone is over the ceiling; the chat UI would blank on it.
    throw new FastCompactFallbackError(
      `checkpoint ${text.length} chars exceeds limit ${settings.maxCheckpointChars} even with older messages left out`,
    )
  }
  if (stubbed > 0) writeFileSync(spanFile, after.map(renderMessage).join('\n'), { mode: 0o600 })
  return {
    text,
    decision,
    before,
    after: sizeOf(after),
    freed,
    dir,
    counts: { outputs, inputs, notices },
    stubbed,
  }
}
