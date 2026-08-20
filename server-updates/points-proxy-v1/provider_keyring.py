#!/usr/bin/env python3
"""Server-only provider credential keyring with atomic hot reload.

The desktop client must never import this module or receive these credentials.
The keyring keeps the last valid snapshot when a replacement file is damaged,
so a bad rotation cannot take down requests that were already working.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


MAX_CONFIG_BYTES = 1024 * 1024
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")


@dataclass(frozen=True)
class ProviderRouteSnapshot:
    model: str
    base_url: str
    key_id: str
    api_key: str = field(repr=False)
    generation: str = "environment"
    source: str = "environment"


class ProviderKeyring:
    def __init__(
        self,
        config_path: str,
        fallback_routes: dict[str, tuple[str, str]],
        allowed_models: tuple[str, ...],
    ) -> None:
        self.config_path = Path(config_path)
        self.fallback_routes = fallback_routes
        self.allowed_models = allowed_models
        self._lock = threading.RLock()
        self._last_attempt_signature: tuple[int, int] | None = None
        self._file_routes: dict[str, tuple[ProviderRouteSnapshot, ...]] | None = None
        self._generation = "environment"
        self._reload_status = "environment_fallback"
        self._last_reload_at = 0.0

    def _signature(self) -> tuple[int, int] | None:
        try:
            stat = self.config_path.stat()
            return stat.st_mtime_ns, stat.st_size
        except FileNotFoundError:
            return None

    @staticmethod
    def _safe_base_url(value: Any) -> str:
        if not isinstance(value, str):
            raise ValueError("provider base URL must be text")
        normalized = value.strip().rstrip("/")
        parsed = urlparse(normalized)
        local_http = parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        if (parsed.scheme != "https" and not local_http) or not parsed.netloc or parsed.username or parsed.password:
            raise ValueError("provider base URL must be HTTPS or loopback HTTP")
        return normalized

    @staticmethod
    def _safe_identifier(value: Any, label: str) -> str:
        if not isinstance(value, str) or not SAFE_ID_RE.fullmatch(value):
            raise ValueError(f"invalid {label}")
        return value

    def _parse(self, raw: bytes) -> tuple[str, dict[str, tuple[ProviderRouteSnapshot, ...]]]:
        if not raw or len(raw) > MAX_CONFIG_BYTES:
            raise ValueError("provider keyring file is empty or too large")
        document = json.loads(raw.decode("utf-8"))
        if not isinstance(document, dict) or document.get("version") != 1:
            raise ValueError("provider keyring version is unsupported")
        generation_value = document.get("generation", "1")
        if isinstance(generation_value, bool) or not isinstance(generation_value, (str, int)):
            raise ValueError("invalid provider keyring generation")
        generation = str(generation_value)[:80]
        profiles = document.get("profiles", {})
        models = document.get("models", {})
        if not isinstance(profiles, dict) or not isinstance(models, dict):
            raise ValueError("provider keyring profiles or models are invalid")

        parsed_profiles: dict[str, tuple[str, str, tuple[tuple[str, str], ...]]] = {}
        for raw_profile_id, raw_profile in profiles.items():
            profile_id = self._safe_identifier(raw_profile_id, "profile id")
            if not isinstance(raw_profile, dict):
                raise ValueError("provider profile must be an object")
            base_url = self._safe_base_url(raw_profile.get("base_url"))
            active_key_id = self._safe_identifier(raw_profile.get("active_key_id"), "active key id")
            raw_keys = raw_profile.get("keys")
            if not isinstance(raw_keys, dict) or not raw_keys:
                raise ValueError("provider profile has no keys")
            keys: list[tuple[str, str]] = []
            for raw_key_id, raw_secret in raw_keys.items():
                key_id = self._safe_identifier(raw_key_id, "key id")
                enabled = True
                secret = raw_secret
                if isinstance(raw_secret, dict):
                    enabled = raw_secret.get("enabled", True) is True
                    secret = raw_secret.get("secret")
                if not enabled:
                    continue
                if not isinstance(secret, str) or len(secret.strip()) < 16 or len(secret) > 8192:
                    raise ValueError("provider key secret is invalid")
                keys.append((key_id, secret.strip()))
            key_map = dict(keys)
            if active_key_id not in key_map:
                raise ValueError("active provider key is missing or disabled")
            ordered = [(active_key_id, key_map[active_key_id])]
            ordered.extend((key_id, secret) for key_id, secret in keys if key_id != active_key_id)
            parsed_profiles[profile_id] = (base_url, active_key_id, tuple(ordered))

        routes: dict[str, tuple[ProviderRouteSnapshot, ...]] = {}
        for model, raw_profile_id in models.items():
            if model not in self.allowed_models:
                raise ValueError("provider keyring contains an unsupported model")
            profile_id = self._safe_identifier(raw_profile_id, "model profile id")
            if profile_id not in parsed_profiles:
                raise ValueError("model references a missing provider profile")
            base_url, _active_key_id, keys = parsed_profiles[profile_id]
            routes[model] = tuple(
                ProviderRouteSnapshot(
                    model=model,
                    base_url=base_url,
                    key_id=key_id,
                    api_key=secret,
                    generation=generation,
                    source="keyring_file",
                )
                for key_id, secret in keys
            )
        return generation, routes

    def refresh_if_changed(self, force: bool = False) -> None:
        with self._lock:
            signature = self._signature()
            if not force and signature == self._last_attempt_signature:
                return
            self._last_attempt_signature = signature
            self._last_reload_at = time.time()
            if signature is None:
                if self._file_routes is None:
                    self._reload_status = "environment_fallback"
                else:
                    self._reload_status = "last_known_good"
                return
            try:
                if os.name != "nt" and self.config_path.stat().st_mode & 0o077:
                    raise ValueError("provider keyring permissions are too broad")
                generation, routes = self._parse(self.config_path.read_bytes())
            except Exception:
                # Never include parser details or secret-bearing values in status/log output.
                self._reload_status = "last_known_good" if self._file_routes is not None else "invalid"
                return
            self._generation = generation
            self._file_routes = routes
            self._reload_status = "loaded"

    def _fallback_candidates(self, model: str) -> tuple[ProviderRouteSnapshot, ...]:
        base_url, api_key = self.fallback_routes.get(model, ("", ""))
        if not base_url or not api_key:
            return ()
        return (
            ProviderRouteSnapshot(
                model=model,
                base_url=base_url.rstrip("/"),
                key_id="environment",
                api_key=api_key,
            ),
        )

    def candidates(self, model: str) -> tuple[ProviderRouteSnapshot, ...]:
        if model not in self.allowed_models:
            raise KeyError(model)
        self.refresh_if_changed()
        with self._lock:
            configured = self._file_routes.get(model, ()) if self._file_routes is not None else ()
            return configured or self._fallback_candidates(model)

    def active(self, model: str) -> ProviderRouteSnapshot | None:
        candidates = self.candidates(model)
        return candidates[0] if candidates else None

    def has_any_key(self) -> bool:
        return any(self.candidates(model) for model in self.allowed_models)

    def health(self) -> dict[str, Any]:
        self.refresh_if_changed()
        with self._lock:
            models: dict[str, dict[str, Any]] = {}
            for model in self.allowed_models:
                configured = self._file_routes.get(model, ()) if self._file_routes is not None else ()
                candidates = configured or self._fallback_candidates(model)
                models[model] = {
                    "configured": bool(candidates),
                    "source": candidates[0].source if candidates else "none",
                    "standby_keys": max(0, len(candidates) - 1),
                }
            return {
                "reload_status": self._reload_status,
                "generation": self._generation if self._file_routes is not None else "environment",
                "models": models,
            }
