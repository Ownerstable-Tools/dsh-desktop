#!/usr/bin/env python3
"""Regenerate cordis.patch.yml from the shipped dsh-web-app agent presets.

Usage:
    python3 scripts/regenerate-presets.py [PRESETS_DIR]

Default PRESETS_DIR: <repo>/node_modules/@deepseek-ai/dsh-web-app/presets
(the exact copy the installed Desktop ships). A deepseek-harness checkout root
also works; its packages/bundle/web-app/presets is appended automatically.

A Loader override replaces a preset's COMPLETE config, so cordis.patch.yml
pins copies of the shipped `standard`, `cordis` and `ptc` preset plugin lists,
each with exactly one change: inside the `compaction` group the
`compaction-basic` row becomes `compaction-fast-jev`. This script performs the
prescribed mechanical transformation (take each shipped file from its
`- id: preset-<id>` line through EOF, remove exactly four leading spaces from
every non-blank line, apply the one-row swap) so the pinned copies can be
re-based on a new harness version without hand-editing ~500 YAML lines.

After regenerating, run scripts/check-drift.py to validate.
"""
import json
import os
import re
import sys

PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(os.path.dirname(PKG))
DEFAULT_PRESETS = os.path.join(REPO, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets')
# The swapped row's `name` must match this package's installed name, so read it
# from the manifest: the same script then serves the in-repo host plugin and
# any standalone bundle copy of it.
with open(os.path.join(PKG, 'package.json'), encoding='utf-8') as _manifest:
    PACKAGE_NAME = json.load(_manifest)['name']
# override row id -> shipped presets/<name>.patch.yml (`minimal` ships no
# compaction rows, so there is nothing to swap there)
PRESETS = [
    ('preset-standard', 'standard'),
    ('preset-cordis', 'cordis'),
    ('preset-ptc', 'ptc'),
]

# Indentation below is post-dedent: group rows sit at 10 spaces, fields at 12.
OLD_ROW = (
    "          - id: compaction-basic\n"
    "            name: '@deepseek-ai/dsh-compaction-basic'\n"
)
NEW_ROW = (
    "          - id: compaction-fast-jev\n"
    f"            name: '{PACKAGE_NAME}'\n"
    "            config:\n"
    "              jev:\n"
    "                preserveRecentMessages: 6\n"
    "                maxStateTokens: 27000\n"
    "                maxRequestTokens: 32000\n"
)


def resolve_presets_dir(arg):
    if arg is None:
        return DEFAULT_PRESETS
    candidate = os.path.abspath(arg)
    nested = os.path.join(candidate, 'packages', 'bundle', 'web-app', 'presets')
    return nested if os.path.isdir(nested) else candidate


def baseline_label(presets_dir):
    """Best-effort `<name>@<version>` of the dsh-web-app the copies came from."""
    manifest = os.path.join(presets_dir, os.pardir, 'package.json')
    try:
        with open(manifest, encoding='utf-8') as handle:
            data = json.load(handle)
        return f"{data['name']}@{data['version']}"
    except (OSError, KeyError, ValueError):
        return presets_dir


def override_block(presets_dir, row_id, shipped):
    path = os.path.join(presets_dir, f'{shipped}.patch.yml')
    with open(path, encoding='utf-8') as handle:
        lines = handle.read().splitlines(keepends=True)
    start = next(
        (i for i, line in enumerate(lines) if line.rstrip('\n') == f'    - id: {row_id}'),
        None,
    )
    if start is None:
        raise SystemExit(f'FAIL: {path}: no `    - id: {row_id}` line')
    dedented = []
    for line in lines[start:]:
        if line.strip() == '':
            dedented.append(line if line.endswith('\n') else line + '\n')
            continue
        if not line.startswith('    '):
            raise SystemExit(f'FAIL: {path}: line is not 4-space indented: {line!r}')
        dedented.append(line[4:])
    block = ''.join(dedented)
    if block.count(OLD_ROW) != 1:
        raise SystemExit(
            f'FAIL: {path}: expected exactly one compaction-basic row, '
            f'found {block.count(OLD_ROW)} — the shipped preset changed shape; '
            'inspect it before regenerating'
        )
    return block.replace(OLD_ROW, NEW_ROW)


def main():
    presets_dir = resolve_presets_dir(sys.argv[1] if len(sys.argv) > 1 else None)
    if not os.path.isdir(presets_dir):
        raise SystemExit(f'FAIL: presets directory not found: {presets_dir}')
    header = (
        '# Overrides the shipped `preset-standard`, `preset-cordis` and `preset-ptc`\n'
        '# agent presets (from @deepseek-ai/dsh-web-app presets/*.patch.yml) with exactly\n'
        '# one change each: inside the `compaction` group, the `compaction-basic` backend\n'
        '# row is replaced by `compaction-fast-jev`, the Jev-pruned verbatim backend from\n'
        '# this package. command-compact and tool-result-pruner, the group\'s isolate map,\n'
        '# and every other preset row are restated verbatim.\n'
        '#\n'
        '# A Loader override replaces the preset\'s complete config, so these pinned\n'
        '# copies must be regenerated after any harness upgrade that changes the shipped\n'
        f'# presets: `python3 scripts/regenerate-presets.py` (baseline of this copy:\n'
        f'# {baseline_label(presets_dir)}), then `python3 scripts/check-drift.py`.\n'
        '# Any future host change to these presets must be folded into this file —\n'
        '# two bundles cannot each pin a competing complete override of one preset.\n'
    )
    blocks = [override_block(presets_dir, row_id, shipped) for row_id, shipped in PRESETS]
    out_path = os.path.join(PKG, 'cordis.patch.yml')
    with open(out_path, 'w', encoding='utf-8') as handle:
        handle.write(header + ''.join(blocks))
    print(f'wrote {out_path} from {presets_dir}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
