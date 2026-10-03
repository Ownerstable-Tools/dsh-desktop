/**
 * Jev-guided verbatim compaction backend for DeepSeek Harness.
 *
 * Subclasses the shipped `BasicCompactionEngine` and overrides its sole
 * `summarize()` hook: instead of an LLM-written checkpoint, the selected span
 * is pruned by TypeSafe Jev (every tool call and result scored in one fast
 * request; stale ones dropped or truncated, everything kept stays verbatim)
 * and rendered as the checkpoint text. Pressure triggers, `/compact`,
 * locking, pruning, persistence, and replay are all inherited unchanged.
 *
 * Any Jev problem — missing key, network failure, malformed answer, unfittable
 * state, a span too small to score, or a reduction below `minReductionRatio` —
 * falls back to the built-in LLM summary, matching the upstream Claude Code
 * hook's fail-safe. Cancellation never falls back; it propagates.
 *
 * Ported from the Claude Code plugin `fast-jev-compaction` v0.2.0 (MIT); the
 * library is vendored under vendor/fast-jev/ — see README.md for provenance.
 *
 * @module dsh-desktop-compaction-fast-jev
 */

import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import {
  DEFAULT_KEY_FILE,
  jevSummarize,
  makeFetchAsker,
  resolveApiKey,
} from './jev-adapt.js'

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

export class JevCompactionEngine extends BasicCompactionEngine {
  static Config = z.object({
    ...policyFields,
    modelPolicies: z.array(z.object({
      provider: z.string().required(),
      model: z.string().required(),
      ...policyFields,
    })),
    auto: z.boolean(),
    jev: z.object({
      /** TypeSafe API key; falls back to TYPESAFE_API_KEY, then to a key file. */
      apiKey: z.string(),
      /** Key file consulted last. Defaults to ~/.typesafe_key. */
      apiKeyFile: z.string(),
      /** System One endpoint override, for a proxy. Defaults to api.typesafe.ai. */
      baseUrl: z.string(),
      /** TypeSafe Jev model name. Defaults to jev-latest. */
      model: z.string(),
      /** Minimum keep probability for a call or result to stay. Defaults to 0.5. */
      keepThreshold: z.number(),
      /** Newest span messages never touched. Defaults to 6. */
      preserveRecentMessages: z.number().step(1).min(0),
      /** Estimated token ceiling for the state. Defaults to 25000. */
      maxStateTokens: z.number().step(1).min(1),
      /** Estimated ceiling for state plus one question batch. Defaults to 30000. */
      maxRequestTokens: z.number().step(1).min(1),
      /** Characters of a dropped tool result retained before its note. Defaults to 300. */
      truncateHeadChars: z.number().step(1).min(0),
      /** Per-Jev-request timeout in seconds; expiry falls back to the built-in summarizer. Defaults to 120. */
      requestTimeoutSeconds: z.number(),
      /** Ceiling on simultaneous Jev requests; further batches queue. Defaults to 4. */
      maxConcurrentRequests: z.number().step(1).min(1),
      /** Minimum estimated character reduction to accept the Jev result. Defaults to 0.25. */
      minReductionRatio: z.number(),
      /** Minimum mapped span messages worth scoring. Defaults to 4. */
      minSpanMessages: z.number().step(1).min(1),
      /** Ongoing task description; defaults to the span's last user prompts. */
      goal: z.string(),
    }),
  })

  constructor(ctx, config = {}) {
    // BasicCompactionEngine re-validates its constructor argument against
    // BasicCompactionConfig, which rejects unknown keys — so the `jev`
    // section must be stripped before super() ever sees it.
    const { jev, ...parentConfig } = config ?? {}
    super(ctx, parentConfig)
    this.jevOptions = jev !== null && typeof jev === 'object' ? jev : {}
  }

  /**
   * Summarize the selected span by Jev pruning instead of an LLM call.
   * Falls back to the inherited cache-reusing LLM summary whenever the Jev
   * path declines or fails; cancellation propagates without a fallback.
   */
  async summarize(input, agent, signal) {
    const model = this.jevOptions.model ?? 'jev-latest'
    try {
      const apiKey = resolveApiKey(this.jevOptions)
      if (apiKey === undefined) {
        throw new Error(
          `no TypeSafe API key (set config jev.apiKey, TYPESAFE_API_KEY, or ${DEFAULT_KEY_FILE})`,
        )
      }
      const asker = makeFetchAsker({
        apiKey,
        model,
        baseUrl: this.jevOptions.baseUrl,
        requestTimeoutSeconds: this.jevOptions.requestTimeoutSeconds,
        maxConcurrentRequests: this.jevOptions.maxConcurrentRequests,
        signal,
      })
      this.ctx.logger.info(
        `fast-jev-compaction: scoring ${input.messages.length} span message(s) via Jev `
        + `(timeout ${this.jevOptions.requestTimeoutSeconds ?? 120}s/request)…`,
      )
      const outcome = await jevSummarize(input.messages, asker, this.jevOptions)
      const stats = outcome.stats
      this.ctx.logger.info(
        `fast-jev-compaction: kept ${stats.messagesAfter}/${stats.messagesBefore} messages, no summary `
        + `(${Math.round(outcome.ratio * 100)}% smaller; ${stats.kept} calls kept, `
        + `${stats.resultsDropped} results truncated, ${stats.callsDropped} calls removed; `
        + `${stats.requests} Jev request(s), ${stats.ms}ms)`,
      )
      if (typeof this.ctx.logger.debug === 'function') {
        for (const decision of outcome.decisions) {
          this.ctx.logger.debug(
            `fast-jev-compaction decisions: ${decision.id} ${decision.tool} `
            + `call=${decision.keepCall.toFixed(2)} result=${decision.keepResult.toFixed(2)} → ${decision.reason}`,
          )
        }
      }
      const blocks = [{ type: 'text', text: outcome.text }]
      return {
        summary: blocks,
        rawOutput: blocks,
        provider: 'typesafe-jev',
        model,
      }
    } catch (error) {
      if (signal?.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`fast-jev-compaction: fallback to built-in summary (${message})`)
      return super.summarize(input, agent, signal)
    }
  }
}

export default JevCompactionEngine
