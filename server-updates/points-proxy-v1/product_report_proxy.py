#!/usr/bin/env python3
"""ProductOperationReport business proxy.

Provider credentials and the authoritative points ledger live here. The desktop
client receives only short-lived random session tokens. This service stores no
prompts, source files, images, or model output.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from provider_keyring import ProviderKeyring, ProviderRouteSnapshot


APP_NAME = "ProductOperationReport"
HOST = os.environ.get("POR_PROXY_HOST", "127.0.0.1")
PORT = int(os.environ.get("POR_PROXY_PORT", "8794"))
DB_PATH = os.environ.get("POR_POINTS_DB", "/opt/product-operation-report/points.sqlite3")
LICENSE_DB_PATH = os.environ.get(
    "POR_LICENSE_DB", "/opt/original-video-dedup-tool/server/license_server.sqlite3"
)
LICENSE_STATUS_URL = os.environ.get(
    "POR_LICENSE_STATUS_URL", "http://127.0.0.1:8791/api/license/device/status"
)
LICENSE_ACTIVATE_URL = os.environ.get(
    "POR_LICENSE_ACTIVATE_URL", "http://127.0.0.1:8791/api/license/activate"
)
LICENSE_CONSUME_URL = os.environ.get(
    "POR_LICENSE_CONSUME_URL", "http://127.0.0.1:8791/api/license/credits/consume"
)
PROVIDER_BASE_URL = os.environ.get("POR_PROVIDER_BASE_URL", "https://ccg-cli.online/v1").rstrip("/")
PROVIDER_API_KEY = os.environ.get("POR_PROVIDER_API_KEY", "").strip()
PROVIDER_KEYS_FILE = os.environ.get(
    "POR_PROVIDER_KEYS_FILE", "/etc/product-operation-report/provider-keys.json"
).strip()
SESSION_TTL_SECONDS = max(120, min(3600, int(os.environ.get("POR_SESSION_TTL_SECONDS", "900"))))
DAILY_COST_LIMIT_CNY = max(1.0, float(os.environ.get("POR_DAILY_COST_LIMIT_CNY", "100")))
USD_CNY_RATE = max(1.0, float(os.environ.get("POR_USD_CNY_RATE", "7.2")))
POINTS_PER_CNY = max(1.0, float(os.environ.get("POR_POINTS_PER_CNY", "100")))
COST_RATE = max(0.01, min(1.0, float(os.environ.get("POR_COST_RATE", "0.5"))))
CHARGE_MULTIPLIER = 1.0 / COST_RATE
MAX_BODY_BYTES = 96 * 1024 * 1024
MAX_MESSAGES = 64
MAX_TEXT_CHARS = 2_000_000
MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_ACTIVE_PER_LICENSE = 4
MAX_OUTPUT_TOKENS = max(1024, min(32768, int(os.environ.get("POR_MAX_OUTPUT_TOKENS", "6000"))))
TASK_OUTPUT_RESERVES = {
    "source_clean": 2_500,
    "summary": 3_500,
    "analysis_step": 4_000,
    "final_part": MAX_OUTPUT_TOKENS,
    "revision_part": MAX_OUTPUT_TOKENS,
}
REQUEST_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?::fallback:[1-3])?$", re.I)
SAFE_TEXT_RE = re.compile(r"^[\w.:-]{1,200}$", re.UNICODE)
IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
ALLOWED_MODELS = ("gpt-5.5", "claude-sonnet-4-6", "gemini-3-flash", "kimi-k2.6")
ALLOWED_TASK_TYPES = ("source_clean", "summary", "analysis_step", "final_part", "revision_part")
MODEL_PRICES = {
    "gpt-5.5": (1.25, 7.5, 0.125, 0.8),
    "claude-sonnet-4-6": (0.4, 2.0, 0.04, 0.2),
    "gemini-3-flash": (1.2, 6.0, 0.12, 0.6),
    "kimi-k2.6": (0.8, 4.0, 0.08, 0.4),
}
MODEL_ENV_PREFIXES = {
    "gpt-5.5": "GPT55",
    "claude-sonnet-4-6": "CLAUDE_SONNET_46",
    "gemini-3-flash": "GEMINI_3_FLASH",
    "kimi-k2.6": "KIMI_K26",
}
PROVIDER_ROUTES = {
    model: (
        os.environ.get(f"POR_PROVIDER_{prefix}_BASE_URL", PROVIDER_BASE_URL).rstrip("/"),
        os.environ.get(f"POR_PROVIDER_{prefix}_API_KEY", PROVIDER_API_KEY).strip(),
    )
    for model, prefix in MODEL_ENV_PREFIXES.items()
}
PROVIDER_KEYRING = ProviderKeyring(PROVIDER_KEYS_FILE, PROVIDER_ROUTES, ALLOWED_MODELS)
LEGACY_NAMESPACE = "product-operation-report:activation:v1:"


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class Session:
    token_hash: str
    code_id: str
    machine_code: str
    license_id: str
    device_credential: str
    device_session: str
    expires_at: float
    unlimited: bool = False


SESSIONS: dict[str, Session] = {}
SESSION_LOCK = threading.Lock()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def utc_day() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def connection() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), mode=0o700, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=20, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA busy_timeout=20000")
    return db


@contextmanager
def database():
    db = connection()
    try:
        yield db
    finally:
        db.close()


def ensure_schema(db: sqlite3.Connection) -> None:
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS wallets (
          app_name TEXT NOT NULL,
          code_id TEXT NOT NULL,
          machine_code TEXT NOT NULL,
          balance_milli INTEGER NOT NULL,
          locked_milli INTEGER NOT NULL DEFAULT 0,
          total_topup_milli INTEGER NOT NULL DEFAULT 0,
          total_cost_milli INTEGER NOT NULL DEFAULT 0,
          total_charged_milli INTEGER NOT NULL DEFAULT 0,
          frozen INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(app_name, code_id)
        );
        CREATE TABLE IF NOT EXISTS ledger (
          event_id TEXT PRIMARY KEY,
          app_name TEXT NOT NULL,
          code_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          description TEXT NOT NULL,
          points_delta_milli INTEGER NOT NULL,
          balance_after_milli INTEGER NOT NULL,
          report_session_id TEXT,
          task_type TEXT,
          request_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_wallet ON ledger(app_name, code_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS topup_redemptions (
          app_name TEXT NOT NULL,
          topup_code_id TEXT NOT NULL,
          wallet_code_id TEXT NOT NULL,
          points_milli INTEGER NOT NULL,
          machine_code TEXT NOT NULL,
          redeemed_at TEXT NOT NULL,
          PRIMARY KEY(app_name, topup_code_id)
        );
        CREATE TABLE IF NOT EXISTS model_requests (
          request_id TEXT PRIMARY KEY,
          app_name TEXT NOT NULL,
          code_id TEXT NOT NULL,
          machine_code TEXT NOT NULL,
          report_session_id TEXT NOT NULL,
          task_key TEXT NOT NULL,
          task_type TEXT NOT NULL,
          model TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          status TEXT NOT NULL,
          reserved_milli INTEGER NOT NULL,
          input_estimate INTEGER NOT NULL DEFAULT 0,
          upstream_submitted INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cached_input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
          usage_source TEXT NOT NULL DEFAULT 'missing',
          response_model TEXT NOT NULL DEFAULT '',
          cost_cny REAL NOT NULL DEFAULT 0,
          charged_milli INTEGER NOT NULL DEFAULT 0,
          started_at TEXT NOT NULL,
          ended_at TEXT
          ,billing_request_id TEXT NOT NULL DEFAULT ''
          ,billing_result_status TEXT NOT NULL DEFAULT ''
          ,billing_error TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_requests_wallet_status
          ON model_requests(app_name, code_id, status, started_at);
        CREATE INDEX IF NOT EXISTS idx_requests_day
          ON model_requests(status, started_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_task_attempt
          ON model_requests(app_name, code_id, task_key, attempt, model);
        """
    )
    request_columns = {str(row[1]) for row in db.execute("PRAGMA table_info(model_requests)")}
    if "input_estimate" not in request_columns:
        db.execute("ALTER TABLE model_requests ADD COLUMN input_estimate INTEGER NOT NULL DEFAULT 0")
    if "upstream_submitted" not in request_columns:
        db.execute("ALTER TABLE model_requests ADD COLUMN upstream_submitted INTEGER NOT NULL DEFAULT 0")
    if "response_model" not in request_columns:
        db.execute("ALTER TABLE model_requests ADD COLUMN response_model TEXT NOT NULL DEFAULT ''")
    if "billing_request_id" not in request_columns:
        db.execute("ALTER TABLE model_requests ADD COLUMN billing_request_id TEXT NOT NULL DEFAULT ''")
    if "billing_result_status" not in request_columns:
        db.execute("ALTER TABLE model_requests ADD COLUMN billing_result_status TEXT NOT NULL DEFAULT ''")
    if "billing_error" not in request_columns:
        db.execute("ALTER TABLE model_requests ADD COLUMN billing_error TEXT NOT NULL DEFAULT ''")


