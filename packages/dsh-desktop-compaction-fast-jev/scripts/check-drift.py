#!/usr/bin/env python3
"""Preset-override drift check for dsh-desktop-compaction-fast-jev.

Usage:
    python3 scripts/check-drift.py [PRESETS_SOURCE]

Default PRESETS_SOURCE: <repo>/node_modules/@deepseek-ai/dsh-web-app/presets
(the exact copy the installed Desktop ships). A deepseek-harness checkout root
also works; its packages/bundle/web-app/presets is appended automatically.

A Loader override replaces a preset's COMPLETE config, so cordis.patch.yml
pins copies of the shipped preset plugin lists. After any harness upgrade,
this script deep-diffs each pinned block against the shipped file it was
generated from. PASS = the only differences are the known
compaction-basic -> compaction-fast-jev row swap (3 paths: id, name, added
config). DRIFT = the shipped preset changed; regenerate with
scripts/regenerate-presets.py before trusting the override.

Requires: python3 with PyYAML.
"""
import json
import os
import sys

import yaml

PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(os.path.dirname(PKG))
DEFAULT_PRESETS = os.path.join(REPO, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets')
# override row id -> shipped presets/<name>.patch.yml
PRESETS = {
    'preset-standard': 'standard',
    'preset-cordis': 'cordis',
    'preset-ptc': 'ptc',
}
ROW_NAME = 'dsh-desktop-compaction-fast-jev'


class Loader(yaml.SafeLoader):
    pass


Loader.add_constructor('tag:yaml.org,2002:js', lambda l, s: {'__jsExpr': l.construct_scalar(s)})


def resolve_presets_dir(arg):
    if arg is None:
        return DEFAULT_PRESETS
    candidate = os.path.abspath(arg)
    nested = os.path.join(candidate, 'packages', 'bundle', 'web-app', 'presets')
    return nested if os.path.isdir(nested) else candidate


def diff(a, b, path=''):
    out = []
    if type(a) is not type(b):
        return [f'{path}: type {type(a).__name__} vs {type(b).__name__}']
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b), key=str):
            if k not in a or k not in b:
                out.append(f'{path}.{k}: presence differs')
            else:
                out += diff(a[k], b[k], f'{path}.{k}')
    elif isinstance(a, list):
        if len(a) != len(b):
            return [f'{path}: length {len(a)} vs {len(b)}']
        for i, (x, y) in enumerate(zip(a, b)):
            out += diff(x, y, f'{path}[{i}]')
    elif a != b:
        out.append(f'{path}: {a!r} vs {b!r}')
    return out


def is_swap_only(diffs):
    """Exactly the 3 known paths of the compaction row swap, same row prefix."""
    if len(diffs) != 3:
        return False
    suffixes = sorted(d.split(': ')[0].rsplit('.', 1)[-1] for d in diffs)
    prefixes = {d.split('.config[0].')[0] for d in diffs if '.config[0].' in d}
    return suffixes == ['config', 'id', 'name'] and len(prefixes) == 1 \
        and any('compaction-fast-jev' in d for d in diffs) \
        and any('dsh-compaction-basic' in d for d in diffs) \
        and any(ROW_NAME in d for d in diffs)


def main():
    presets_dir = resolve_presets_dir(sys.argv[1] if len(sys.argv) > 1 else None)
    if not os.path.isdir(presets_dir):
        print(f'FAIL: presets directory not found: {presets_dir} (run npm ci, or pass a source)')
        return 1
    manifest = os.path.join(presets_dir, os.pardir, 'package.json')
    try:
        with open(manifest, encoding='utf-8') as handle:
            data = json.load(handle)
        print(f'checking against {data["name"]}@{data["version"]} ({presets_dir})')
    except (OSError, KeyError, ValueError):
        print(f'checking against {presets_dir}')
    patch_path = os.path.join(PKG, 'cordis.patch.yml')
    rows = yaml.load(open(patch_path, encoding='utf-8'), Loader=Loader)
    if not isinstance(rows, list):
        print(f'FAIL: {patch_path} is not a top-level list')
        return 1
    failed = False
    seen = set()
    for row in rows:
        rid = row.get('id')
        shipped = PRESETS.get(rid)
        if shipped is None:
            print(f'FAIL: unknown override row {rid!r} (extend PRESETS if intentional)')
            failed = True
            continue
        seen.add(rid)
        shipped_path = os.path.join(presets_dir, f'{shipped}.patch.yml')
        try:
            ship = yaml.load(open(shipped_path, encoding='utf-8'), Loader=Loader)[0]['insert'][0]['config']
        except (OSError, KeyError, IndexError, TypeError) as error:
            print(f'FAIL: cannot read shipped preset {shipped_path}: {error}')
            failed = True
            continue
        mine = row.get('config')
        if mine is None or mine.get('id') != ship.get('id'):
            print(f'DRIFT {rid}: preset id mismatch or missing config')
            failed = True
            continue
        d = diff(mine, ship)
        if is_swap_only(d):
            print(f'PASS {rid}: differs from shipped only by the compaction row swap')
        else:
            print(f'DRIFT {rid}: {len(d)} unexpected difference(s) vs {shipped_path}')
            for x in d[:12]:
                print(f'    {x[:160]}')
            failed = True
    for rid in PRESETS:
        if rid not in seen:
            print(f'FAIL: override for {rid} missing from {patch_path}')
            failed = True
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
