/**
 * fast-compact compaction backend for DeepSeek Harness.
 *
 * Subclasses the shipped `BasicCompactionEngine` and overrides its sole
 * `summarize()` hook: instead of an LLM-written checkpoint, the selected span
 * is rendered verbatim with old tool outputs (and long old tool inputs and
 * host notices) cut to their start and end. Jev, when a key is set, picks
 * which old outputs stay whole. Every cut's full text is saved to a file
 * named in its place, so nothing is lost. Pressure triggers, `/compact`,
 * locking, pruning, persistence, and replay are all inherited unchanged.
 *
 * Jev failing never fails the compaction: the newest outputs are kept whole
 * instead. The built-in LLM summary runs only when the cut cannot help — a
 * span too small, nothing old and long enough to cut, a cut freeing less than
 * `minFreedRatio`, or an archive write failure. Cancellation never falls
 * back; it propagates.
 *
 * Ported from the Claude Code plugin `fast-compact` v0.3.0 (MIT); the library
 * is vendored under vendor/fast-compact/ — see README.md for provenance.
 *
 * @module dsh-desktop-compaction-fast-compact
 */

import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { fastCompactSummarize, makeFetchTransport, settingsOf } from './adapt.js'

const thresholdRatio = z.number()
const headroomTokens = z.number().step(1).min(0)
const retainRatio = z.number()
const retainTokens = z.number().step(1).min(0)
const summarizationProvider = z.string()
const summarizationModel = z.string()
const maxTokens = z.number().step(1).min(1)
const compactionRetries = z.number().step(1).min(0)
const maxOverflowRetries = z.number().step(1).min(0)

/** Every BasicCompactionConfig field, restated because a subclass Config replaces the parent's. */
const policyFields = {
  thresholdRatio,
  headroomTokens,
  retainRatio,
  retainTokens,
  summarizationProvider,
  summarizationModel,
  maxTokens,
  compactionRetries,
  maxOverflowRetries,
}

export class FastCompactEngine extends BasicCompactionEngine {
  static Config = z.object({
    ...policyFields,
    modelPolicies: z.array(z.object({
      provider: z.string().required(),
      model: z.string().required(),
      ...policyFields,
    })),
    auto: z.boolean(),
    fastCompact: z.object({
      /** `typesafe`, `openrouter`, or `none` (default): never ask Jev. Any other value counts as `none`. */
      provider: z.string(),
      /** Jev key; falls back to OPENROUTER_API_KEY / TYPESAFE_API_KEY, then to a key file. */
      apiKey: z.string(),
      /** Key file consulted last. Defaults to ~/.openrouter_key or ~/.typesafe_key by provider. */
      apiKeyFile: z.string(),
      /** System One endpoint override. Defaults to the provider's. */
      baseUrl: z.string(),
      /** Jev model name. Defaults to jev-latest. */
      model: z.string(),
      /** Where cuts are saved, one folder per session. Defaults to <DSH_HOME or ~/.dsh>/fast-compact. */
      archiveDir: z.string(),
      /** Newest tool calls never cut. Defaults to 10. */
      keepRecentCalls: z.number().step(1).min(0),
      /** Characters a cut keeps: two thirds from the start, one third from the end. Defaults to 1500. */
      cutTo: z.number().step(1).min(200),
      /** Largest share of old output Jev may keep whole. Defaults to 0.25. */
      keepWhole: z.number(),
      /** Jev's lowest score for keeping an output whole. Defaults to 0.45. */
      minKeepScore: z.number(),
      /** Also trim long old tool inputs. Defaults to true. */
      cutInputs: z.boolean(),
      /** Show Jev the first 200 and last 100 characters of each output it ranks. Defaults to true. */
      sendSamples: z.boolean(),
      /** Estimated token ceilings for the Jev state and one request. Default 25000 / 60000. */
      maxStateTokens: z.number().step(1).min(1),
      maxRequestTokens: z.number().step(1).min(1),
      /** Per-Jev-request timeout in seconds. Defaults to 20. */
      requestTimeoutSeconds: z.number(),
      /** Ceiling on simultaneous Jev requests. Defaults to 4. */
      maxConcurrentRequests: z.number().step(1).min(1),
      /** Below this share freed, the built-in summary runs instead. Defaults to 0.2. */
      minFreedRatio: z.number(),
      /** Smaller spans use the built-in summary. Defaults to 4. */
      minSpanMessages: z.number().step(1).min(1),
      /** Ceiling on checkpoint text chars for UI-safe rendering. Defaults to 48000. */
      maxCheckpointChars: z.number().step(1).min(1),
      /** What to keep, sent to Jev beside the goal. */
      focus: z.string(),
    }),
  })

  constructor(ctx, config = {}) {
    // BasicCompactionEngine re-validates its constructor argument against
    // BasicCompactionConfig, which rejects unknown keys — so the `fastCompact`
    // section must be stripped before super() ever sees it.
    const { fastCompact, ...parentConfig } = config ?? {}
    super(ctx, parentConfig)
    this.settings = settingsOf(fastCompact !== null && typeof fastCompact === 'object' ? fastCompact : {})
  }

  /**
   * Summarize the selected span by cutting old tool output instead of an LLM
   * call. Falls back to the inherited LLM summary only when the cut cannot
   * help; cancellation propagates without a fallback.
   */
  async summarize(input, agent, signal) {
    try {
      const transport = makeFetchTransport({
        requestTimeoutSeconds: this.settings.requestTimeoutSeconds,
        signal,
      })
      this.ctx.logger.info(`fast-compact: cutting ${input.messages.length} span message(s)…`)
      const outcome = await fastCompactSummarize(input.messages, this.settings, {
        sessionId: agent?.session?.id,
        transport,
        signal,
      })
      if (signal?.aborted) throw signal.reason
      const { decision, counts } = outcome
      const jev = decision.jev
        ? `Jev ${decision.jev.model || this.settings.model}: ${decision.jev.requests} request(s), `
          + `${(decision.jev.ms / 1000).toFixed(1)} s, $${decision.jev.cost.toFixed(4)}`
        : `no Jev (${decision.jevSkipped ?? 'not asked'}), newest kept whole`
      this.ctx.logger.info(
        `fast-compact: ${outcome.before} → ${outcome.after} chars (−${Math.round(outcome.freed * 100)}%); `
        + `${counts.outputs} output(s), ${counts.inputs} input(s), ${counts.notices} notice(s) cut; `
        + `${decision.whole.size} kept whole; ${jev}; full text in ${outcome.dir}`
        + (outcome.stubbed > 0 ? `; ${outcome.stubbed} oldest message(s) stubbed for the checkpoint ceiling` : ''),
      )
      const blocks = [{ type: 'text', text: outcome.text }]
      // Supplied by the pinned host patch: price the actual framed checkpoint
      // before returning, while the stock-summary fallback is still available.
      if (typeof input.canAcceptSummary !== 'function' || !input.canAcceptSummary(blocks)) {
        throw new Error('checkpoint cannot be verified smaller than the selected span')
      }
      return {
        summary: blocks,
        rawOutput: blocks,
        provider: decision.jev ? `fast-compact/${this.settings.provider}` : 'fast-compact',
        model: decision.jev ? this.settings.model : 'none',
      }
    } catch (error) {
      if (signal?.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`fast-compact: fallback to built-in summary (${message})`)
      return super.summarize(input, agent, signal)
    }
  }
}

export default FastCompactEngine