def as_object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ApiError(400, "请求格式不正确。")
    return value


def text(value: Any, maximum: int = 512) -> str:
    return value.strip()[:maximum] if isinstance(value, str) and value.strip() else ""


def parse_nonnegative(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and 0 <= number <= 10_000_000 else None


LICENSE_CONTRACT_FIELDS = {
    "ok", "success", "valid", "activated", "app_name", "code_id", "license_id",
    "activation_id", "code_role", "machine_code", "bound_machine_code", "device_id",
    "binding_status", "remaining_points", "remaining_credits", "credits_remaining",
    "wallet_balance", "points_balance", "credits", "points", "initial_credits", "granted_credits",
}


def has_nested_contract_field(value: Any, depth: int = 0) -> bool:
    if depth > 6:
        return True
    if isinstance(value, dict):
        if any(key in LICENSE_CONTRACT_FIELDS for key in value):
            return True
        return any(has_nested_contract_field(child, depth + 1) for child in value.values())
    if isinstance(value, list):
        return any(has_nested_contract_field(child, depth + 1) for child in value)
    return False


def parse_license_response(
    result: dict[str, Any],
    status: int,
    expected_machine: str,
    allowed_roles: set[str],
    default_role: str = "",
) -> tuple[str, int, str]:
    forbidden_top_level_aliases = {
        "success", "valid", "activated", "license_id", "activation_id",
        "bound_machine_code", "device_id", "credits_remaining",
        "wallet_balance", "points_balance", "credits", "points", "initial_credits", "granted_credits",
    }
    if forbidden_top_level_aliases.intersection(result):
        raise ApiError(503, "授权服务器返回了非标准或冲突字段。")
    message = text(result.get("message") or result.get("error"), 240)
    if status < 200 or status >= 300:
        raise ApiError(403 if status < 500 else 503, message or "当前设备授权已失效。")
    if any(has_nested_contract_field(child) for child in result.values() if isinstance(child, (dict, list))):
        raise ApiError(503, "授权服务器返回了有歧义的嵌套字段。")
    if result.get("ok") is not True:
        raise ApiError(403, message or "授权服务器未确认本次授权。")

    binding = text(result.get("binding_status"), 32).lower()
    if binding not in {"active", "bound"}:
        raise ApiError(403, message or "当前设备授权不是可用状态。")

    response_app = text(result.get("app_name"), 80)
    if response_app != APP_NAME:
        raise ApiError(403, "授权不属于当前软件。")

    response_machine = text(result.get("machine_code"), 200)
    normalized_response_machine = response_machine.strip().lower()
    normalized_expected_machine = expected_machine.strip().lower()
    if not normalized_response_machine or not hmac.compare_digest(
        normalized_response_machine, normalized_expected_machine
    ):
        raise ApiError(403, "授权绑定的电脑不一致。")

    code_id = text(result.get("code_id"), 200)
    if not code_id:
        raise ApiError(503, "授权服务器没有返回稳定的授权标识。")

    role = text(result.get("code_role"), 40).lower() or text(default_role, 40).lower()
    if role not in allowed_roles:
        raise ApiError(403, "该激活码用途不匹配，不能在这里使用。")

    has_credits = "remaining_credits" in result
    has_legacy_points = "remaining_points" in result
    if not has_credits and not has_legacy_points:
        raise ApiError(503, "授权服务器没有返回当前剩余积分。")
    credits = parse_nonnegative(result.get("remaining_credits")) if has_credits else None
    legacy_points = parse_nonnegative(result.get("remaining_points")) if has_legacy_points else None
    if (has_credits and credits is None) or (has_legacy_points and legacy_points is None):
        raise ApiError(503, "授权服务器返回的剩余积分无效。")
    if has_credits and has_legacy_points and credits != legacy_points:
        raise ApiError(503, "授权服务器返回了相互冲突的积分余额。")
    points = credits if has_credits else legacy_points
    if points is None:
        raise ApiError(503, "授权服务器没有返回当前剩余积分。")
    return code_id, round(points * 1000), role


def verify_license(identity: dict[str, Any]) -> tuple[str, int, str, bool]:
    app_name = text(identity.get("app_name"), 80)
    machine = text(identity.get("machine_code"), 200)
    license_id = text(identity.get("license_id"), 200)
    credential = text(identity.get("device_credential"), 8192)
    device_session = text(identity.get("device_session"), 8192)
    if app_name != APP_NAME or not machine or not credential or not device_session:
        raise ApiError(401, "当前设备授权信息不完整，请重新激活。")
    status_query = urlencode({
        'app_name': APP_NAME,
        'machine_code': machine,
        'license_id': license_id,
        'software_version': 'proxy',
        'platform': 'server-proxy',
    })
    status_url = f"{LICENSE_STATUS_URL}?{status_query}"
    request = Request(
        status_url, method="GET",
        headers={"Accept": "application/json",
                 "Authorization": f"Bearer {device_session}", "X-Device-Credential": credential},
    )
    try:
        with urlopen(request, timeout=12) as response:
            raw = response.read(64 * 1024)
            status = int(response.status)
    except HTTPError as error:
        raw = error.read(64 * 1024)
        status = int(error.code)
    except (URLError, TimeoutError, OSError) as error:
        raise ApiError(503, "授权服务器暂时不可用，请稍后重试。") from error
    try:
        result = as_object(json.loads(raw.decode("utf-8", "replace")))
    except Exception as error:
        raise ApiError(503, "授权服务器返回异常，请联系管理员。") from error
    # /device/status is authenticated by the device session and credential. The
    # current license service only returns primary device records from this
    # endpoint, so use primary as the compatibility default when code_role is
    # absent. Activation/redeem responses still have to provide an explicit role.
    code_id, remaining_milli, role = parse_license_response(
        result, status, machine, {"primary", "legacy_manual"}, default_role="primary"
    )
    unlimited = result.get("unlimited", False)
    if not isinstance(unlimited, bool):
        raise ApiError(503, "授权服务器返回的无限授权状态无效。")
    return code_id, remaining_milli, role, unlimited


def sync_authoritative_wallet(session: Session, balance_milli: int) -> None:
    """Mirror the license balance without treating a refresh as a top-up."""
    with database() as db:
        ensure_schema(db)
        now = utc_now()
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT machine_code FROM wallets WHERE app_name=? AND code_id=?", (APP_NAME, session.code_id)
        ).fetchone()
        if row is None:
            db.execute(
                "INSERT INTO wallets(app_name,code_id,machine_code,balance_milli,total_topup_milli,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                (APP_NAME, session.code_id, session.machine_code, balance_milli, balance_milli, now, now),
            )
        else:
            db.execute(
                "UPDATE wallets SET machine_code=?,balance_milli=?,updated_at=? WHERE app_name=? AND code_id=?",
                (session.machine_code, balance_milli, now, APP_NAME, session.code_id),
            )
        db.execute("COMMIT")


