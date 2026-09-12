#!/usr/bin/env python3
"""hbsy v2 integrity/signatures. See POLICY.md.
Exit 0: success; 1: verification failure; 2: invalid input/operational error.
Local index matches do not establish remote publication, authorship or priority.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import re
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree as ET

HANDLE = "hb.seo-yunu"
NS = "hbsy"
INDEX_REPO = "hb.seo-yunu-sigs"
PERSONAL_INDEX = Path.home() / INDEX_REPO / "index.jsonl"
WORK_INDEX = Path(__file__).resolve().parents[2] / "schema/hbsy_sigs/index.jsonl"
KEY_DIR = Path.home() / ".hbsy"
SECRET_FILE = KEY_DIR / "key"
PUBLIC_FILE = KEY_DIR / "pubkey"
TEXT_EXT = {".md", ".markdown", ".html", ".htm"}
OFFICE_EXT = {".pptx", ".docx"}
SIDECAR_SUFFIX = ".hbsy.json"
SIDECAR_TEXT_EXT = {".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".yaml", ".yml",
                    ".svg", ".xml", ".css", ".js", ".mjs", ".ts", ".py", ".sql",
                    ".sh", ".cmd", ".bat", ".terms", ".txt", ".md", ".markdown", ".html", ".htm"}
MANIFEST_NAME = "hbsy.manifest.json"
OFFICE_PART = "customXml/hbsy-signature.xml"
OFFICE_TAG = "{urn:hbsy:v2}signature"
TEXT_MARK = re.compile(rb"\n<!-- hbsy-v2:([A-Za-z0-9+/=]+) -->\n\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
MAX_PACKAGE_BYTES = 512 * 1024 * 1024
MAX_PACKAGE_ENTRIES = 20000
BLOCKED_DIRS = {".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv",
                "venv", ".cache", ".pytest_cache", ".mypy_cache", ".ssh", ".aws",
                ".hbsy", ".codex", ".claude"}
BLOCKED_NAMES = {"credentials", "credentials.json", "secrets.json", "id_rsa",
                 "id_ed25519", "key", ".npmrc", ".pypirc", ".netrc"}


class HBSYError(ValueError):
    """Expected fail-closed input or verification error."""


def canonical(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sig_of(full_hash: str) -> str:
    return f"hbsy:{full_hash[:8]}"  # Display only.


def index_path(profile: str) -> Path:
    return WORK_INDEX if profile == "work" else PERSONAL_INDEX


def _json(data: bytes | str):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise HBSYError(f"Duplicate JSON key: {key}")
            result[key] = value
        return result
    def invalid_number(value):
        raise HBSYError("Invalid JSON number")
    try:
        return json.loads(data, object_pairs_hook=pairs, parse_constant=invalid_number)
    except (ValueError, UnicodeError) as exc:
        raise HBSYError(f"Invalid JSON: {exc}") from exc


def _decode_record(data: bytes | str) -> dict:
    value = _json(data)
    if not isinstance(value, dict):
        raise HBSYError("Record must be a JSON object")
    return value


def _safe_relative(value: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value or ":" in value or "\x00" in value:
        raise HBSYError("Unsafe relative path")
    p = PurePosixPath(value)
    if p.is_absolute() or any(part in {"", ".", ".."} for part in value.split("/")):
        raise HBSYError(f"Unsafe relative path: {value}")
    if any(part.endswith((".", " ")) for part in p.parts):
        raise HBSYError(f"Non-portable path: {value}")
    return value


def _no_links(path: Path) -> None:
    for p in (path, *path.parents):
        if p.is_symlink() or (hasattr(p, "is_junction") and p.is_junction()):
            raise HBSYError(f"Symlink/junction is not allowed: {p}")


def _artifact_path(path: Path, root: Path | None = None, override: str | None = None) -> str:
    if override is not None:
        return _safe_relative(override)
    try:
        return _safe_relative(path.resolve().relative_to((root or Path.cwd()).resolve()).as_posix())
    except ValueError as exc:
        raise HBSYError("Artifact is outside --root; specify its repository/distribution root") from exc


def _atomic_write(path: Path, data: bytes) -> None:
    _no_links(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    old_mode = path.stat().st_mode if path.exists() else None
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if old_mode is not None:
            os.chmod(tmp, old_mode)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _crypto():
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
        from cryptography.hazmat.primitives import serialization
        return Ed25519PrivateKey, Ed25519PublicKey, serialization
    except ImportError as exc:
        raise HBSYError("Public signatures require cryptography") from exc


def load_secret():
    raw = os.environ.get("HBSY_SECRET_KEY")
    if not raw and SECRET_FILE.exists():
        raw = SECRET_FILE.read_text(encoding="utf-8").strip()
    if not raw:
        raise HBSYError("Public signing requires a private key; no work-profile fallback")
    try:
        return _crypto()[0].from_private_bytes(base64.b64decode(raw, validate=True))
    except (ValueError, TypeError) as exc:
        raise HBSYError("Invalid private key") from exc


def load_public(b64: str | None = None):
    # No implicit environment/local-file/private-key fallback.
    if not b64:
        raise HBSYError("Public verification requires --pubkey or --pubkey-file from a trusted source")
    try:
        return _crypto()[1].from_public_bytes(base64.b64decode(b64.strip(), validate=True))
    except (ValueError, TypeError) as exc:
        raise HBSYError("Invalid public key") from exc


def key_id(pk) -> str:
    serialization = _crypto()[2]
    return sha(pk.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))


def signed_message(record: dict) -> bytes:
    return b"hbsy-v2\x00" + canonical({k: v for k, v in record.items() if k != "signature"})


def _valid_signature(pk, record: dict) -> bool:
    try:
        if pk is None or record["key_id"] != key_id(pk):
            return False
        pk.verify(base64.b64decode(record["signature"], validate=True), signed_message(record))
        return True
    except (ValueError, TypeError, KeyError):
        return False
    except Exception as exc:
        from cryptography.exceptions import InvalidSignature
        if isinstance(exc, InvalidSignature):
            return False
        raise


def _validate_record(record: dict, kind: str, profile: str) -> None:
    required = {"version", "kind", "handle", "profile", "hash_algorithm", "content_algorithm",
                "hash", "sig", "title", "created", "key_id", "signature"}
    if kind == "manifest":
        required |= {"files", "file_count"}
    if set(record) != required or type(record.get("version")) is not int or record["version"] != 2:
        raise HBSYError("Unsupported/malformed v2 record")
    if not isinstance(profile, str) or profile not in {"work", "public"} or record["kind"] != kind or record["handle"] != HANDLE or record["profile"] != profile:
        raise HBSYError("Record kind, handle, or expected profile mismatch")
    if record["hash_algorithm"] != "sha256" or not isinstance(record["hash"], str) or not HEX64.fullmatch(record["hash"]):
        raise HBSYError("Invalid full SHA-256")
    if record["sig"] != sig_of(record["hash"]):
        raise HBSYError("Display fingerprint mismatch")
    if not isinstance(record["title"], str) or not isinstance(record["created"], str):
        raise HBSYError("Invalid record metadata")
    try:
        if datetime.fromisoformat(record["created"]).tzinfo is None:
            raise ValueError("timezone required")
    except ValueError as exc:
        raise HBSYError("Invalid creation timestamp") from exc
    if profile == "work":
        if record["key_id"] is not None or record["signature"] is not None:
            raise HBSYError("Work record must not contain a personal-key signature")
    elif not isinstance(record["key_id"], str) or not HEX64.fullmatch(record["key_id"]) or not isinstance(record["signature"], str):
        raise HBSYError("Public record requires a key identity and signature")


def _text_parts(data: bytes) -> tuple[bytes, dict | None]:
    # Git may normalize the marker CRLF to LF; preserve original body bytes.
    marker_data = data.replace(b"\r\n", b"\n")
    match = TEXT_MARK.search(marker_data)
    count = marker_data.count(b"<!-- hbsy-v2:")
    if count and (count != 1 or match is None):
        raise HBSYError("Malformed/duplicate v2 marker; refusing to discard content")
    if not match:
        return data, None
    try:
        record = _decode_record(base64.b64decode(match.group(1), validate=True))
    except ValueError as exc:
        raise HBSYError("Malformed v2 marker") from exc
    # Locate the exact original marker boundary without newline normalization.
    start = data.rfind(b"<!-- hbsy-v2:")
    prefix_len = 2 if data[:start].endswith(b"\r\n") else 1
    return data[:start - prefix_len], record


def strip_mark_lines(text: str) -> str:
    """Compatibility helper: remove only the single exact v2 EOF marker."""
    return _text_parts(text.encode("utf-8"))[0].decode("utf-8")


def _text_hash(data: bytes) -> str:
    data.decode("utf-8")  # Do not silently reinterpret arbitrary encodings.
    normalized = data.replace(b"\r\n", b"\n")
    if b"\r" in normalized:
        raise HBSYError("Bare CR line endings are unsupported; use LF or CRLF")
    return sha(normalized)


def _legacy(data: bytes) -> bool:
    return bool(re.search(rb"<!--\s*(?:sig:\s*hb\.seo-yunu|hbsy-sig:)|"
                          rb"name=[\"']x-sig[\"']|hbsy-sig:\s*[A-Za-z0-9+/=]{40,}", data))


def _package(data: bytes) -> tuple[list, bytes, dict | None]:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_PACKAGE_ENTRIES or sum(i.file_size for i in infos) > MAX_PACKAGE_BYTES:
                raise HBSYError("Office package exceeds verification size limits")
            seen = set()
            entries = []
            record = None
            for info in infos:
                name = info.filename
                if info.orig_filename != name:
                    raise HBSYError("Truncated Office package entry name")
                _safe_relative(name.rstrip("/"))
                if name.casefold() in seen or info.flag_bits & 1:
                    raise HBSYError("Duplicate/encrypted Office package entry")
                seen.add(name.casefold())
                body = archive.read(info)
                if name == OFFICE_PART:
                    try:
                        node = ET.fromstring(body)
                        if node.tag != OFFICE_TAG or node.attrib or list(node):
                            raise HBSYError("Reserved Office signature part contains unrelated data")
                        record = _decode_record(base64.b64decode(node.text or "", validate=True))
                        if body != _office_payload(record):
                            raise HBSYError("Non-canonical/reserved Office signature part")
                    except (ET.ParseError, ValueError) as exc:
                        raise HBSYError("Malformed Office signature part") from exc
                else:
                    entries.append((info, body))
            names = {i.filename for i, _ in entries}
            if "[Content_Types].xml" not in names or "_rels/.rels" not in names:
                raise HBSYError("Not an OOXML package")
            types = ET.fromstring(next(b for i, b in entries if i.filename == "[Content_Types].xml"))
            if not any(n.tag == "{http://schemas.openxmlformats.org/package/2006/content-types}Default"
                       and n.get("Extension") == "xml" and n.get("ContentType") in {"application/xml", "text/xml"}
                       for n in types):
                raise HBSYError("OOXML package lacks a default XML content type")
            return entries, archive.comment, record
    except (zipfile.BadZipFile, ET.ParseError, RuntimeError) as exc:
        raise HBSYError(f"Invalid Office package: {exc}") from exc


def _package_hash(entries: list, comment: bytes) -> str:
    parts = [{"path": info.filename, "hash": sha(body)} for info, body in entries]
    return sha(canonical({"parts": sorted(parts, key=lambda e: e["path"]),
                          "zip_comment": base64.b64encode(comment).decode("ascii")}))


def _read_artifact(path: Path, storage: str = "auto") -> dict:
    _no_links(path)
    data = path.read_bytes()
    ext = path.suffix.lower()
    sidecar = Path(str(path) + SIDECAR_SUFFIX)
    _no_links(sidecar)
    if path.name.endswith(SIDECAR_SUFFIX) or path.name == MANIFEST_NAME:
        raise HBSYError("Signature metadata is not an input artifact")
    if storage not in {"auto", "sidecar"}:
        raise HBSYError("Unknown storage mode")
    if sidecar.exists() or storage == "sidecar" or ext not in TEXT_EXT | OFFICE_EXT | {".txt"}:
        record = _decode_record(sidecar.read_bytes()) if sidecar.exists() else None
        if ext in TEXT_EXT:
            _, embedded = _text_parts(data)
            if embedded is not None:
                raise HBSYError("Cannot shadow an embedded v2 record with a sidecar")
        if ext in OFFICE_EXT:
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    if OFFICE_PART in archive.namelist():
                        raise HBSYError("Cannot shadow an Office v2 record with a sidecar")
            except zipfile.BadZipFile:
                pass
        if record and record.get("content_algorithm") == "utf8-lf-v1":
            full, algorithm = _text_hash(data), "utf8-lf-v1"
        elif ext in SIDECAR_TEXT_EXT:
            full, algorithm = sha(data.replace(b"\r\n", b"\n")), "lf-bytes-v1"
        else:
            full, algorithm = sha(data), "bytes-v1"
        return {"hash": full, "algorithm": algorithm, "record": record,
                "body": data, "legacy": False, "data": data, "storage": "sidecar"}
    if ext in TEXT_EXT:
        body, record = _text_parts(data)
        return {"hash": _text_hash(body), "algorithm": "utf8-lf-v1", "record": record,
                "body": body, "legacy": _legacy(body), "data": data}
    if ext == ".txt":
        sidecar = Path(str(path) + ".hbsy.json")
        _no_links(sidecar)
        record = _decode_record(sidecar.read_bytes()) if sidecar.exists() else None
        return {"hash": _text_hash(data), "algorithm": "utf8-lf-v1", "record": record,
                "body": data, "legacy": _legacy(data), "data": data}
    if ext in OFFICE_EXT:
        entries, comment, record = _package(data)
        return {"hash": _package_hash(entries, comment), "algorithm": "ooxml-package-v1",
                "record": record, "entries": entries, "comment": comment, "data": data,
                "legacy": any(_legacy(body) or re.search(rb"hbsy:[0-9a-f]{8}", body)
                              for info, body in entries if info.filename == "docProps/core.xml")}
    raise HBSYError(f"Unsupported artifact format: {ext}; use a distribution manifest")


def _office_payload(record: dict) -> bytes:
    return b'<hbsy:signature xmlns:hbsy="urn:hbsy:v2">' + base64.b64encode(canonical(record)) + b"</hbsy:signature>"


def _embed(path: Path, artifact: dict, record: dict) -> tuple[Path, bytes]:
    payload = canonical(record)
    if artifact.get("storage") == "sidecar" or path.suffix.lower() == ".txt":
        return Path(str(path) + SIDECAR_SUFFIX), payload + b"\n"
    if path.suffix.lower() in TEXT_EXT:
        return path, artifact["body"] + b"\n<!-- hbsy-v2:" + base64.b64encode(payload) + b" -->\n"
    if artifact.get("record") == record:
        return path, artifact["data"]
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.comment = artifact["comment"]
        for info, body in artifact["entries"]:
            archive.writestr(info, body)
        archive.writestr(OFFICE_PART, _office_payload(record), compress_type=zipfile.ZIP_DEFLATED)
    return path, stream.getvalue()


def _new_record(kind: str, profile: str, full: str, algorithm: str, title: str, sk=None,
                previous: dict | None = None, files: list | None = None) -> dict:
    record = {"version": 2, "kind": kind, "handle": HANDLE, "profile": profile,
              "hash_algorithm": "sha256", "content_algorithm": algorithm, "hash": full,
              "sig": sig_of(full), "title": title, "created": datetime.now(timezone.utc).isoformat(timespec="microseconds"),
              "key_id": key_id(sk.public_key()) if sk else None, "signature": None}
    if files is not None:
        record.update(files=files, file_count=len(files))
    if previous:
        try:
            _validate_record(previous, kind, profile)
            stable = set(record) - {"created", "signature"}
            if all(record[k] == previous[k] for k in stable) and (profile == "work" or _valid_signature(sk.public_key(), previous)):
                return previous
        except HBSYError:
            pass
    if sk:
        record["signature"] = base64.b64encode(sk.sign(signed_message(record))).decode("ascii")
    return record


def _index_entries(index: Path) -> list:
    _no_links(index)
    if not index.exists():
        return []
    entries = []
    for number, line in enumerate(index.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            entries.append(_decode_record(line))
        except HBSYError as exc:
            raise HBSYError(f"Malformed local index line {number}") from exc
    return entries


def _index_entry(record: dict, relative: str) -> dict:
    return {"version": 2, "path": relative, "profile": record["profile"], "hash": record["hash"],
            "record_sha256": sha(canonical(record)), "record": record}


def append_index(index: Path, entry: dict, index_cache: dict | None = None) -> None:
    _validate_cache_identity(index, index_cache)
    if canonical(entry) in index_cache["records"] if index_cache is not None else any(existing == entry for existing in _index_entries(index)):
        return
    _no_links(index)
    index.parent.mkdir(parents=True, exist_ok=True)
    # One append write; no read/replace that could lose a concurrent append.
    with index.open("ab", buffering=0) as f:
        encoded = canonical(entry) + b"\n"
        if f.write(encoded) != len(encoded):
            raise HBSYError("Incomplete index write; verification must be retried after index repair")
        os.fsync(f.fileno())
    if index_cache is not None:
        index_cache["records"].add(canonical(entry))
        index_cache["entries"].append(entry)


def load_index_cache(index: Path | str) -> dict:
    entries = _index_entries(Path(index))
    return {"entries": entries, "records": {canonical(entry) for entry in entries},
            "index_path": str(Path(index).resolve())}


def _validate_cache_identity(index: Path, cache: dict | None) -> None:
    if cache is not None and cache.get("index_path") != str(index.resolve()):
        raise HBSYError("Cache does not belong to the selected index")


def _check_index(index: Path, record: dict, relative: str, index_cache: dict | None = None) -> None:
    _validate_cache_identity(index, index_cache)
    expected = _index_entry(record, relative)
    exists = canonical(expected) in index_cache["records"] if index_cache is not None else any(entry == expected for entry in _index_entries(index))
    if not exists:
        raise HBSYError("Exact v2 record/path is missing from the selected local index")


def file_sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _manifest_files(root: Path) -> list:
    _no_links(root)
    if not root.is_dir():
        raise HBSYError("Manifest requires a distribution directory")
    files = []
    seen = set()
    def walk_error(exc):
        raise HBSYError(f"Cannot enumerate complete distribution: {exc}")
    for current, dirs, names in os.walk(root, followlinks=False, onerror=walk_error):
        for name in sorted(dirs + names):
            p = Path(current) / name
            _no_links(p)
            rel = _safe_relative(p.relative_to(root).as_posix())
            lower = name.casefold()
            if rel == MANIFEST_NAME:
                if not p.is_file():
                    raise HBSYError("Manifest output path is not a file")
                continue
            if lower in BLOCKED_DIRS or lower in BLOCKED_NAMES or lower.startswith(".env") or lower.endswith((".pem", ".key", ".p12", ".pfx", ".pyc")):
                raise HBSYError(f"Distribution contains repository/cache/secret candidate: {rel}")
            if p.is_file():
                if rel.casefold() in seen:
                    raise HBSYError("Case-colliding distribution paths")
                seen.add(rel.casefold())
                files.append({"path": rel, "hash": file_sha(p)})
            elif not p.is_dir():
                raise HBSYError(f"Non-regular distribution entry: {rel}")
    if not files:
        raise HBSYError("Cannot sign an empty distribution")
    return sorted(files, key=lambda e: e["path"])


def _validate_file_list(record: dict) -> None:
    files = record["files"]
    if not isinstance(files, list) or not files or type(record["file_count"]) is not int or record["file_count"] != len(files):
        raise HBSYError("Invalid manifest file count")
    seen = set()
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != {"path", "hash"}:
            raise HBSYError("Invalid manifest file entry")
        rel = _safe_relative(entry["path"])
        if rel.casefold() in seen or rel == MANIFEST_NAME:
            raise HBSYError("Duplicate/self-referencing manifest path")
        seen.add(rel.casefold())
        if not isinstance(entry["hash"], str) or not HEX64.fullmatch(entry["hash"]):
            raise HBSYError("Invalid manifest file hash")
    if files != sorted(files, key=lambda e: e["path"]) or sha(canonical(files)) != record["hash"]:
        raise HBSYError("Manifest list/hash mismatch")


def verify_document(path: Path | str, profile: str, index: Path | str, pk=None, *,
                    root: Path | str | None = None, artifact_path: str | None = None, index_cache: dict | None = None, registry_required: bool = True) -> dict:
    """Exact v2 verification against ONE local index and expected profile.
    Staged/remote adapters can supply artifact_path for a temporary artifact copy.
    """
    path, index = Path(path), Path(index)
    result = {"path": str(path), "ok": False, "status": "FAILED", "profile": profile,
              "trust_scope": "local_index", "index_path": str(index)}
    try:
        if profile not in {"work", "public"}:
            raise HBSYError("Expected profile must be work or public")
        _no_links(path)
        relative = _artifact_path(path, Path(root) if root else None, artifact_path)
        result["artifact_path"] = relative
        if path.name == MANIFEST_NAME:
            record = _decode_record(path.read_bytes())
            if record.get("version") != 2:
                result["status"] = "LEGACY_LIMITED"
                raise HBSYError("Legacy manifest is not a v2 verification pass")
            _validate_record(record, "manifest", profile)
            if record["content_algorithm"] != "file-set-v1":
                raise HBSYError("Unexpected manifest hash algorithm")
            _validate_file_list(record)
            if _manifest_files(path.parent) != record["files"]:
                raise HBSYError("Distribution changed: added, removed, or modified file")
        else:
            artifact = _read_artifact(path)
            record = artifact["record"]
            if record is None:
                result["status"] = "LEGACY_LIMITED" if artifact["legacy"] else "UNMARKED"
                raise HBSYError("No v2 record; legacy/unmarked artifacts cannot pass")
            _validate_record(record, "artifact", profile)
            if artifact["hash"] != record["hash"] or artifact["algorithm"] != record["content_algorithm"]:
                raise HBSYError("Full content hash/algorithm mismatch")
        result.update(hash=record["hash"], record_sha256=sha(canonical(record)))
        if profile == "public" and not _valid_signature(pk, record):
            raise HBSYError("Public key missing or signature/key identity mismatch")
        if registry_required:
            _check_index(index, record, relative, index_cache)
        elif profile != "public":
            raise HBSYError("Unsigned work verification requires an independent registry")
        result.update(ok=True, status="VERIFIED_LOCAL" if registry_required else "VERIFIED_SIGNATURE",
                      trust_scope="local_index" if registry_required else "pinned_public_key",
                      signature_verified=profile == "public")
    except (HBSYError, OSError, UnicodeError, TypeError) as exc:
        result["error"] = str(exc)
    return result



def sign_artifact(path: Path | str, profile: str = "work", index: Path | str | None = None,
                  root: Path | str | None = None, *, storage: str = "auto",
                  title: str | None = None, index_cache: dict | None = None, sk=None) -> dict:
    """Register current bytes; never backdate or expose a private key.

    A batch may reuse load_index_cache(index), provided it owns index writes.
    Sidecars preserve the original file bytes, including legacy/binary formats.
    """
    path = Path(path)
    index = Path(index) if index is not None else index_path(profile)
    scope_root = Path(root) if root is not None else Path.cwd()
    if profile not in {"work", "public"}:
        raise HBSYError("Invalid signing profile")
    if profile == "public":
        sk = sk or load_secret()
    elif sk is not None:
        raise HBSYError("Work artifacts must not use a personal key")
    cache = index_cache if index_cache is not None else load_index_cache(index)
    relative = _artifact_path(path, scope_root)
    artifact = _read_artifact(path, storage=storage)
    if artifact["legacy"]:
        raise HBSYError("Legacy marker requires explicit sidecar enrollment")
    if artifact["record"]:
        _validate_record(artifact["record"], "artifact", artifact["record"].get("profile"))
    title = title if title is not None else (artifact["record"] or {}).get("title", path.stem)
    record = _new_record("artifact", profile, artifact["hash"], artifact["algorithm"], title, sk, artifact["record"])
    target, data = _embed(path, artifact, record)
    if target.resolve() == index.resolve() or path.resolve() == index.resolve():
        raise HBSYError("Index and artifact must be different files")
    # Do not overwrite an artifact changed by a concurrent generator since read.
    if path.read_bytes() != artifact["data"]:
        raise HBSYError("Artifact changed during registration")
    if not target.exists() or target.read_bytes() != data:
        _atomic_write(target, data)
    append_index(index, _index_entry(record, relative), cache)
    result = verify_document(path, profile, index, sk.public_key() if sk else None,
                             root=scope_root, index_cache=cache)
    if not result["ok"]:
        raise HBSYError(result.get("error", "Post-registration verification failed"))
    result["storage"] = "sidecar" if target != path else "embedded"
    result["metadata_path"] = str(target)
    return result


def _options(args):
    return Path(args.index) if args.index else index_path(args.profile), Path(args.root or Path.cwd())


def cmd_sign(args) -> int:
    index, root = _options(args)
    sk = load_secret() if args.profile == "public" else None
    _index_entries(index)
    pending = []
    seen = set()
    for name in args.files:
        path = Path(name)
        relative = _artifact_path(path, root)
        if relative.casefold() in seen:
            raise HBSYError("Duplicate input artifact")
        seen.add(relative.casefold())
        artifact = _read_artifact(path, storage=getattr(args, "storage", "auto"))
        if artifact["legacy"]:
            raise HBSYError(f"Legacy marker in {path}; review/migrate explicitly before v2 signing")
        if artifact["record"] is not None:
            _validate_record(artifact["record"], "artifact", artifact["record"].get("profile"))
        title = args.title if args.title is not None else (artifact["record"] or {}).get("title", path.stem)
        record = _new_record("artifact", args.profile, artifact["hash"], artifact["algorithm"],
                             title, sk, artifact["record"])
        target, data = _embed(path, artifact, record)
        if target.resolve() == index.resolve():
            raise HBSYError("Index and artifact output must be different files")
        pending.append((target, data, _index_entry(record, relative)))
    for target, data, entry in pending:
        if not target.exists() or target.read_bytes() != data:
            _atomic_write(target, data)
        append_index(index, entry)
        print(f"SIGNED {entry['path']} {entry['profile']} {entry['hash']}")
    print(f"Local index: {index}; remote publication has not been checked")
    return 0


def cmd_manifest(args) -> int:
    index, scope_root = _options(args)
    root = Path(args.folder)
    out = root / MANIFEST_NAME
    relative = _artifact_path(out, scope_root)
    if index.resolve().is_relative_to(root.resolve()):
        raise HBSYError("Index must be outside the distribution directory")
    sk = load_secret() if args.profile == "public" else None
    _index_entries(index)
    files = _manifest_files(root)
    previous = _decode_record(out.read_bytes()) if out.exists() else None
    if previous is not None and previous.get("version") != 2:
        raise HBSYError("Legacy manifest requires explicit reviewed migration")
    if previous is not None:
        _validate_record(previous, "manifest", previous.get("profile"))
    title = args.title if args.title is not None else (previous or {}).get("title", root.name)
    record = _new_record("manifest", args.profile, sha(canonical(files)), "file-set-v1", title,
                         sk, previous, files)
    _atomic_write(out, canonical(record) + b"\n")
    append_index(index, _index_entry(record, relative))
    print(f"SIGNED {relative} {args.profile} {len(files)} files; local index: {index}")
    return 0


def cmd_verify(args) -> int:
    index, root = _options(args)
    if args.artifact_path and len(args.files) != 1:
        raise HBSYError("--artifact-path requires exactly one input")
    pk = None
    if args.profile == "public":
        pk = load_public(Path(args.pubkey_file).read_text(encoding="utf-8") if args.pubkey_file else args.pubkey)
    results = [verify_document(Path(name), args.profile, index, pk, root=root,
                               artifact_path=args.artifact_path) for name in args.files]
    payload = {"version": 2, "ok": all(r["ok"] for r in results), "trust_scope": "local_index", "results": results}
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        for result in results:
            print(f"{result['status']} {result['path']}: {result.get('error', 'full hash + selected local index match')}")
        print("Local-index evidence only; remote publication, authorship, and priority are not established.")
    return 0 if payload["ok"] else 1


def cmd_keygen(args) -> int:
    if SECRET_FILE.exists() or PUBLIC_FILE.exists() or os.environ.get("HBSY_SECRET_KEY"):
        raise HBSYError("Key material already exists; automatic overwrite/rotation is not supported")
    private, _, serialization = _crypto()
    sk = private.generate()
    KEY_DIR.mkdir(parents=True, exist_ok=True)
    raw = base64.b64encode(sk.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                                          serialization.NoEncryption()))
    public = base64.b64encode(sk.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))
    fd = os.open(SECRET_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(raw)
    with PUBLIC_FILE.open("xb") as f:
        f.write(public)
    print(f"Private key created at {SECRET_FILE}; protect with user-only OS permissions and a secure backup.")
    print(f"Public key: {public.decode('ascii')}")
    return 0


def cmd_init(args) -> int:
    index = Path(args.index) if args.index else index_path(args.profile)
    _no_links(index)
    index.parent.mkdir(parents=True, exist_ok=True)
    index.touch(exist_ok=True)
    print(f"Local index ready: {index}; this does not create/publish a remote repository")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="hbsy v2 integrity/signature verification")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sign = sub.add_parser("sign")
    sign.add_argument("files", nargs="+")
    sign.add_argument("--title")
    sign.add_argument("--storage", choices=["auto", "sidecar"], default="auto")
    sign.set_defaults(func=cmd_sign)
    manifest = sub.add_parser("manifest", help="Sign an explicit distribution directory, never a repository root")
    manifest.add_argument("folder")
    manifest.add_argument("--title")
    manifest.set_defaults(func=cmd_manifest)
    verify = sub.add_parser("verify")
    verify.add_argument("files", nargs="+")
    pubkeys = verify.add_mutually_exclusive_group()
    pubkeys.add_argument("--pubkey")
    pubkeys.add_argument("--pubkey-file")
    verify.add_argument("--artifact-path", help="Expected index path for one staged/renamed artifact")
    verify.add_argument("--json", action="store_true")
    verify.set_defaults(func=cmd_verify)
    for command in (sign, manifest, verify):
        command.add_argument("--profile", choices=["work", "public"], required=command is verify, default="work")
        command.add_argument("--index", help="One explicit local index (otherwise profile-specific default)")
        command.add_argument("--root", help="Repository root for index-relative paths (default: current directory)")
    keygen = sub.add_parser("keygen")
    keygen.set_defaults(func=cmd_keygen)
    init = sub.add_parser("init")
    init.add_argument("--profile", choices=["work", "public"], default="work")
    init.add_argument("--index")
    init.set_defaults(func=cmd_init)
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (HBSYError, OSError, UnicodeError) as exc:
        if getattr(args, "json", False):
            print(json.dumps({"version": 2, "ok": False, "trust_scope": "local_index",
                              "results": [], "error": str(exc)}, ensure_ascii=False))
        else:
            print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
