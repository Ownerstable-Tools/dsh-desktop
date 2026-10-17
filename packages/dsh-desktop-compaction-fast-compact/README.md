# dsh-desktop-compaction-fast-compact

fast-compact compaction backend for DSH Desktop, ported from the Claude Code
plugin [fast-compact](https://github.com/NodarDavituri/fast-compact). It
replaces `dsh-desktop-compaction-fast-jev`. Desktop mounts it as a host plugin
(toggle: **Plugins → Desktop plugins → Fast compaction**); the toolbox keeps a
standalone bundle copy, `dsh-compaction-fast-compact`, for other dsh homes.

Instead of an LLM-written summary, a compaction keeps the selected span
**verbatim and in order**, except that:

- old tool outputs longer than about 2,000 characters are cut to their first
  1,000 and last 500 characters;
- long old tool inputs (Bash scripts, file bodies, edit strings) are cut the
  same way;
- old host notices keep their first 300 characters.

The newest `keepRecentCalls` (10) tool calls and every word a person or the
assistant wrote stay as they are. No tool call is removed. Every cut is saved
to a file before anything is cut, and its marker names that file:

```
[fast-compact: cut 5707 chars from the middle of this output; the full text is in ~/.dsh/fast-compact/<session>/output-<id>.txt — read it before relying on what was cut]
```

When a Jev key is set, Jev ranks the old outputs and the ones it rates as still
needed stay whole, up to a quarter of the old output. Without a key, or when
Jev fails, the newest old outputs stay whole instead. Jev never decides
whether the compaction happens.

`index.js` subclasses the shipped `BasicCompactionEngine` and overrides only
`summarize()`; pressure triggers, `/compact`, locking, pruning, persistence
and replay are inherited. The built-in LLM summary runs only when the cut
cannot help: a span under `minSpanMessages`, nothing old and long enough to
cut, a cut freeing less than `minFreedRatio` (20%), an archive write failure,
or the host size preflight (`input.canAcceptSummary`, supplied by this fork's
`@deepseek-ai/dsh-compaction-basic` patch) missing or refusing the checkpoint.
Cancellation propagates.

## Preset pin baseline

`cordis.patch.yml` overrides `preset-standard`, `preset-cordis` and
`preset-ptc` with **pinned complete copies** of the shipped preset lists, each
with one change: `compaction-basic` → `compaction-fast-compact`. The copy here
matches `@deepseek-ai/dsh-web-app@0.2.0-rc.2`, the version in this fork's
lockfile. After a Harness upgrade:

```sh
python3 scripts/regenerate-presets.py
python3 scripts/check-drift.py     # must PASS x3
```

Both default to `node_modules/@deepseek-ai/dsh-web-app/presets` of this
repository. `test/compaction-fast-compact-presets.test.ts` runs the same check
under `npm test`.

## Jev key (optional)

The pinned rows set `provider: typesafe`, so the team's TypeSafe key keeps
working. Resolved in order: row config `fastCompact.apiKey` → the provider's
environment variable (`TYPESAFE_API_KEY`, or `OPENROUTER_API_KEY` for
`openrouter`) in the dsh process → key file (`fastCompact.apiKeyFile`, default
`~/.typesafe_key` or `~/.openrouter_key`, mode 600). GUI-launched apps do not
inherit shell environment; the key file is the reliable channel.

Without a key, or with `provider: none`, nothing leaves the machine and the
newest old outputs stay whole. TypeSafe's web firewall refuses some requests
with an HTML 403; fast-compact reports that and keeps the newest outputs whole.
`provider: openrouter` avoids it.

**What is sent to Jev:** your and the assistant's messages (long ones
shortened), tool inputs (shortened), a one-line note per tool output and, with
`sendSamples`, the first 200 and last 100 characters of each output Jev ranks.
Credential-shaped strings are masked before sending, by pattern; treat that as
a safety net, not a guarantee.

## Archive

Cuts are saved under `<DSH_HOME>/fast-compact/<session id>/`
(`fastCompact.archiveDir` overrides the root), one file per cut, created
private. When the checkpoint would exceed `maxCheckpointChars`, the oldest
messages are left out of it and the whole cut span is saved beside the cuts as
`span-<time>.txt`; the checkpoint names that file. The agent needs a file-read
or shell tool that can reach the archive folder to read cuts back. Nothing is
deleted automatically; to clear sessions older than a month:

```sh
find ~/.dsh/fast-compact -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -r {} +
```

## Tunables (row `config.fastCompact`, all optional)

| Key | Default | Meaning |
|---|---|---|
| `provider` | `openrouter` (rows pin `typesafe`) | `openrouter`, `typesafe`, or `none`; any other value counts as `none` |
| `apiKey` / `apiKeyFile` / `baseUrl` | — / by provider / the provider's | key and endpoint |
| `model` | `jev-latest` | Jev model |
| `archiveDir` | `<DSH_HOME or ~/.dsh>/fast-compact` | where cuts are saved |
| `keepRecentCalls` | `10` | newest tool calls never cut |
| `cutTo` | `1500` | characters a cut keeps: two thirds start, one third end |
| `keepWhole` | `0.25` | largest share of old output Jev may keep whole |
| `minKeepScore` | `0.45` | Jev's lowest score for keeping an output whole |
| `cutInputs` | `true` | also cut long old tool inputs |
| `sendSamples` | `true` | show Jev the start and end of each output it ranks |
| `maxStateTokens` / `maxRequestTokens` | `25000` / `60000` | Jev budgets |
| `requestTimeoutSeconds` | `20` | per-request timeout; expiry ranks newest first |
| `maxConcurrentRequests` | `4` | simultaneous Jev requests |
| `minFreedRatio` | `0.2` | below this share freed, the built-in summary runs |
| `minSpanMessages` | `4` | smaller spans use the built-in summary |
| `maxCheckpointChars` | `48000` | ceiling on checkpoint text (the chat UI blanks on six-figure payloads) |
| `focus` | — | what to keep, sent to Jev beside the goal |

## Tests

- `node test/smoke.mjs` — offline adapter/library behavior, fake transport
  (also run by `test/compaction-fast-compact.test.mjs`).
- `test/fast-compact-checkpoint-size.test.mjs` — the engine with the host size
  preflight.
- `python3 scripts/check-drift.py` — pin vs shipped presets.

## Provenance and refresh

- `vendor/fast-compact/*.js` + `LICENSE`: `src/*.ts` of `fast-compact`
  v0.3.0 @ `ea84e37` (MIT), transpiled one file at a time with
  `bun build --no-bundle --target=node`; comments and types are dropped,
  logic is unchanged. To refresh from the toolbox's `fast-compact` submodule:

  ```sh
  for f in compact jev redact state text types; do
    bun build --no-bundle --target=node ../fast-compact/src/$f.ts > vendor/fast-compact/$f.js
  done
  cp ../fast-compact/LICENSE vendor/fast-compact/LICENSE
  node test/smoke.mjs
  ```

- The toolbox's `dsh-compaction-fast-compact/` carries the same `adapt.js` and
  vendored files (its `index.js` makes the size preflight optional); refresh
  both together.