def create_session(payload: dict[str, Any]) -> tuple[str, Session]:
    code_id, authoritative_milli, _, unlimited = verify_license(payload)
    machine = text(payload.get("machine_code"), 200)
    raw_token = secrets.token_urlsafe(48)
    token_hash = hashlib.sha256(raw_token.encode("ascii")).hexdigest()
    session = Session(
        token_hash=token_hash, code_id=code_id, machine_code=machine,
        license_id=text(payload.get("license_id"), 200),
        device_credential=text(payload.get("device_credential"), 8192),
        device_session=text(payload.get("device_session"), 8192),
        expires_at=time.time() + SESSION_TTL_SECONDS,
        unlimited=unlimited,
    )
    with database() as db:
        ensure_schema(db)
        now = utc_now()
        db.execute("BEGIN IMMEDIATE")
        topup = db.execute(
            "SELECT wallet_code_id FROM topup_redemptions WHERE app_name=? AND topup_code_id=?",
            (APP_NAME, code_id),
        ).fetchone()
        if topup:
            db.execute("ROLLBACK")
            raise ApiError(403, "这个积分码已经作为充值码使用，不能再激活软件。")
        row = db.execute(
            "SELECT machine_code FROM wallets WHERE app_name=? AND code_id=?", (APP_NAME, code_id)
        ).fetchone()
        if row is None:
            db.execute(
                "INSERT INTO wallets(app_name,code_id,machine_code,balance_milli,total_topup_milli,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                (APP_NAME, code_id, machine, authoritative_milli, authoritative_milli, now, now),
            )
            if authoritative_milli:
                db.execute(
                    "INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (str(uuid.uuid4()), APP_NAME, code_id, "topup", "激活码初始积分", authoritative_milli,
                     authoritative_milli, None, None, None, now),
                )
        else:
            # The license service owns both rebind state and the current balance.
            # A refresh is a mirror update, never a new grant or ledger top-up.
            db.execute(
                "UPDATE wallets SET machine_code=?,balance_milli=?,updated_at=? WHERE app_name=? AND code_id=?",
                (machine, authoritative_milli, now, APP_NAME, code_id),
            )
        db.execute("COMMIT")
    with SESSION_LOCK:
        now_ts = time.time()
        for key in [key for key, value in SESSIONS.items() if value.expires_at <= now_ts]:
            SESSIONS.pop(key, None)
        SESSIONS[token_hash] = session
    return raw_token, session


def require_session(headers: Any, verify: bool = False) -> Session:
    authorization = headers.get("authorization", "")
    if not authorization.lower().startswith("bearer "):
        raise ApiError(401, "缺少业务会话，请重新打开软件。")
    raw_token = authorization[7:].strip()
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    with SESSION_LOCK:
        session = SESSIONS.get(token_hash)
    if not session or session.expires_at <= time.time():
        raise ApiError(401, "业务会话已过期，软件将自动重新连接。")
    with database() as db:
        ensure_schema(db)
        if db.execute(
            "SELECT 1 FROM topup_redemptions WHERE app_name=? AND topup_code_id=?",
            (APP_NAME, session.code_id),
        ).fetchone():
            raise ApiError(403, "这个积分码已经作为充值码使用，不能作为软件授权。")
        wallet = db.execute(
            "SELECT machine_code,frozen FROM wallets WHERE app_name=? AND code_id=?",
            (APP_NAME, session.code_id),
        ).fetchone()
        if not wallet or wallet["frozen"] or not hmac.compare_digest(str(wallet["machine_code"]), session.machine_code):
            raise ApiError(403, "当前电脑已不再持有这份授权，请重新激活。")
    if verify:
        code_id, authoritative_milli, _, unlimited = verify_license({
            "app_name": APP_NAME, "machine_code": session.machine_code,
            "license_id": session.license_id, "device_credential": session.device_credential,
            "device_session": session.device_session,
        })
        if not hmac.compare_digest(code_id, session.code_id):
            raise ApiError(403, "授权标识已变化，请重新激活。")
        session.unlimited = unlimited
        sync_authoritative_wallet(session, authoritative_milli)
        retry_pending_billing(session)
    return session


def milli_to_points(value: int) -> float | int:
    return value // 1000 if value % 1000 == 0 else round(value / 1000, 3)


