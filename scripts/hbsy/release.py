#!/usr/bin/env python3
"""Seal final output bytes and verify them with a pinned public key.

`public` is the historical cryptographic profile name, not permission to publish.
This tool never uploads files, changes repository visibility, or prints secrets.
"""
from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path
import sys

try:
    from . import hbsy
except ImportError:
    import hbsy


def run(args) -> dict:
    root = Path(args.artifact_root or Path.cwd()).resolve()
    index = Path(args.index).resolve()
    original_target = Path(args.directory or args.artifact)
    hbsy._no_links(original_target)
    target = original_target.resolve()
    profile = args.profile
    pk = hbsy.load_public(Path(args.pubkey).read_text(encoding="utf-8").strip()) if profile == "public" else None
    if args.directory and not target.is_dir():
        raise hbsy.HBSYError("Distribution directory is missing")
    if not args.directory and not target.is_file():
        raise hbsy.HBSYError("Artifact is missing")
    if args.directory and index.is_relative_to(target):
        raise hbsy.HBSYError("Registry must be outside the distribution")
    hbsy._artifact_path(target / hbsy.MANIFEST_NAME if args.directory else target, root)
    if args.command == "seal":
        sk = hbsy.load_secret() if profile == "public" else None
        if sk and hbsy.key_id(sk.public_key()) != hbsy.key_id(pk):
            raise hbsy.HBSYError("Signing key does not match pinned public key")
        cache = hbsy.load_index_cache(index)
        if args.directory:
            # Fail before any output edit for accidental source-root/secret inclusion.
            hbsy._manifest_files(target)
            for html in sorted(target.rglob("*.html")):
                hbsy.sign_artifact(html, profile, index, root, index_cache=cache, sk=sk)
            provenance = {"version": 2, "project": args.project, "profile": profile,
                          "manifest": hbsy.MANIFEST_NAME,
                          "scope": "Integrity of this distribution; registration is not historical authorship proof"}
            if pk:
                provenance["key_id"] = hbsy.key_id(pk)
                hbsy._atomic_write(target / "hbsy.pubkey", Path(args.pubkey).read_bytes().strip() + b"\n")
            hbsy._atomic_write(target / "hbsy.provenance.json", hbsy.canonical(provenance) + b"\n")
            out = target / hbsy.MANIFEST_NAME
            previous = hbsy._decode_record(out.read_bytes()) if out.exists() else None
            if previous is not None:
                hbsy._validate_record(previous, "manifest", profile)
            files = hbsy._manifest_files(target)
            record = hbsy._new_record("manifest", profile, hbsy.sha(hbsy.canonical(files)),
                                      "file-set-v1", args.project, sk, previous, files)
            hbsy._atomic_write(out, hbsy.canonical(record) + b"\n")
            hbsy.append_index(index, hbsy._index_entry(record, hbsy._artifact_path(out, root)), cache)
        else:
            hbsy.sign_artifact(target, profile, index, root, index_cache=cache, sk=sk)
    out = target / hbsy.MANIFEST_NAME if args.directory else target
    if args.standalone:
        if profile != "public":
            raise hbsy.HBSYError("Unsigned work profile needs its independently held registry")
        cache = None
    else:
        cache = hbsy.load_index_cache(index)
    result = hbsy.verify_document(out, profile, index, pk, root=root, index_cache=cache, registry_required=not args.standalone)
    if args.standalone:
        result.update(trust_scope="pinned_public_key", status="VERIFIED_SIGNATURE" if result["ok"] else "FAILED")
    result["project"] = args.project
    result["remote_checked"] = False
    return result


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["seal", "verify"])
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--directory")
    target.add_argument("--artifact")
    parser.add_argument("--project", required=True, help="Project label, never a filesystem root")
    parser.add_argument("--index", default="provenance/index.jsonl")
    parser.add_argument("--pubkey", default=".github/hbsy-pubkey.b64")
    parser.add_argument("--profile", choices=["work", "public"], default="public")
    parser.add_argument("--artifact-root", help="Root for index paths, default current directory")
    parser.add_argument("--standalone", action="store_true", help="Pinned-key signature check without registry; public only")
    args = parser.parse_args(argv)
    try:
        if args.command == "seal" and args.standalone:
            raise hbsy.HBSYError("Seal must retain a registry")
        result = run(args)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result["ok"] else 1
    except (OSError, ValueError, hbsy.HBSYError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    sys.exit(main())
