# OwnersTable DSH Desktop with fast-compact

This fork includes `packages/dsh-desktop-compaction-fast-compact` and the desktop
wiring that activates its preset overrides. No separate Harness checkout,
private toolbox patch, or standalone compaction plugin installation is required.
The desktop still uses Harness packages installed by npm.

## Versions shipped together

- Harness packages: `0.2.0-rc.2`, pinned in `package-lock.json`.
- Desktop adapter: `dsh-desktop-compaction-fast-compact` `0.2.0`. It replaces
  `dsh-desktop-compaction-fast-jev`.
- Vendored fast-compact library: `0.3.0`, upstream commit `ea84e37` (MIT
  license retained under the adapter's `vendor/fast-compact/`).
- Standard, Cordis and PTC preset overrides match this Harness version.

The separate [fast-compact](https://github.com/NodarDavituri/fast-compact)
plugin is for Claude Code. Do not install the standalone DSH adapter alongside this
bundled adapter: both would override the same presets.

## Build on your machine

Use Node.js 22.12 or later and npm. Clone this fork, or use the desktop submodule
at the commit pinned by `developer-toolbox`:

```sh
git clone https://github.com/OwnersTable-Tools/dsh-desktop.git
cd dsh-desktop
npm ci
npm run package:dev:mac:arm64
```

On an Intel Mac use `npm run package:dev:mac:x64`. On Windows x64 use
`npm run package:dev:win` on Windows. Build on the target OS and architecture.
`developer-toolbox` offers the same process through `make dsh` on macOS.

These development packages are named **DSH Desktop Dev**, use a separate
profile, and write artifacts to `dist-dev/`. They do not migrate the existing
DSH Desktop profile. Local builds are not official signed/notarized releases;
signing depends on your build credentials. Follow the repository's release
runbook for a distributable release. Do not install an upstream download and
expect it to contain the OwnersTable plugin.

## Turn it on and verify

In **Plugins → Desktop plugins**, enable **Fast compaction** and restart
Harness if prompted. Use a Standard, Cordis or PTC agent; the Minimal preset
has no compaction backend. Safe Mode keeps the stock backend. If you had
**Fast Jev compaction** turned off, the new toggle starts on.

A compaction keeps the selected span verbatim, except that old tool outputs,
long old tool inputs and old host notices are cut to their start and end. The
newest 10 tool calls and everything you or the agent wrote stay as they are.
Every cut's full text is saved under `fast-compact/<session>/` in the Harness
home (`DSH_HOME`) before
anything is cut, and the cut's marker names that file, so the agent can read
it back. Nothing there is deleted automatically.

On a sufficiently long session, run `/compact`. The log shows
`fast-compact: cutting N span message(s)…` followed by
`fast-compact: <before> → <after> chars (−N%)`, the number of cuts, and whether
Jev ranked the outputs. A `fast-compact: fallback to built-in summary (…)`
entry means stock compaction was used and says why: for example the span was
too small, nothing was old and long enough to cut, the cut would free less
than a fifth, or the checkpoint did not pass the host's size check.

## Jev (optional)

Without a key the adapter still cuts, keeping the newest old outputs whole,
and sends nothing anywhere. With a TypeSafe key, Jev picks which old outputs
stay whole. Supply it through `TYPESAFE_API_KEY` in the Harness process
environment or the adapter's `fastCompact.apiKey` configuration. For a GUI
launch, the adapter also reads `~/.typesafe_key`; put only the key in this
machine-local file and restrict its permissions with `chmod 600 ~/.typesafe_key`.
Never commit credentials. The Claude plugin has its own key configuration;
it does not automatically read this desktop key file.

Jev receives conversation-derived state: messages (long ones shortened), tool
inputs (shortened), a note per tool output and the start and end of each
output it ranks, with credential-shaped strings masked by pattern. Usage is
billed separately by TypeSafe. A Jev failure never fails the compaction.

## Maintain and verify

```sh
python3 packages/dsh-desktop-compaction-fast-compact/scripts/check-drift.py
npm test
npm run typecheck
npm run build
```

After changing Harness versions, regenerate the preset overrides with
`python3 packages/dsh-desktop-compaction-fast-compact/scripts/regenerate-presets.py`
and repeat the drift check. Test loading, compaction and the plugin's off
switch in a disposable profile before publishing. Keep the adapter, runtime
pin and lockfile together. Update the toolbox's desktop pin only after the
chosen commit is available in this fork.

See [adapter details](../packages/dsh-desktop-compaction-fast-compact/README.md)
for fallback rules, limits and maintenance tests.