def billing_consume_request_id(billing_request_id: str) -> str:
    value = text(billing_request_id, 240)
    if not value or not SAFE_TEXT_RE.fullmatch(value):
        raise ApiError(400, "模型计费任务标识无效。")
    return "por-" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def consume_authoritative_credits(
    session: Session, amount_milli: int, billing_request_id: str, reason: str
) -> tuple[int, bool]:
    if amount_milli <= 0:
        _, remaining_milli, _, unlimited = verify_license({
            "app_name": APP_NAME,
            "machine_code": session.machine_code,
            "license_id": session.license_id,
            "device_credential": session.device_credential,
            "device_session": session.device_session,
        })
        return remaining_milli, unlimited
    payload = json.dumps({
        "license_protocol_version": 2,
        "app_name": APP_NAME,
        "amount": milli_to_points(amount_milli),
        "reason": text(reason, 120) or "product_operation_report",
        "request_id": billing_consume_request_id(billing_request_id),
        "client_version": "proxy",
    }, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = Request(
        LICENSE_CONSUME_URL,
        data=payload,
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {session.device_session}",
            "X-Device-Credential": session.device_credential,
        },
    )
    try:
        with urlopen(request, timeout=15) as response:
            raw = response.read(64 * 1024)
            status = int(response.status)
    except HTTPError as error:
        raw = error.read(64 * 1024)
        status = int(error.code)
    except (URLError, TimeoutError, OSError) as error:
        raise ApiError(503, "积分结算服务器暂时不可用，本次任务已进入待结算状态。") from error
    try:
        result = as_object(json.loads(raw.decode("utf-8", "replace")))
    except Exception as error:
        raise ApiError(503, "积分结算服务器返回异常，本次任务已进入待结算状态。") from error
    if status < 200 or status >= 300 or result.get("ok") is not True:
        message = text(result.get("message") or result.get("error"), 300)
        raise ApiError(status if status >= 400 else 503, message or "积分结算失败，本次任务已进入待结算状态。")
    response_app = text(result.get("app_name"), 80)
    if response_app and response_app != APP_NAME:
        raise ApiError(503, "积分结算响应的软件标识不匹配。")
    response_code_id = text(result.get("code_id"), 200)
    if response_code_id and not hmac.compare_digest(response_code_id, session.code_id):
        raise ApiError(503, "积分结算响应的授权标识不匹配。")
    if "remaining_credits" not in result:
        raise ApiError(503, "积分结算响应缺少当前剩余积分。")
    remaining = parse_nonnegative(result.get("remaining_credits"))
    unlimited = result.get("unlimited", False)
    if remaining is None or not isinstance(unlimited, bool):
        raise ApiError(503, "积分结算响应格式无效。")
    return round(remaining * 1000), unlimited


def pricing(model: str = "gpt-5.5") -> dict[str, Any]:
    values = MODEL_PRICES.get(model, MODEL_PRICES["gpt-5.5"])
    return {
        "model": model, "currency": "USD", "inputUsdPerMillion": values[0],
        "outputUsdPerMillion": values[1], "cachedInputUsdPerMillion": values[2],
        "cacheCreationUsdPerMillion": values[3], "usdCnyRate": USD_CNY_RATE,
        "pointsPerCny": POINTS_PER_CNY, "cnyPerCostPoint": 1 / POINTS_PER_CNY,
        "costRate": COST_RATE, "chargeMultiplier": CHARGE_MULTIPLIER,
    }


def wallet_json(session: Session, db: sqlite3.Connection) -> dict[str, Any]:
    row = db.execute(
        "SELECT * FROM wallets WHERE app_name=? AND code_id=?", (APP_NAME, session.code_id)
    ).fetchone()
    if row is None:
        raise ApiError(404, "积分账户尚未建立，请重新激活。")
    ledger_rows = db.execute(
        "SELECT * FROM ledger WHERE app_name=? AND code_id=? ORDER BY created_at DESC LIMIT 100",
        (APP_NAME, session.code_id),
    ).fetchall()
    return {
        "balancePoints": milli_to_points(row["balance_milli"]),
        "unlimited": session.unlimited,
        "totalTopupPoints": milli_to_points(row["total_topup_milli"]),
        "totalCostPoints": milli_to_points(row["total_cost_milli"]),
        "totalChargedPoints": milli_to_points(row["total_charged_milli"]),
        "unbilledUsageCount": 0,
        "pricing": pricing(),
        "ledger": [{
            "id": item["event_id"], "createdAt": item["created_at"], "kind": item["kind"],
            "description": item["description"], "pointsDelta": milli_to_points(item["points_delta_milli"]),
            "balanceAfter": milli_to_points(item["balance_after_milli"]),
            "reportSessionId": item["report_session_id"], "taskType": item["task_type"],
        } for item in ledger_rows],
    }


