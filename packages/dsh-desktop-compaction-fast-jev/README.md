# dsh-desktop-compaction-fast-jev

Jev-guided **verbatim** compaction backend for DSH Desktop — a port of the
Claude Code plugin `fast-jev-compaction` (MIT, vendored under
`vendor/fast-jev/`; see Provenance below).

Instead of an LLM-written summary, a compaction replaces the selected older
span with the **original conversation, verbatim and in order, minus the tool
calls and tool results Jev judged no longer needed**. Dropped results keep
their first `truncateHeadChars` characters plus a one-line note; dropped calls
disappear with their results. User and assistant text is never rewritten.

## How it plugs into DSH

DSH's seam is the compaction **backend**. `index.js` subclasses the shipped
`BasicCompactionEngine` (`@deepseek-ai/dsh-compaction-basic`) and overrides
its sole documented customization hook, `summarize()`:

- Pressure triggers, `/compact`, the durable `compaction/start`→`end` lock,
  tool-result pruning, span selection, checkpoint framing, persistence, and
  replay are all **inherited unchanged**.
- `jev-adapt.js` maps the span's derived DSH messages onto the library
  transcript, runs `compact()` against the TypeSafe System One API, and
  renders the pruned transcript as the checkpoint text (no LLM stream call).
- **Fail-safe:** missing key, Jev failure, malformed answer, unfittable state,
  a span below `minSpanMessages`, or a reduction below `minReductionRatio`
  falls back to the inherited LLM summary. Cancellation propagates, never
  falls back. Every Jev request carries its own timeout composed with the
  compaction's cancellation signal, and concurrent requests are capped, so a
  stalled connection cannot hang a compaction.

The bundle's `cordis.patch.yml` overrides the `preset-standard`,
`preset-cordis` and `preset-ptc` agent presets with pinned copies of the
shipped lists from `@deepseek-ai/dsh-web-app` `presets/*.patch.yml`, each with
exactly one change: inside the `compaction` group, `compaction-basic` →
`compaction-fast-jev`. `minimal` ships no compaction rows, so there is nothing
to swap there. Safe Mode (`build/dsh-desktop-safe.patch.yml`) intentionally
does not mount this plugin and keeps the stock backend.

## Desktop wiring

Mounted like every host plugin (see `docs/patch-plugin-contract.md`):

1. `file:packages/dsh-desktop-compaction-fast-jev` dependency in the root
   `package.json`.
2. Dependency injection into the `@deepseek-ai/dsh` closure patch
   (`patches/@deepseek-ai+dsh+*.patch`) so the profile projection mirrors it
   into `$DSH_HOME/profiles/node_modules` — enforced by
   `test/desktop-plugin-closure.test.ts`.
3. No `- insert:` row: the preset rows swapped in by `cordis.patch.yml` are
   the only mount, exactly like the standalone bundle integration. Desktop
   composes the bundle patch as an extra launcher `--patch` layer
   (`hostBundlePatchOverlayPaths`), because bundle patches otherwise apply
   only to `dsh.profile.bundles` entries.
4. Peer dependencies (`@deepseek-ai/cordis`, `dsh-compaction-basic`,
   `schemastery`) resolve to the installation's copies through the
   `@deepseek-ai/*` host fallback; they must stay declared so the linked
   package's imports are intercepted to the runtime.
5. Plugins → Desktop plugins tab shows a "Fast Jev compaction" on/off card
   (`dsh-desktop-market-installer` client, generic host-plugin state
   channels). Off drops the overlay patch layer at next Harness start, so
   the presets fall back to the built-in summarizer; on restores the swap.

## API key

Resolved in order: row config `jev.apiKey` → `TYPESAFE_API_KEY` in the dsh
process environment → key file (`jev.apiKeyFile`, default `~/.typesafe_key`,
mode 600 on POSIX). Without any of them the backend logs one warning per
compaction and uses the built-in LLM summary — the plugin is inert-but-safe
until a key exists. Note that GUI-launched apps on macOS do not inherit shell
environment variables; the key file is the reliable channel there.

## Tunables (row `config.jev`, all optional)

| Key | Default | Meaning |
|---|---|---|
| `apiKey` / `apiKeyFile` / `baseUrl` | — / `~/.typesafe_key` / api.typesafe.ai | key and endpoint |
| `model` | `jev-latest` | TypeSafe model |
| `keepThreshold` | `0.5` | minimum keep probability |
| `preserveRecentMessages` | `6` | newest span messages never touched |
| `maxStateTokens` / `maxRequestTokens` | `25000` / `30000` | Jev request budgets — the preset rows pin `27000` / `32000` (measured endpoint ceiling ~32k) |
| `truncateHeadChars` | `300` | head kept of a dropped result |
| `requestTimeoutSeconds` | `120` | per-request timeout; expiry falls back to the LLM summary |
| `maxConcurrentRequests` | `4` | ceiling on simultaneous Jev requests |
| `minReductionRatio` | `0.25` | below this, fall back to the LLM summary |
| `minSpanMessages` | `4` | smaller spans fall back |
| `goal` | last user prompts | task description sent with the state |

Spans whose state floor exceeds the Jev request ceiling are split at
tool-call boundaries (never orphaning a result from its call), scored chunk by
chunk, and merged into one checkpoint; any chunk failure falls back for the
whole compaction, never a partial prune.

## Tests

- `node test/smoke.mjs` — offline adapter/library behavior with a fake asker
  (no network, no dsh packages). Also run by the repo suite through
  `test/compaction-fast-jev.test.mjs`.
- `test/compaction-fast-jev-presets.test.ts` (repo root, vitest) — override
  structure and the swap-only drift diff against the installed
  `@deepseek-ai/dsh-web-app` presets.
- `python3 scripts/check-drift.py [PRESETS_SOURCE]` — same drift check
  standalone; defaults to the repo's `node_modules` copy, accepts a
  deepseek-harness checkout root. Kill-checked: a simulated upstream key
  addition flips PASS → DRIFT, exit 1.

## Re-syncing after a harness upgrade

A Loader override replaces the preset's **complete** config, so after any
upgrade of the `@deepseek-ai/*` packages that changes the shipped
`standard`/`cordis`/`ptc` presets:

1. `npm ci` (installs the new `dsh-web-app`), then
   `python3 scripts/regenerate-presets.py` — regenerates `cordis.patch.yml`
   from the installed presets with the one-row swap applied mechanically.
2. `python3 scripts/check-drift.py` — must report PASS for all three presets.
3. `npm test -- test/compaction-fast-jev-presets.test.ts` — repo-level guard.
4. Verify the runtime contract still holds (imports, `BasicCompactionEngine`
   superclass identity with the `summarize()` hook, `Config` accepting the row
   config) against the new version before release.

## Provenance

- `vendor/fast-jev/*.js` + `LICENSE`: the seven runtime dist files of
  `fast-jev-compaction` v0.2.0 @ `e3f262a` (MIT), byte-identical to the copy
  validated in the standalone `dsh-compaction-fast-jev` bundle; `.d.ts`/`.map`
  omitted.
- `index.js` / `jev-adapt.js` / `test/smoke.mjs`: ported unchanged from that
  bundle (only machine-path references in comments updated).
- Pinned preset lists: generated from `@deepseek-ai/dsh-web-app@0.2.0-rc.2`
  (the version this repo's lockfile installs) via
  `scripts/regenerate-presets.py`.

