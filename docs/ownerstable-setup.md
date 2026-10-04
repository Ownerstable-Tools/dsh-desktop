# OwnersTable DSH Desktop with Fast Jev

This fork includes `packages/dsh-desktop-compaction-fast-jev` and the desktop
wiring that activates its preset overrides. No separate Harness checkout,
private toolbox patch, or standalone Jev plugin installation is required.
The desktop still uses Harness packages installed by npm.

## Versions shipped together

- Harness packages: `0.2.0-rc.2`, pinned in `package-lock.json`.
- Desktop adapter: `dsh-desktop-compaction-fast-jev` `0.1.0`.
- Vendored Fast Jev library: `0.2.0`, upstream commit `e3f262a` (MIT license
  retained under the adapter's `vendor/fast-jev/`).
- Standard, Cordis and PTC preset overrides match this Harness version.

The separate [fast-jev-compaction fork](https://github.com/OwnersTable-Tools/fast-jev-compaction)
is for Claude Code. Do not install the standalone DSH adapter alongside this
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

## Configure Jev

Supply a TypeSafe API key through `TYPESAFE_API_KEY` in the Harness process
environment or through the adapter's `jev.apiKey` configuration. For a GUI
launch, the adapter also reads `~/.typesafe_key`; put only the key in this
machine-local file and restrict its permissions with `chmod 600 ~/.typesafe_key`.
Never commit credentials. The Claude plugin has its own key configuration;
it does not automatically read this desktop key file.

In **Plugins → Desktop plugins**, enable **Fast Jev compaction** and restart
Harness if prompted. Use a Standard, Cordis or PTC agent; the Minimal preset
has no compaction backend. Safe Mode keeps the stock backend.

On a sufficiently long session, run `/compact`. A log entry
`fast-jev-compaction: scoring` followed by `kept N/M messages, no summary`
indicates the Jev path ran. A `fallback to built-in summary` entry means stock
compaction was used, for example because the key was missing, Jev failed, or
the reduction was too small. Merely seeing the plugin listed does not prove
an API call succeeded. Jev sends conversation-derived state and tool metadata
to TypeSafe; usage is billed separately by TypeSafe.

The adapter retains selected text verbatim but can drop or truncate tool
content. Oversized checkpoints fall back to the stock summary. It is not lossless retention of history.

## Maintain and verify

```sh
python3 packages/dsh-desktop-compaction-fast-jev/scripts/check-drift.py
npm test
npm run typecheck
npm run build
```

After changing Harness versions, regenerate the preset overrides with
`python3 packages/dsh-desktop-compaction-fast-jev/scripts/regenerate-presets.py`
and repeat the drift check. Test loading, compaction and the plugin's off
switch in a disposable profile before publishing. Keep the adapter, runtime
pin and lockfile together. Update the toolbox's desktop pin only after the
chosen commit is available in this fork.

See [adapter details](../packages/dsh-desktop-compaction-fast-jev/README.md)
for fallback rules, limits and maintenance tests.