def normalize_code(value: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", value.upper())


def code_hash_candidates(code: str) -> set[str]:
    normalized = normalize_code(code)
    values = {code, code.strip(), code.upper(), normalized}
    hashes = {hashlib.sha256(value.encode()).hexdigest() for value in values if value}
    if normalized:
        hashes.add(hashlib.sha256((LEGACY_NAMESPACE + normalized).encode()).hexdigest())
    return hashes


def table_columns(db: sqlite3.Connection, table: str) -> set[str]:
    if not IDENTIFIER_RE.fullmatch(table):
        raise ApiError(500, "授权数据表配置无效。")
    return {str(row[1]) for row in db.execute(f'PRAGMA table_info("{table}")')}


def resolve_topup_code(code: str, machine_code: str) -> tuple[str, int]:
    body = json.dumps({
        "app_name": APP_NAME,
        "activation_code": code,
        "code": code,
        "machine_code": machine_code,
        "machine_id": machine_code,
        "software_version": "points-topup-v1",
        "platform": "server-proxy",
    }, ensure_ascii=False).encode("utf-8")
    request = Request(
        LICENSE_ACTIVATE_URL, data=body, method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urlopen(request, timeout=12) as response:
            raw = response.read(64 * 1024)
            status = int(response.status)
    except HTTPError as error:
        raw = error.read(64 * 1024)
        status = int(error.code)
    except (URLError, TimeoutError, OSError) as error:
        raise ApiError(503, "授权服务器暂时不可用，积分没有入账。") from error
    try:
        result = as_object(json.loads(raw.decode("utf-8", "replace")))
    except Exception as error:
        raise ApiError(503, "授权服务器返回异常，积分没有入账。") from error
    code_id, points_milli, _ = parse_license_response(
        result, status, machine_code, {"auto_topup"}
    )
    if points_milli <= 0:
        raise ApiError(400, "这个码没有可充值的积分。")
    return code_id, points_milli


def redeem_points(session: Session, code: str) -> tuple[int, dict[str, Any]]:
    code_id, points_milli = resolve_topup_code(code, session.machine_code)
    if hmac.compare_digest(code_id, session.code_id):
        raise ApiError(400, "当前主激活码不能作为积分码重复充值。")
    with database() as db:
        ensure_schema(db)
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute(
            "SELECT wallet_code_id FROM topup_redemptions WHERE app_name=? AND topup_code_id=?",
            (APP_NAME, code_id),
        ).fetchone()
        if existing:
            db.execute("ROLLBACK")
            raise ApiError(409, "这个积分码已经充值过，积分没有重复增加。")
        wallet = db.execute(
            "SELECT * FROM wallets WHERE app_name=? AND code_id=?", (APP_NAME, session.code_id)
        ).fetchone()
        if not wallet or wallet["machine_code"] != session.machine_code:
            db.execute("ROLLBACK")
            raise ApiError(403, "积分账户与当前电脑不匹配。")
        if db.execute(
            "SELECT 1 FROM wallets WHERE app_name=? AND code_id=?",
            (APP_NAME, code_id),
        ).fetchone():
            db.execute("ROLLBACK")
            raise ApiError(409, "这个码已经作为软件主激活码使用，不能再作为充值码。")
        balance = wallet["balance_milli"] + points_milli
        now = utc_now()
        db.execute(
            "INSERT INTO topup_redemptions VALUES(?,?,?,?,?,?)",
            (APP_NAME, code_id, session.code_id, points_milli, session.machine_code, now),
        )
        db.execute(
            "UPDATE wallets SET balance_milli=?,total_topup_milli=total_topup_milli+?,updated_at=? WHERE app_name=? AND code_id=?",
            (balance, points_milli, now, APP_NAME, session.code_id),
        )
        db.execute(
            "INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (str(uuid.uuid4()), APP_NAME, session.code_id, "topup", "积分码充值", points_milli,
             balance, None, None, None, now),
        )
        db.execute("COMMIT")
        return points_milli, wallet_json(session, db)


def validate_messages(body: dict[str, Any]) -> tuple[str, int]:
    model = text(body.get("model"), 200)
    if model not in ALLOWED_MODELS:
        raise ApiError(400, "模型不在服务器允许列表中。")
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages or len(messages) > MAX_MESSAGES:
        raise ApiError(400, "模型消息数量异常。")
    approximate_tokens = 0
    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in ("system", "user", "assistant"):
            raise ApiError(400, "模型消息格式无效。")
        content = message.get("content")
        parts = [{"type": "text", "text": content}] if isinstance(content, str) else content
        if not isinstance(parts, list) or len(parts) > 128:
            raise ApiError(400, "模型消息内容格式无效。")
        for part in parts:
            if not isinstance(part, dict):
                raise ApiError(400, "模型消息内容格式无效。")
            if part.get("type") == "text" and isinstance(part.get("text"), str):
                value = part["text"]
                if len(value) > MAX_TEXT_CHARS:
                    raise ApiError(413, "模型输入内容过大。")
                approximate_tokens += math.ceil(len(value.encode("utf-8")) / 3)
            elif part.get("type") in ("image_url", "image"):
                image_value = part.get("image_url")
                if isinstance(image_value, dict):
                    image_value = image_value.get("url")
                if not isinstance(image_value, str) or not image_value.startswith("data:image/"):
                    raise ApiError(400, "只允许软件上传的内嵌图片。")
                try:
                    encoded = image_value.split(",", 1)[1]
                    image_size = len(base64.b64decode(encoded, validate=True))
                except Exception as error:
                    raise ApiError(400, "图片内容损坏。") from error
                if image_size <= 0 or image_size > MAX_IMAGE_BYTES:
                    raise ApiError(413, "单张图片过大。")
                approximate_tokens += math.ceil(image_size / 64)
            else:
                raise ApiError(400, "模型消息内容格式无效。")
    return model, approximate_tokens


def points_for_usage(model: str, input_tokens: int, output_tokens: int, cached: int = 0, created: int = 0) -> tuple[int, float]:
    input_rate, output_rate, cached_rate, created_rate = MODEL_PRICES[model]
    regular = max(0, input_tokens - cached - created)
    usd = (regular * input_rate + cached * cached_rate + created * created_rate + output_tokens * output_rate) / 1_000_000
    cost_cny = usd * USD_CNY_RATE
    charged_milli = math.ceil(cost_cny * POINTS_PER_CNY * CHARGE_MULTIPLIER * 1000)
    return max(0, charged_milli), max(0.0, cost_cny)


def provider_route(model: str) -> tuple[str, str]:
    if model not in ALLOWED_MODELS:
        raise ApiError(400, "模型不在服务器允许列表中。")
    route = PROVIDER_KEYRING.active(model)
    return (route.base_url, route.api_key) if route else ("", "")


def provider_route_candidates(model: str) -> tuple[ProviderRouteSnapshot, ...]:
    if model not in ALLOWED_MODELS:
        raise ApiError(400, "模型不在服务器允许列表中。")
    return PROVIDER_KEYRING.candidates(model)


def open_provider_stream(
    candidates: tuple[ProviderRouteSnapshot, ...], upstream_data: bytes, request_id: str
) -> Any:
    """Open one upstream stream, using standby keys only for pre-stream auth failures."""
    last_auth_error: HTTPError | None = None
    for candidate_index, candidate in enumerate(candidates):
        request = Request(
            f"{candidate.base_url}/chat/completions",
            data=upstream_data,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
                "Authorization": f"Bearer {candidate.api_key}",
                "X-Request-Id": request_id,
            },
        )
        try:
            return urlopen(request, timeout=300)
        except HTTPError as error:
            # Authentication rejection occurs before any successful response body
            # is streamed. Other errors are never retried with a second secret.
            if error.code in (401, 403) and candidate_index + 1 < len(candidates):
                error.read(16 * 1024)
                last_auth_error = error
                continue
            raise
    raise last_auth_error or OSError("no provider route available")


def points_for_verified_usage(requested_model: str, response_model: str | None, input_tokens: int,
                              output_tokens: int, cached: int = 0, created: int = 0) -> tuple[int, float]:
    requested = points_for_usage(requested_model, input_tokens, output_tokens, cached, created)
    actual_name = (response_model or "").strip()
    if not actual_name or actual_name == requested_model:
        return requested
    if actual_name not in MODEL_PRICES:
        return max(
            (points_for_usage(candidate, input_tokens, output_tokens, cached, created) for candidate in MODEL_PRICES),
            key=lambda item: item[0],
        )
    actual = points_for_usage(actual_name, input_tokens, output_tokens, cached, created)
    return actual if actual[0] > requested[0] else requested


