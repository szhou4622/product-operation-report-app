#!/usr/bin/env python3
"""Safely prepare, activate, inspect, or remove server-only provider keys.

Secrets are read from a hidden prompt or stdin, never from command arguments.
Every update uses fsync + os.replace, which lets the running proxy hot-reload a
complete generation without exposing a half-written file.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


ALLOWED_MODELS = ("gpt-5.5", "gpt-5.6-sol", "claude-sonnet-4-6", "gemini-3-flash", "kimi-k2.6")
DEFAULT_PATH = os.environ.get("POR_PROVIDER_KEYS_FILE", "/etc/product-operation-report/provider-keys.json")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")


def load_document(path: Path) -> dict:
    if not path.exists():
        return {"version": 1, "generation": 0, "profiles": {}, "models": {}}
    document = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict) or document.get("version") != 1:
        raise SystemExit("Provider keyring format is invalid; no changes were made.")
    if not isinstance(document.get("profiles", {}), dict) or not isinstance(document.get("models", {}), dict):
        raise SystemExit("Provider keyring profiles/models are invalid; no changes were made.")
    return document


def next_generation(document: dict) -> int:
    current = document.get("generation", 0)
    return current + 1 if isinstance(current, int) and not isinstance(current, bool) else 1


def atomic_write(path: Path, document: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    previous = path.stat() if path.exists() else None
    encoded = (json.dumps(document, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        if previous is not None and hasattr(os, "chown"):
            os.chown(temporary, previous.st_uid, previous.st_gid)
        os.replace(temporary, path)
        if os.name != "nt":
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if temporary.exists():
            temporary.unlink()


def parse_models(value: str) -> list[str]:
    models = [item.strip() for item in value.split(",") if item.strip()]
    if not models or any(model not in ALLOWED_MODELS for model in models):
        raise argparse.ArgumentTypeError(f"models must be selected from: {', '.join(ALLOWED_MODELS)}")
    return models


def safe_identifier(value: str) -> str:
    if not SAFE_ID_RE.fullmatch(value):
        raise argparse.ArgumentTypeError("identifier may contain only letters, numbers, dot, underscore and dash")
    return value


def safe_base_url(value: str) -> str:
    normalized = value.strip().rstrip("/")
    parsed = urlparse(normalized)
    local_http = parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    if (parsed.scheme != "https" and not local_http) or not parsed.netloc or parsed.username or parsed.password:
        raise argparse.ArgumentTypeError("base URL must be HTTPS or loopback HTTP without embedded credentials")
    return normalized


def read_secret(from_stdin: bool) -> str:
    secret = sys.stdin.readline().rstrip("\r\n") if from_stdin else getpass.getpass("New provider API key: ")
    if len(secret.strip()) < 16 or len(secret) > 8192:
        raise SystemExit("Provider API key length is invalid; no changes were made.")
    return secret.strip()


def probe_key(base_url: str, model: str, secret: str) -> None:
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": "Reply OK"}],
        "stream": False,
        "max_completion_tokens": 8,
    }, separators=(",", ":")).encode("utf-8")
    request = Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {secret}"},
    )
    try:
        with urlopen(request, timeout=45) as response:
            if response.status < 200 or response.status >= 300:
                raise SystemExit(f"Provider check failed with HTTP {response.status}; no changes were made.")
            response.read(1024 * 1024)
    except HTTPError as error:
        error.read(16 * 1024)
        raise SystemExit(f"Provider check failed with HTTP {error.code}; no changes were made.") from error
    except (URLError, TimeoutError, OSError) as error:
        raise SystemExit("Provider check could not connect; no changes were made.") from error


def redacted_status(document: dict) -> dict:
    profiles = {}
    for profile_id, profile in document.get("profiles", {}).items():
        if not isinstance(profile, dict):
            continue
        keys = profile.get("keys", {})
        profiles[profile_id] = {
            "base_url": profile.get("base_url", ""),
            "active_key_id": profile.get("active_key_id", ""),
            "key_ids": list(keys) if isinstance(keys, dict) else [],
        }
    return {
        "version": document.get("version"),
        "generation": document.get("generation"),
        "profiles": profiles,
        "models": document.get("models", {}),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Rotate ProductOperationReport server provider keys.")
    parser.add_argument("--file", default=DEFAULT_PATH)
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("status", help="show identifiers and routing without secrets")

    set_parser = subparsers.add_parser("set", help="add or replace a key, optionally making it active")
    set_parser.add_argument("--profile", required=True, type=safe_identifier)
    set_parser.add_argument("--key-id", required=True, type=safe_identifier)
    set_parser.add_argument("--base-url", required=True, type=safe_base_url)
    set_parser.add_argument("--models", type=parse_models, default=list(ALLOWED_MODELS))
    set_parser.add_argument("--activate", action="store_true")
    set_parser.add_argument("--stdin", action="store_true", help="read one secret line from stdin")
    set_parser.add_argument("--skip-check", action="store_true", help="only for a pre-validated provider")

    activate_parser = subparsers.add_parser("activate", help="atomically switch new requests to an existing key")
    activate_parser.add_argument("--profile", required=True, type=safe_identifier)
    activate_parser.add_argument("--key-id", required=True, type=safe_identifier)

    remove_parser = subparsers.add_parser("remove", help="remove a non-active old key")
    remove_parser.add_argument("--profile", required=True, type=safe_identifier)
    remove_parser.add_argument("--key-id", required=True, type=safe_identifier)

    args = parser.parse_args()
    path = Path(args.file)
    document = load_document(path)

    if args.command == "status":
        print(json.dumps(redacted_status(document), ensure_ascii=False, indent=2))
        return

    profiles = document.setdefault("profiles", {})
    models = document.setdefault("models", {})
    if args.command == "set":
        secret = read_secret(args.stdin)
        if not args.skip_check:
            probe_key(args.base_url, args.models[0], secret)
        profile = profiles.setdefault(args.profile, {"base_url": args.base_url.rstrip("/"), "keys": {}})
        if not isinstance(profile, dict) or not isinstance(profile.setdefault("keys", {}), dict):
            raise SystemExit("Profile format is invalid; no changes were made.")
        profile["base_url"] = args.base_url.rstrip("/")
        profile["keys"][args.key_id] = secret
        if args.activate or not profile.get("active_key_id"):
            profile["active_key_id"] = args.key_id
        for model in args.models:
            models[model] = args.profile
    elif args.command == "activate":
        profile = profiles.get(args.profile)
        if not isinstance(profile, dict) or args.key_id not in profile.get("keys", {}):
            raise SystemExit("Requested profile/key does not exist; no changes were made.")
        profile["active_key_id"] = args.key_id
    elif args.command == "remove":
        profile = profiles.get(args.profile)
        if not isinstance(profile, dict) or args.key_id not in profile.get("keys", {}):
            raise SystemExit("Requested profile/key does not exist; no changes were made.")
        if profile.get("active_key_id") == args.key_id:
            raise SystemExit("Refusing to remove the active key. Activate another key first.")
        del profile["keys"][args.key_id]

    document["version"] = 1
    document["generation"] = next_generation(document)
    atomic_write(path, document)
    print(f"Provider keyring updated atomically (generation {document['generation']}).")


if __name__ == "__main__":
    main()
