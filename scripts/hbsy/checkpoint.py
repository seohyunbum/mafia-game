#!/usr/bin/env python3
"""Publish a signed registry to its own approved repository, without checkout changes."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

try:
    from . import hbsy
except ImportError:
    import hbsy

OWNER = 'seohyunbum'
BRANCH = 'hbsy-provenance'
EXPECTED_KEY_ID = '363071bd27767a1f5e3c916c3f385480e199ae25ebc867cdc8a5a2c624d0a061'
SCOPES = {
    'YUNU_GAME': ('dist/',), 'blaster': ('dist/',), 'wave-arena': ('_site/',),
    'last_squard': ('dist/',), 'mafia-game': ('dist/',), 'brick-city-defense': ('_site/',),
    'family-ai-studio': ('dist/',), 'AX_team': ('.next/',),
    'asset-python-workspace': ('charts/',),
    'war_3D': ('app/', 'game/', 'data/', 'hbsy-', 'live/', 'snapshot/'),
}


def git(root: Path, *args: str, data=None, env=None, check=True):
    # Ambient Git variables must not redirect -C, the index, object database or config.
    environment = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    if env:
        environment.update(env)
    environment.update(GIT_NO_REPLACE_OBJECTS='1', GIT_NO_LAZY_FETCH='1')
    proc = subprocess.run(['git', '-C', str(root), *args], input=data,
                          capture_output=True, timeout=120, env=environment)
    if check and proc.returncode:
        raise hbsy.HBSYError(f'Git checkpoint {args[0]} failed (exit {proc.returncode})')
    return proc


def check_destination(root: Path, project: str) -> str:
    if project not in SCOPES:
        raise hbsy.HBSYError('Project is not approved for registry publishing')
    url = git(root, 'remote', 'get-url', 'origin').stdout.decode().strip()
    expected = f'{OWNER}/{project}'
    candidates = {f'https://github.com/{expected}', f'https://github.com/{expected}.git',
                  f'git@github.com:{expected}.git', f'ssh://git@github.com/{expected}.git'}
    push_urls = git(root, 'remote', 'get-url', '--push', '--all', 'origin').stdout.decode().splitlines()
    if url not in candidates or len(push_urls) != 1 or push_urls[0] not in candidates:
        raise hbsy.HBSYError('Origin is not the approved repository for this project')
    # Use the validated effective URL, rather than a separately resolved remote name.
    return push_urls[0]


def checked_object(root: Path, oid: str, kind: str) -> bytes:
    if not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', oid):
        raise hbsy.HBSYError('Invalid Git object identifier')
    data = git(root, 'cat-file', kind, oid).stdout
    digest = hashlib.sha1 if len(oid) == 40 else hashlib.sha256
    if digest(f'{kind} {len(data)}\0'.encode()+data).hexdigest() != oid:
        raise hbsy.HBSYError('Git object digest mismatch')
    return data


def parse_rows(data: bytes, pk, project: str) -> list[dict]:
    if len(data) > 64*1024*1024:
        raise hbsy.HBSYError('Registry is too large')
    rows = []
    seen = set()
    for line in data.decode('utf-8').splitlines():
        if not line.strip():
            continue
        row = hbsy._decode_record(line)
        record = row.get('record', {})
        profile = row.get('profile')
        hbsy._validate_record(record, record.get('kind'), profile)
        path = hbsy._safe_relative(row.get('path', ''))
        if not any(path.startswith(prefix) for prefix in SCOPES[project]):
            raise hbsy.HBSYError('Registry path is outside this project distribution scope')
        if record.get('kind') == 'manifest':
            hbsy._validate_file_list(record)
        if row != hbsy._index_entry(record, path):
            raise hbsy.HBSYError('Registry envelope mismatch')
        if profile == 'public' and not hbsy._valid_signature(pk, record):
            raise hbsy.HBSYError('Registry signature does not match pinned public key')
        encoded = hbsy.canonical(row)
        if encoded not in seen:
            rows.append(row)
            seen.add(encoded)
    if not rows:
        raise hbsy.HBSYError('Empty registry')
    return rows


def remote_rows(root: Path, parent: str, relative: str, pk, project: str) -> list[dict]:
    commit = checked_object(root, parent, 'commit')
    tree_oid = commit.split(b'\n', 1)[0].removeprefix(b'tree ').decode('ascii')
    parts = relative.split('/')
    for number, part in enumerate(parts):
        tree = checked_object(root, tree_oid, 'tree')
        offset = 0
        found = []
        width = len(parent)//2
        while offset < len(tree):
            end = tree.index(b'\0', offset)
            mode, name = tree[offset:end].split(b' ', 1)
            oid = tree[end+1:end+1+width].hex()
            if name == part.encode('utf-8'):
                found.append((mode, oid))
            offset = end+1+width
        if len(found) != 1:
            raise hbsy.HBSYError('Remote registry tree is missing or ambiguous')
        mode, tree_oid = found[0]
        final = number == len(parts)-1
        if mode not in ({b'100644', b'100755'} if final else {b'40000'}):
            raise hbsy.HBSYError('Remote registry path is not a regular file')
    return parse_rows(checked_object(root, tree_oid, 'blob'), pk, project)


def publish(root: Path, index: Path, pubkey: Path, project: str, *, expected_key_id: str = EXPECTED_KEY_ID) -> dict:
    hbsy._no_links(root)
    root = root.resolve()
    actual = Path(git(root, 'rev-parse', '--show-toplevel').stdout.decode().strip()).resolve()
    if actual != root:
        raise hbsy.HBSYError('Checkpoint root must be the repository root')
    destination = check_destination(root, project)
    index = index if index.is_absolute() else root/index
    pubkey = pubkey if pubkey.is_absolute() else root/pubkey
    hbsy._no_links(index)
    hbsy._no_links(pubkey)
    index, pubkey = index.resolve(), pubkey.resolve()
    relative = index.relative_to(root).as_posix()
    if relative != 'provenance/index.jsonl' or not pubkey.is_relative_to(root):
        raise hbsy.HBSYError('Only this repository provenance/index.jsonl may be published')
    pk = hbsy.load_public(pubkey.read_text(encoding='utf-8').strip())
    if hbsy.key_id(pk) != expected_key_id:
        raise hbsy.HBSYError('Public key does not match approved signing identity')
    rows = parse_rows(index.read_bytes(), pk, project)
    if not any(row['profile'] == 'public' for row in rows):
        raise hbsy.HBSYError('Current registry has no owner signature')
    # Only files actually present and verified now belong to this checkpoint.
    # Missing historical paths remain in the append-only ledger, not current_records.
    latest_rows = {row['path']: row for row in rows}
    current_records = {}
    cache = hbsy.load_index_cache(index)
    for relative_path, row in latest_rows.items():
        artifact = root / relative_path
        hbsy._no_links(artifact)
        if not artifact.is_file():
            continue
        if row['profile'] != 'public':
            raise hbsy.HBSYError('Current artifact has no owner signature')
        verified = hbsy.verify_document(artifact, 'public', index, pk=pk, root=root, index_cache=cache)
        digest = hbsy.sha(hbsy.canonical(row['record']))
        if not verified['ok'] or verified.get('record_sha256') != digest:
            raise hbsy.HBSYError('Current artifact does not match its latest registry record')
        current_records[relative_path] = {
            'record_sha256': digest, 'hash': row['record']['hash'],
            'kind': row['record']['kind'], 'profile': row['profile'],
        }
    if not current_records:
        raise hbsy.HBSYError('No current artifacts were verified for this checkpoint')
    source = git(root, 'rev-parse', 'HEAD').stdout.decode().strip()
    ref = 'refs/heads/'+BRANCH
    for attempt in range(3):
        observed = git(root, 'ls-remote', '--exit-code', 'origin', ref, check=False)
        if observed.returncode not in (0, 2):
            raise hbsy.HBSYError('Cannot read remote checkpoint reference')
        parent = observed.stdout.decode().split()[0] if observed.returncode == 0 else None
        prior = []
        if parent:
            git(root, 'fetch', '--no-tags', '--no-write-fetch-head', 'origin', parent)
            prior = remote_rows(root, parent, relative, pk, project)
        known = {hbsy.canonical(row) for row in prior}
        merged = list(prior)
        for row in rows:
            if hbsy.canonical(row) not in known:
                merged.append(row)
                known.add(hbsy.canonical(row))
        payloads = {relative: b''.join(hbsy.canonical(row)+b'\n' for row in merged),
                    'hbsy.pubkey': pubkey.read_bytes().strip()+b'\n'}
        receipt = {'version': 1, 'project': project, 'source_commit': source,
                   'registered_at': datetime.now(timezone.utc).isoformat(),
                   'index': relative, 'index_sha256': hbsy.sha(payloads[relative]),
                   'current_records': current_records,
                   'github_run_id': os.environ.get('GITHUB_RUN_ID'),
                   'key_id': hbsy.key_id(pk), 'scope': 'Registry only; no artifact contents'}
        payloads['checkpoint.json'] = hbsy.canonical(receipt)+b'\n'
        with tempfile.TemporaryDirectory(prefix='hbsy-checkpoint-') as temporary:
            env = dict(GIT_INDEX_FILE=str(Path(temporary)/'index'),
                       GIT_AUTHOR_NAME='hbsy registry', GIT_AUTHOR_EMAIL='hbsy@users.noreply.github.com',
                       GIT_COMMITTER_NAME='hbsy registry', GIT_COMMITTER_EMAIL='hbsy@users.noreply.github.com')
            git(root, 'read-tree', '--empty', env=env)
            for name, data in payloads.items():
                oid = git(root, 'hash-object', '-w', '--stdin', data=data).stdout.decode().strip()
                git(root, 'update-index', '--add', '--cacheinfo', f'100644,{oid},{name}', env=env)
            tree = git(root, 'write-tree', env=env).stdout.decode().strip()
            command = ['commit-tree', tree]
            if parent:
                command += ['-p', parent]
            commit = git(root, *command, data=f'Register {project} output from {source}\n'.encode(), env=env).stdout.decode().strip()
            pushed = git(root, 'push', destination, f'{commit}:{ref}', check=False)
            if pushed.returncode == 0:
                after = git(root, 'ls-remote', '--exit-code', 'origin', ref).stdout.decode().split()[0]
                if after != commit:
                    raise hbsy.HBSYError('Remote advanced before checkpoint confirmation')
                return {'ok': True, 'project': project, 'branch': BRANCH, 'commit': commit,
                        'source_commit': source, 'entries': len(merged), 'remote_ref_verified': True}
    raise hbsy.HBSYError('Checkpoint push rejected; no force push performed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    parser.add_argument('--index', type=Path, default=Path('provenance/index.jsonl'))
    parser.add_argument('--pubkey', type=Path, default=Path('.github/hbsy-pubkey.b64'))
    parser.add_argument('--project', required=True)
    args = parser.parse_args()
    try:
        result = publish(args.repo, args.index, args.pubkey, args.project)
        print(json.dumps(result))
        return 0
    except (OSError, ValueError, KeyError, hbsy.HBSYError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