def reserve_request(session: Session, request_id: str, report_id: str, task_key: str, task_type: str,
                    model: str, attempt: int, input_estimate: int, billing_request_id: str = "") -> int:
    output_reserve = min(MAX_OUTPUT_TOKENS, TASK_OUTPUT_RESERVES.get(task_type, MAX_OUTPUT_TOKENS))
    reserve_candidates = [points_for_usage(candidate, input_estimate, output_reserve) for candidate in MODEL_PRICES]
    reserve, reserve_cost_cny = max(reserve_candidates, key=lambda item: item[0])
    with database() as db:
        ensure_schema(db)
        db.execute("BEGIN IMMEDIATE")
        if db.execute("SELECT 1 FROM model_requests WHERE request_id=?", (request_id,)).fetchone():
            db.execute("ROLLBACK")
            raise ApiError(409, "检测到重复模型请求，已阻止重复扣费。")
        active = db.execute(
            "SELECT report_session_id FROM model_requests WHERE app_name=? AND code_id=? AND status='running'",
            (APP_NAME, session.code_id),
        ).fetchall()
        if len(active) >= MAX_ACTIVE_PER_LICENSE or any(row[0] != report_id for row in active):
            db.execute("ROLLBACK")
            raise ApiError(429, "当前已有报告正在生成，请等待完成后再试。")
        day_cost = db.execute(
            "SELECT COALESCE(SUM(cost_cny),0) FROM model_requests WHERE status IN ('success','partial','aborted') AND started_at>=?",
            (f"{utc_day()}T00:00:00Z",),
        ).fetchone()[0]
        running_reserved_milli = db.execute(
            "SELECT COALESCE(SUM(reserved_milli),0) FROM model_requests WHERE status='running'"
        ).fetchone()[0]
        running_reserved_cost = float(running_reserved_milli) / (POINTS_PER_CNY * CHARGE_MULTIPLIER * 1000)
        if float(day_cost) + running_reserved_cost + reserve_cost_cny > DAILY_COST_LIMIT_CNY:
            db.execute("ROLLBACK")
            raise ApiError(503, "今日模型费用已达到安全上限，请联系管理员。")
        wallet = db.execute(
            "SELECT * FROM wallets WHERE app_name=? AND code_id=?", (APP_NAME, session.code_id)
        ).fetchone()
        if not wallet or wallet["frozen"] or wallet["machine_code"] != session.machine_code:
            db.execute("ROLLBACK")
            raise ApiError(403, "积分账户不可用，请重新登录或联系管理员。")
        available = wallet["balance_milli"] - wallet["locked_milli"]
        if reserve <= 0 or (not session.unlimited and available < reserve):
            db.execute("ROLLBACK")
            raise ApiError(
                402,
                "积分不足：当前可用 "
                f"{milli_to_points(max(0, available))} 积分，本批最多需要暂时预留 "
                f"{milli_to_points(reserve)} 积分。系统尚未扣费。",
            )
        now = utc_now()
        db.execute(
            "UPDATE wallets SET locked_milli=locked_milli+?,updated_at=? WHERE app_name=? AND code_id=?",
            (reserve, now, APP_NAME, session.code_id),
        )
        db.execute(
            "INSERT INTO model_requests(request_id,app_name,code_id,machine_code,report_session_id,task_key,task_type,model,attempt,status,reserved_milli,input_estimate,started_at,billing_request_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (request_id, APP_NAME, session.code_id, session.machine_code, report_id, task_key, task_type,
             model, attempt, "running", reserve, input_estimate, now, billing_request_id or request_id),
        )
        db.execute("COMMIT")
    return reserve


def finalize_billing_request(
    session: Session, request_id: str, remaining_milli: int, unlimited: bool
) -> None:
    with database() as db:
        ensure_schema(db)
        db.execute("BEGIN IMMEDIATE")
        request_row = db.execute("SELECT * FROM model_requests WHERE request_id=?", (request_id,)).fetchone()
        if not request_row or request_row["status"] != "billing_pending":
            db.execute("ROLLBACK")
            return
        wallet = db.execute(
            "SELECT * FROM wallets WHERE app_name=? AND code_id=?", (APP_NAME, session.code_id)
        ).fetchone()
        if not wallet:
            db.execute("ROLLBACK")
            raise ApiError(403, "积分账户不可用，请重新登录或联系管理员。")
        actual_charge = 0 if unlimited else max(0, int(request_row["charged_milli"]))
        locked = max(0, int(wallet["locked_milli"]) - int(request_row["reserved_milli"]))
        now = utc_now()
        db.execute(
            "UPDATE wallets SET balance_milli=?,locked_milli=?,total_cost_milli=total_cost_milli+?,total_charged_milli=total_charged_milli+?,updated_at=? WHERE app_name=? AND code_id=?",
            (remaining_milli, locked, math.ceil(float(request_row["cost_cny"]) * POINTS_PER_CNY * 1000),
             actual_charge, now, APP_NAME, session.code_id),
        )
        if actual_charge:
            task_descriptions = {
                "source_clean": "资料清洗",
                "summary": "资料汇总",
                "analysis_step": "分析步骤",
                "final_part": "最终成稿",
                "revision_part": "报告修订",
            }
            db.execute(
                "INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (str(uuid.uuid4()), APP_NAME, session.code_id, "usage",
                 task_descriptions.get(request_row["task_type"], "报告修订"), -actual_charge,
                 remaining_milli, request_row["report_session_id"], request_row["task_type"], request_id, now),
            )
        db.execute(
            "UPDATE model_requests SET status=?,charged_milli=?,billing_error='',ended_at=? WHERE request_id=?",
            (request_row["billing_result_status"] or "success", actual_charge, now, request_id),
        )
        db.execute("COMMIT")
    session.unlimited = unlimited


def record_billing_error(request_id: str, message: str) -> None:
    with database() as db:
        ensure_schema(db)
        db.execute(
            "UPDATE model_requests SET billing_error=? WHERE request_id=? AND status='billing_pending'",
            (text(message, 300), request_id),
        )


def retry_pending_billing(session: Session) -> None:
    with database() as db:
        ensure_schema(db)
        pending = db.execute(
            "SELECT request_id,charged_milli,billing_request_id,task_type FROM model_requests "
            "WHERE app_name=? AND code_id=? AND status='billing_pending' ORDER BY started_at",
            (APP_NAME, session.code_id),
        ).fetchall()
    for row in pending:
        try:
            remaining, unlimited = consume_authoritative_credits(
                session,
                int(row["charged_milli"]),
                row["billing_request_id"] or row["request_id"],
                f"product_operation_report:{row['task_type']}",
            )
        except ApiError as error:
            record_billing_error(row["request_id"], error.message)
            raise
        finalize_billing_request(session, row["request_id"], remaining, unlimited)


def settle_request(session: Session, request_id: str, status: str, model: str, usage: dict[str, Any] | None,
                   input_estimate: int, output_chars: int, sent_content: bool) -> None:
    if usage:
        input_tokens = max(0, int(usage.get("input_tokens", 0)))
        output_tokens = max(0, int(usage.get("output_tokens", 0)))
        cached = max(0, min(input_tokens, int(usage.get("cached_input_tokens", 0))))
        created = max(0, min(input_tokens - cached, int(usage.get("cache_creation_input_tokens", 0))))
        usage_source = "provider"
    elif sent_content:
        input_tokens, output_tokens, cached, created = input_estimate, math.ceil(output_chars / 3), 0, 0
        usage_source = "estimated"
    else:
        input_tokens = output_tokens = cached = created = 0
        usage_source = "missing"
    response_model = text(usage.get("response_model"), 200) if usage else ""
    charged, cost_cny = points_for_verified_usage(
        model, response_model, input_tokens, output_tokens, cached, created
    )
    if not sent_content and not usage:
        charged = 0
        cost_cny = 0
    billing_request_id = request_id
    task_type = "model"
    with database() as db:
        ensure_schema(db)
        db.execute("BEGIN IMMEDIATE")
        request_row = db.execute("SELECT * FROM model_requests WHERE request_id=?", (request_id,)).fetchone()
        if not request_row or request_row["status"] != "running":
            db.execute("ROLLBACK")
            return
        wallet = db.execute(
            "SELECT * FROM wallets WHERE app_name=? AND code_id=?", (APP_NAME, session.code_id)
        ).fetchone()
        if not wallet:
            db.execute("ROLLBACK")
            raise ApiError(403, "积分账户不可用，请重新登录或联系管理员。")
        # The reserve uses the most expensive allowed model and the enforced output cap.
        charged = min(charged, request_row["reserved_milli"])
        now = utc_now()
        billing_request_id = request_row["billing_request_id"] or request_id
        task_type = request_row["task_type"]
        if charged <= 0:
            locked = max(0, wallet["locked_milli"] - request_row["reserved_milli"])
            db.execute(
                "UPDATE wallets SET locked_milli=?,updated_at=? WHERE app_name=? AND code_id=?",
                (locked, now, APP_NAME, session.code_id),
            )
            db.execute(
                "UPDATE model_requests SET status=?,input_tokens=?,output_tokens=?,cached_input_tokens=?,cache_creation_input_tokens=?,usage_source=?,response_model=?,cost_cny=0,charged_milli=0,billing_result_status=?,billing_error='',ended_at=? WHERE request_id=?",
                (status, input_tokens, output_tokens, cached, created, usage_source, response_model,
                 status, now, request_id),
            )
            db.execute("COMMIT")
            return
        db.execute(
            "UPDATE model_requests SET status='billing_pending',input_tokens=?,output_tokens=?,cached_input_tokens=?,cache_creation_input_tokens=?,usage_source=?,response_model=?,cost_cny=?,charged_milli=?,billing_result_status=?,billing_error='',ended_at=? WHERE request_id=?",
            (input_tokens, output_tokens, cached, created, usage_source, response_model, cost_cny,
             charged, status, now, request_id),
        )
        db.execute("COMMIT")
    try:
        remaining, unlimited = consume_authoritative_credits(
            session,
            charged,
            billing_request_id,
            f"product_operation_report:{task_type}",
        )
    except ApiError as error:
        record_billing_error(request_id, error.message)
        return
    finalize_billing_request(session, request_id, remaining, unlimited)


def provider_usage(payload: dict[str, Any]) -> dict[str, Any] | None:
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return None
    details = usage.get("prompt_tokens_details") if isinstance(usage.get("prompt_tokens_details"), dict) else {}
    def usage_integer(value: Any) -> int | None:
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    input_tokens = usage_integer(usage.get("prompt_tokens", usage.get("input_tokens", 0)))
    output_tokens = usage_integer(usage.get("completion_tokens", usage.get("output_tokens", 0)))
    cached_tokens = usage_integer(details.get("cached_tokens", usage.get("cached_input_tokens", 0)))
    created_tokens = usage_integer(usage.get("cache_creation_input_tokens", 0))
    if None in (input_tokens, output_tokens, cached_tokens, created_tokens):
        return None
    result = {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cached_input_tokens": cached_tokens,
        "cache_creation_input_tokens": created_tokens,
        "response_model": text(payload.get("model"), 200),
    }
    if any(result[name] < 0 or result[name] > 2_000_000_000 for name in (
        "input_tokens", "output_tokens", "cached_input_tokens", "cache_creation_input_tokens"
    )):
        return None
    if result["input_tokens"] + result["output_tokens"] <= 0:
        return None
    if result["cached_input_tokens"] + result["cache_creation_input_tokens"] > result["input_tokens"]:
        return None
    if "total_tokens" in usage:
        total_tokens = usage_integer(usage.get("total_tokens"))
        if total_tokens != result["input_tokens"] + result["output_tokens"]:
            return None
    return result


def merge_provider_usage(previous: dict[str, Any] | None, current: dict[str, Any] | None) -> dict[str, Any] | None:
    if current is None:
        return previous
    if previous is None:
        return current
    input_tokens = max(previous["input_tokens"], current["input_tokens"])
    cached = min(input_tokens, max(previous["cached_input_tokens"], current["cached_input_tokens"]))
    created = min(
        input_tokens - cached,
        max(previous["cache_creation_input_tokens"], current["cache_creation_input_tokens"]),
    )
    return {
        "input_tokens": input_tokens,
        "output_tokens": max(previous["output_tokens"], current["output_tokens"]),
        "cached_input_tokens": cached,
        "cache_creation_input_tokens": created,
        "response_model": current.get("response_model") or previous.get("response_model") or "",
    }


def mark_upstream_submitted(request_id: str) -> None:
    with database() as db:
        ensure_schema(db)
        db.execute(
            "UPDATE model_requests SET upstream_submitted=1 WHERE request_id=? AND status='running'",
            (request_id,),
        )


def recover_interrupted_requests() -> None:
    with database() as db:
        ensure_schema(db)
        stale = db.execute("SELECT * FROM model_requests WHERE status='running'").fetchall()
        for row in stale:
            db.execute("BEGIN IMMEDIATE")
            wallet = db.execute(
                "SELECT * FROM wallets WHERE app_name=? AND code_id=?", (row["app_name"], row["code_id"])
            ).fetchone()
            if not wallet:
                db.execute(
                    "UPDATE model_requests SET status='interrupted_orphaned',ended_at=? WHERE request_id=?",
                    (utc_now(), row["request_id"]),
                )
                db.execute("COMMIT")
                continue
            charged = 0
            cost_cny = 0.0
            usage_source = "missing"
            if row["upstream_submitted"]:
                charged, cost_cny = points_for_usage(row["model"], max(0, row["input_estimate"]), 0)
                charged = min(charged, row["reserved_milli"])
                usage_source = "estimated"
            now = utc_now()
            if charged:
                db.execute(
                    "UPDATE model_requests SET status='billing_pending',input_tokens=?,usage_source=?,cost_cny=?,charged_milli=?,billing_result_status='interrupted_estimated',billing_error=?,ended_at=? WHERE request_id=?",
                    (max(0, row["input_estimate"]), usage_source, cost_cny, charged,
                     "等待设备重新连接后完成保守结算。", now, row["request_id"]),
                )
            else:
                locked = max(0, wallet["locked_milli"] - row["reserved_milli"])
                db.execute(
                    "UPDATE wallets SET locked_milli=?,updated_at=? WHERE app_name=? AND code_id=?",
                    (locked, now, row["app_name"], row["code_id"]),
                )
                db.execute(
                    "UPDATE model_requests SET status='interrupted',usage_source='missing',charged_milli=0,billing_result_status='interrupted',billing_error='',ended_at=? WHERE request_id=?",
                    (now, row["request_id"]),
                )
            db.execute("COMMIT")


class Handler(BaseHTTPRequestHandler):
    server_version = "ProductOperationReportProxy/1"

    def log_message(self, fmt: str, *args: Any) -> None:
        # Never log bodies, authorization headers, prompts, or provider replies.
        print(f"{self.address_string()} - {fmt % args}", flush=True)

    def json_response(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError as error:
            raise ApiError(400, "请求长度无效。") from error
        if length <= 0 or length > MAX_BODY_BYTES:
            raise ApiError(413, "请求内容过大或为空。")
        try:
            return as_object(json.loads(self.rfile.read(length).decode("utf-8")))
        except ApiError:
            raise
        except Exception as error:
            raise ApiError(400, "请求 JSON 格式不正确。") from error

    def do_GET(self) -> None:  # noqa: N802
        try:
            path = self.path.split("?", 1)[0].rstrip("/") or "/"
            if path == "/health":
                self.json_response(200, {
                    "ok": True,
                    "service": "product-operation-report",
                    "models": list(ALLOWED_MODELS),
                    "provider_keyring": PROVIDER_KEYRING.health(),
                })
                return
            if path == "/wallet":
                session = require_session(self.headers)
                with database() as db:
                    ensure_schema(db)
                    self.json_response(200, {"ok": True, "wallet": wallet_json(session, db)})
                return
            raise ApiError(404, "unknown endpoint")
        except ApiError as error:
            self.json_response(error.status, {"ok": False, "message": error.message})
        except Exception:
            self.json_response(500, {"ok": False, "message": "服务器内部错误。"})

    def do_POST(self) -> None:  # noqa: N802
        try:
            path = self.path.split("?", 1)[0].rstrip("/") or "/"
            if path == "/session":
                token, _session = create_session(self.read_json())
                self.json_response(200, {"ok": True, "access_token": token, "expires_in": SESSION_TTL_SECONDS})
                return
            if path == "/wallet/redeem":
                session = require_session(self.headers, verify=True)
                payload = self.read_json()
                code = text(payload.get("activation_code"), 512)
                if not code:
                    raise ApiError(400, "请输入积分充值码。")
                added, wallet = redeem_points(session, code)
                self.json_response(200, {"ok": True, "message": "积分充值成功。", "added_points": milli_to_points(added), "wallet": wallet})
                return
            if path == "/chat/completions":
                self.proxy_chat()
                return
            raise ApiError(404, "unknown endpoint")
        except ApiError as error:
            self.json_response(error.status, {"ok": False, "message": error.message})
        except Exception:
            self.json_response(500, {"ok": False, "message": "服务器内部错误。"})

    def proxy_chat(self) -> None:
        session = require_session(self.headers, verify=True)
        body = self.read_json()
        model, input_estimate = validate_messages(body)
        provider_candidates = provider_route_candidates(model)
        if not provider_candidates:
            raise ApiError(503, "模型服务密钥尚未在服务器配置。")
        request_id = text(self.headers.get("x-request-id"), 240)
        billing_request_id = text(self.headers.get("x-billing-request-id"), 240)
        report_id = text(self.headers.get("x-report-session-id"), 200)
        task_key = text(self.headers.get("x-task-key"), 200)
        task_type = text(self.headers.get("x-task-type"), 80)
        try:
            attempt = int(self.headers.get("x-task-attempt", "0"))
        except ValueError:
            attempt = 0
        if (
            not REQUEST_ID_RE.fullmatch(request_id)
            or not billing_request_id
            or not SAFE_TEXT_RE.fullmatch(billing_request_id)
            or not report_id
            or not task_key
            or not task_type
        ):
            raise ApiError(400, "模型任务标识不完整。")
        if task_type not in ALLOWED_TASK_TYPES or not SAFE_TEXT_RE.fullmatch(task_type):
            raise ApiError(400, "模型任务类型无效。")
        if attempt < 1 or attempt > 20:
            raise ApiError(400, "模型任务尝试次数无效。")
        temperature = body.get("temperature")
        if temperature is not None and (
            isinstance(temperature, bool) or not isinstance(temperature, (int, float))
            or not math.isfinite(float(temperature)) or float(temperature) < 0 or float(temperature) > 2
        ):
            raise ApiError(400, "模型 temperature 参数无效。")
        output_limit = min(MAX_OUTPUT_TOKENS, TASK_OUTPUT_RESERVES.get(task_type, MAX_OUTPUT_TOKENS))
        upstream_body = {
            "model": model,
            "messages": body["messages"],
            "stream": True,
            "stream_options": {"include_usage": True},
            "max_completion_tokens": output_limit,
        }
        prompt_cache_key = text(body.get("prompt_cache_key"), 200)
        if prompt_cache_key and SAFE_TEXT_RE.fullmatch(prompt_cache_key):
            upstream_body["prompt_cache_key"] = prompt_cache_key
        if temperature is not None:
            upstream_body["temperature"] = float(temperature)
        if task_type in ("source_clean", "summary") and body.get("reasoning_effort") == "low":
            upstream_body["reasoning_effort"] = "low"
        reserve_request(
            session, request_id, report_id, task_key, task_type, model, attempt,
            input_estimate, billing_request_id,
        )
        upstream_data = json.dumps(upstream_body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        mark_upstream_submitted(request_id)
        usage: dict[str, int] | None = None
        output_chars = 0
        sent_content = False
        client_open = True
        final_status = "failed"
        try:
            try:
                upstream = open_provider_stream(provider_candidates, upstream_data, request_id)
            except HTTPError as error:
                error.read(16 * 1024)
                settle_request(session, request_id, "failed", model, None, input_estimate, 0, False)
                if error.code in (401, 403, 404, 408, 425, 429) or error.code >= 500:
                    raise ApiError(503, f"provider_route_unavailable：模型线路暂时不可用（{error.code}）") from error
                raise ApiError(error.code, f"模型服务拒绝请求（{error.code}）。") from error
            except (URLError, TimeoutError, OSError) as error:
                settle_request(session, request_id, "failed", model, None, input_estimate, 0, False)
                raise ApiError(503, "provider_route_unavailable：模型线路连接失败。") from error
            with upstream:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-cache, no-store")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                for raw_line in upstream:
                    if len(raw_line) > 4 * 1024 * 1024:
                        raise ApiError(502, "模型服务返回单行内容过大。")
                    if raw_line.startswith(b"data:"):
                        data = raw_line[5:].strip()
                        if data and data != b"[DONE]":
                            try:
                                event = as_object(json.loads(data.decode("utf-8", "replace")))
                                usage = merge_provider_usage(usage, provider_usage(event))
                                choices = event.get("choices")
                                if isinstance(choices, list):
                                    for choice in choices:
                                        delta = choice.get("delta", {}) if isinstance(choice, dict) else {}
                                        content = delta.get("content") if isinstance(delta, dict) else None
                                        if isinstance(content, str) and content:
                                            output_chars += len(content)
                                            sent_content = True
                            except Exception:
                                pass
                    if client_open:
                        try:
                            self.wfile.write(raw_line)
                            self.wfile.flush()
                        except (BrokenPipeError, ConnectionResetError, OSError):
                            client_open = False
                final_status = "success" if usage or sent_content else "failed"
        except ApiError:
            if final_status == "failed" and (usage or sent_content):
                final_status = "partial"
            raise
        except Exception:
            final_status = "partial" if sent_content else "failed"
        finally:
            settle_request(session, request_id, final_status, model, usage, input_estimate, output_chars, sent_content)


def main() -> None:
    if not PROVIDER_KEYRING.has_any_key():
        print("WARNING: no server-side provider key is configured; chat requests will be rejected.", flush=True)
    recover_interrupted_requests()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print(f"ProductOperationReport proxy listening on {HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
