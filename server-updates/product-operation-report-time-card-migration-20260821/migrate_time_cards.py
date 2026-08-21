#!/usr/bin/env python3

import argparse
import json
import math
import sqlite3
import sys
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

APP_NAME = "ProductOperationReport"
TARGET_CREDITS = 2000
CONFIRM_APPLY = "MIGRATE-ProductOperationReport-TIME-TO-2000"
CONFIRM_ROLLBACK = "ROLLBACK-ProductOperationReport-TIME-TO-2000"
LICENSE_DB = Path("/opt/original-video-dedup-tool/server/license_server.sqlite3")
PROXY_DB = Path("/opt/product-operation-report/points.sqlite3")
BACKUP_DIR = Path("/opt/original-video-dedup-tool/server/backups/product-operation-report-time-migration")
PHASES = {
    "unused": ("A028166AC1340186", "AF22DCD4C8A72F82", "E55970B942671215"),
    "unbound": ("2EBA4E7197C9E6D6",),
    "active": ("F719B6917FD4B090",),
}
EXPECTED_STATUS = {"unused": "unused", "unbound": "unbound", "active": "active"}
REASON = (
    "ProductOperationReport is points-only; convert incompatible 30-day time card "
    "in place to 2000 credits without changing code_id or binding history"
)


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def connect(path, read_only=False):
    if read_only:
        db = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True, timeout=20)
    else:
        db = sqlite3.connect(path, timeout=20)
    db.row_factory = sqlite3.Row
    return db


def phase_ids(phase):
    if phase == "all":
        return tuple(code_id for name in ("unused", "unbound", "active") for code_id in PHASES[name])
    return PHASES[phase]


def request_id(code_id):
    return f"por-time-migration-20260821-{code_id}"


def mask_machine(value):
    value = str(value or "")
    return "-" if not value else f"{value[:8]}...{value[-4:]}"


def parse_json(value):
    try:
        parsed = json.loads(str(value or "{}"))
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        return {}


def parse_time(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def remaining_days(expires_at):
    parsed = parse_time(expires_at)
    if not parsed:
        return None
    return max(0, math.ceil((parsed - datetime.now(timezone.utc)).total_seconds() / 86400))


def load_card(db, code_id):
    row = db.execute(
        """
        SELECT r.app_name,r.code_id,r.code_hash,r.credits,r.unlimited,r.license_type,
               r.expires_at,r.disabled,r.created_at,r.note,r.duration_days,
               a.bound_machine_code,a.activated_at,a.last_seen_at,a.payload_json,
               a.binding_status,a.credential_version,a.transfer_count,
               a.last_bound_at,a.last_unbound_at,a.previous_machine_code,
               a.binding_role,a.merged_into_code_id
        FROM redeem_codes AS r
        LEFT JOIN activations AS a ON a.app_name=r.app_name AND a.code_id=r.code_id
        WHERE r.app_name=? AND r.code_id=?
        """,
        (APP_NAME, code_id),
    ).fetchone()
    if not row:
        raise RuntimeError(f"missing expected time card: {code_id}")
    return dict(row)


def card_status(card):
    return str(card.get("binding_status") or "unused")


def card_expiry(card):
    payload = parse_json(card.get("payload_json"))
    return str(payload.get("expires_at") or card.get("expires_at") or "")


def read_activity(license_db, proxy_db, code_id):
    def aggregate(db, sql, params):
        return dict(db.execute(sql, params).fetchone())

    params = (APP_NAME, code_id)
    return {
        "credit_transactions": aggregate(
            license_db,
            "SELECT COUNT(*) count,COALESCE(SUM(CASE WHEN amount<0 THEN -amount ELSE 0 END),0) spent FROM credit_transactions WHERE app_name=? AND code_id=?",
            params,
        ),
        "reservations": aggregate(
            license_db,
            "SELECT COUNT(*) count,COALESCE(SUM(points),0) points FROM point_reservations WHERE app_name=? AND code_id=?",
            params,
        ),
        "admin_adjustments": aggregate(
            license_db,
            "SELECT COUNT(*) count,COALESCE(SUM(amount),0) amount FROM admin_credit_adjustments WHERE app_name=? AND code_id=?",
            params,
        ),
        "renewals": aggregate(
            license_db,
            "SELECT COUNT(*) count,COALESCE(SUM(duration_days),0) days FROM time_renewals WHERE app_name=? AND (primary_code_id=? OR renewal_code_id=?)",
            (APP_NAME, code_id, code_id),
        ),
        "model_requests": aggregate(
            proxy_db,
            "SELECT COUNT(*) count,COALESCE(SUM(charged_milli),0) charged_milli FROM model_requests WHERE app_name=? AND code_id=?",
            params,
        ),
        "proxy_ledger": aggregate(
            proxy_db,
            "SELECT COUNT(*) count,COALESCE(SUM(CASE WHEN points_delta_milli<0 THEN -points_delta_milli ELSE 0 END),0) spent_milli FROM ledger WHERE app_name=? AND code_id=?",
            params,
        ),
        "proxy_wallet": bool(proxy_db.execute("SELECT 1 FROM wallets WHERE app_name=? AND code_id=?", params).fetchone()),
        "point_account": bool(license_db.execute("SELECT 1 FROM point_accounts WHERE app_name=? AND code_id=?", params).fetchone()),
    }


def inspect(license_path, proxy_path, phase):
    with closing(connect(license_path, True)) as license_db, closing(connect(proxy_path, True)) as proxy_db:
        cards = []
        for name in ((phase,) if phase != "all" else ("unused", "unbound", "active")):
            for code_id in PHASES[name]:
                card = load_card(license_db, code_id)
                activity = read_activity(license_db, proxy_db, code_id)
                cards.append(
                    {
                        "phase": name,
                        "code_id": code_id,
                        "status": card_status(card),
                        "activated_at": card.get("activated_at") or None,
                        "last_seen_at": card.get("last_seen_at") or None,
                        "expires_at": card_expiry(card) or None,
                        "remaining_days": remaining_days(card_expiry(card)),
                        "bound_machine": mask_machine(card.get("bound_machine_code")),
                        "previous_machine": mask_machine(card.get("previous_machine_code")),
                        "license_type": card.get("license_type"),
                        "duration_days": card.get("duration_days"),
                        "credits_before": card.get("credits"),
                        "credits_after": TARGET_CREDITS,
                        "request_id": request_id(code_id),
                        "activity": activity,
                    }
                )
        return {"ok": True, "mode": "read_only", "app_name": APP_NAME, "target_credits": TARGET_CREDITS, "cards": cards}


def assert_preconditions(license_db, proxy_db, phase):
    ids = phase_ids(phase)
    found_time_ids = {
        row[0]
        for row in license_db.execute(
            "SELECT code_id FROM redeem_codes WHERE app_name=? AND (duration_days>0 OR license_type LIKE 'time_%')",
            (APP_NAME,),
        )
    }
    expected_all = set(phase_ids("all"))
    if not found_time_ids.issubset(expected_all):
        raise RuntimeError(f"unexpected ProductOperationReport time cards appeared: {sorted(found_time_ids - expected_all)}")
    existing_ids = {
        row[0]
        for row in license_db.execute(
            "SELECT code_id FROM redeem_codes WHERE app_name=? AND code_id IN (?,?,?,?,?)",
            (APP_NAME, *phase_ids("all")),
        )
    }
    if existing_ids != expected_all:
        raise RuntimeError(f"fixed migration inventory is incomplete: {sorted(expected_all - existing_ids)}")
    for code_id in ids:
        card = load_card(license_db, code_id)
        expected_phase = next(name for name, values in PHASES.items() if code_id in values)
        if card_status(card) != EXPECTED_STATUS[expected_phase]:
            raise RuntimeError(f"unexpected binding status for {code_id}: {card_status(card)}")
        if int(card.get("duration_days") or 0) != 30 or str(card.get("license_type")) != "time_30d":
            raise RuntimeError(f"unexpected entitlement for {code_id}")
        if int(card.get("credits") or 0) != 0 or int(card.get("unlimited") or 0) != 0 or int(card.get("disabled") or 0) != 0:
            raise RuntimeError(f"unexpected credits/unlimited/disabled state for {code_id}")
        activity = read_activity(license_db, proxy_db, code_id)
        if any(
            (
                activity["credit_transactions"]["count"],
                activity["reservations"]["count"],
                activity["admin_adjustments"]["count"],
                activity["renewals"]["count"],
                activity["model_requests"]["count"],
                activity["proxy_ledger"]["count"],
                activity["proxy_wallet"],
                activity["point_account"],
            )
        ):
            raise RuntimeError(f"activity appeared after dry-run for {code_id}; stop and review")


def backup_database(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise RuntimeError(f"backup already exists: {destination}")
    with closing(connect(source, True)) as src, closing(sqlite3.connect(destination)) as dst:
        src.backup(dst)


def backup_pair(license_path, proxy_path, backup_dir, phase, action):
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    root = backup_dir / f"{stamp}-{action}-{phase}"
    backup_database(license_path, root / "license_server.sqlite3")
    backup_database(proxy_path, root / "points.sqlite3")
    return root


def ensure_audit_table(db):
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS license_type_migrations (
          migration_id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL UNIQUE,
          app_name TEXT NOT NULL,
          code_id TEXT NOT NULL,
          phase TEXT NOT NULL,
          operator TEXT NOT NULL,
          reason TEXT NOT NULL,
          status_before TEXT NOT NULL,
          redeem_before_json TEXT NOT NULL,
          activation_before_json TEXT NOT NULL,
          point_account_before_json TEXT NOT NULL,
          credits_after INTEGER NOT NULL,
          status TEXT NOT NULL,
          applied_at TEXT NOT NULL,
          rollback_request_id TEXT NOT NULL DEFAULT '',
          rollback_operator TEXT NOT NULL DEFAULT '',
          rolled_back_at TEXT NOT NULL DEFAULT ''
        )
        """
    )


def selected_dict(row, keys):
    return {key: row.get(key) for key in keys}


def apply_phase(license_path, proxy_path, backup_dir, phase, operator):
    if phase == "all":
        raise RuntimeError("apply requires one phase at a time")
    backup_root = backup_pair(license_path, proxy_path, backup_dir, phase, "before-apply")
    with closing(connect(proxy_path, True)) as proxy_db, closing(connect(license_path, False)) as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            assert_preconditions(db, proxy_db, phase)
            ensure_audit_table(db)
            applied = []
            now = utc_now()
            for code_id in PHASES[phase]:
                rid = request_id(code_id)
                if db.execute("SELECT 1 FROM license_type_migrations WHERE request_id=?", (rid,)).fetchone():
                    raise RuntimeError(f"request_id already exists: {rid}")
                card = load_card(db, code_id)
                account = db.execute("SELECT * FROM point_accounts WHERE app_name=? AND code_id=?", (APP_NAME, code_id)).fetchone()
                redeem_before = selected_dict(
                    card,
                    ("credits", "unlimited", "license_type", "expires_at", "disabled", "note", "duration_days"),
                )
                activation_before = selected_dict(
                    card,
                    (
                        "payload_json", "binding_status", "bound_machine_code", "previous_machine_code",
                        "credential_version", "transfer_count", "binding_role", "merged_into_code_id",
                    ),
                ) if card.get("binding_status") else {}
                db.execute(
                    """
                    INSERT INTO license_type_migrations
                      (migration_id,request_id,app_name,code_id,phase,operator,reason,status_before,
                       redeem_before_json,activation_before_json,point_account_before_json,
                       credits_after,status,applied_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        str(uuid.uuid4()), rid, APP_NAME, code_id, phase, operator, REASON,
                        card_status(card), json.dumps(redeem_before, ensure_ascii=False, sort_keys=True),
                        json.dumps(activation_before, ensure_ascii=False, sort_keys=True),
                        json.dumps(dict(account) if account else {}, ensure_ascii=False, sort_keys=True),
                        TARGET_CREDITS, "applying", now,
                    ),
                )
                note = str(card.get("note") or "").strip()
                marker = f"time_to_points:{rid}"
                migrated_note = f"{note}; {marker}".strip("; ")
                db.execute(
                    """
                    UPDATE redeem_codes
                    SET credits=?,unlimited=0,license_type='standard',expires_at='',duration_days=0,note=?
                    WHERE app_name=? AND code_id=?
                    """,
                    (TARGET_CREDITS, migrated_note, APP_NAME, code_id),
                )
                if card.get("binding_status"):
                    payload = parse_json(card.get("payload_json"))
                    payload.update({
                        "app_name": APP_NAME,
                        "code_id": code_id,
                        "credits": TARGET_CREDITS,
                        "unlimited": False,
                        "license_type": "standard",
                        "duration_days": 0,
                    })
                    for key in ("expires_at", "remaining_days", "entitlement_type"):
                        payload.pop(key, None)
                    db.execute(
                        "UPDATE activations SET payload_json=?,last_seen_at=last_seen_at WHERE app_name=? AND code_id=?",
                        (json.dumps(payload, ensure_ascii=False, sort_keys=True), APP_NAME, code_id),
                    )
                    machine = str(
                        card.get("bound_machine_code")
                        if card_status(card) == "active"
                        else card.get("previous_machine_code")
                    ).strip().upper()
                    if not machine:
                        raise RuntimeError(f"missing migration machine for {code_id}")
                    db.execute(
                        """
                        INSERT INTO point_accounts
                          (app_name,code_id,machine_code,code_hash,balance,unlimited,created_at,updated_at,
                           balance_mode,balance_source,migration_status,billing_api)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                        """,
                        (
                            APP_NAME, code_id, machine, card["code_hash"], TARGET_CREDITS, 0, now, now,
                            "server_managed", "time_card_migration", "completed", "credits_consume",
                        ),
                    )
                    db.execute(
                        """
                        INSERT INTO credit_transactions
                          (transaction_id,app_name,code_id,request_id,machine_code,transaction_type,
                           amount,reason,balance_before,balance_after,unlimited,client_version,created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                        """,
                        (
                            str(uuid.uuid4()), APP_NAME, code_id, rid, machine,
                            "migration_opening_balance", TARGET_CREDITS, REASON, 0, TARGET_CREDITS, 0,
                            "server-migration", now,
                        ),
                    )
                db.execute(
                    "UPDATE license_type_migrations SET status='applied' WHERE request_id=?",
                    (rid,),
                )
                applied.append({"code_id": code_id, "request_id": rid, "credits": TARGET_CREDITS})
            db.execute("COMMIT")
            return {"ok": True, "phase": phase, "backup": str(backup_root), "applied": applied}
        except Exception:
            db.execute("ROLLBACK")
            raise


def rollback_phase(license_path, proxy_path, backup_dir, phase, operator):
    if phase == "all":
        raise RuntimeError("rollback requires one phase at a time")
    backup_root = backup_pair(license_path, proxy_path, backup_dir, phase, "before-rollback")
    with closing(connect(proxy_path, True)) as proxy_db, closing(connect(license_path, False)) as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            ensure_audit_table(db)
            rolled_back = []
            now = utc_now()
            for code_id in PHASES[phase]:
                rid = request_id(code_id)
                audit = db.execute(
                    "SELECT * FROM license_type_migrations WHERE request_id=? AND status='applied'",
                    (rid,),
                ).fetchone()
                if not audit:
                    raise RuntimeError(f"no applied migration audit for {rid}")
                later_license = db.execute(
                    "SELECT COUNT(*) FROM credit_transactions WHERE app_name=? AND code_id=? AND request_id<>? AND created_at>=?",
                    (APP_NAME, code_id, rid, audit["applied_at"]),
                ).fetchone()[0]
                later_proxy = proxy_db.execute(
                    "SELECT COUNT(*) FROM model_requests WHERE app_name=? AND code_id=? AND started_at>=?",
                    (APP_NAME, code_id, audit["applied_at"]),
                ).fetchone()[0]
                if later_license or later_proxy:
                    raise RuntimeError(f"post-migration activity exists for {code_id}; compensating rollback required")
                redeem = json.loads(audit["redeem_before_json"])
                db.execute(
                    """
                    UPDATE redeem_codes
                    SET credits=?,unlimited=?,license_type=?,expires_at=?,disabled=?,note=?,duration_days=?
                    WHERE app_name=? AND code_id=?
                    """,
                    (
                        redeem["credits"], redeem["unlimited"], redeem["license_type"],
                        redeem["expires_at"], redeem["disabled"], redeem["note"], redeem["duration_days"],
                        APP_NAME, code_id,
                    ),
                )
                activation = json.loads(audit["activation_before_json"])
                if activation:
                    db.execute(
                        "UPDATE activations SET payload_json=? WHERE app_name=? AND code_id=?",
                        (activation["payload_json"], APP_NAME, code_id),
                    )
                    db.execute(
                        "DELETE FROM credit_transactions WHERE app_name=? AND code_id=? AND request_id=? AND transaction_type='migration_opening_balance'",
                        (APP_NAME, code_id, rid),
                    )
                    db.execute(
                        "DELETE FROM point_accounts WHERE app_name=? AND code_id=? AND balance=? AND balance_source='time_card_migration'",
                        (APP_NAME, code_id, TARGET_CREDITS),
                    )
                rollback_id = f"rollback-{rid}"
                db.execute(
                    """
                    UPDATE license_type_migrations
                    SET status='rolled_back',rollback_request_id=?,rolled_back_at=?,rollback_operator=?
                    WHERE request_id=?
                    """,
                    (rollback_id, now, operator, rid),
                )
                rolled_back.append({"code_id": code_id, "rollback_request_id": rollback_id})
            db.execute("COMMIT")
            return {"ok": True, "phase": phase, "backup": str(backup_root), "rolled_back": rolled_back}
        except Exception:
            db.execute("ROLLBACK")
            raise


def verify(license_path, proxy_path, phase):
    with closing(connect(license_path, True)) as db, closing(connect(proxy_path, True)) as proxy_db:
        results = []
        audit_exists = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='license_type_migrations'"
        ).fetchone()
        for code_id in phase_ids(phase):
            card = load_card(db, code_id)
            account = db.execute(
                "SELECT balance,machine_code,balance_mode,balance_source,migration_status,billing_api FROM point_accounts WHERE app_name=? AND code_id=?",
                (APP_NAME, code_id),
            ).fetchone()
            audit = db.execute(
                "SELECT request_id,status,operator,reason,credits_after,applied_at,rolled_back_at FROM license_type_migrations WHERE request_id=?",
                (request_id(code_id),),
            ).fetchone() if audit_exists else None
            results.append({
                "code_id": code_id,
                "status": card_status(card),
                "license_type": card.get("license_type"),
                "duration_days": card.get("duration_days"),
                "credits": card.get("credits"),
                "audit": dict(audit) if audit else None,
                "point_account": dict(account) if account else None,
                "proxy_activity": read_activity(db, proxy_db, code_id)["model_requests"],
            })
        return {"ok": True, "mode": "read_only", "results": results}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("inspect", "apply", "rollback", "verify"), nargs="?", default="inspect")
    parser.add_argument("--phase", choices=("all", "unused", "unbound", "active"), default="all")
    parser.add_argument("--license-db", type=Path, default=LICENSE_DB)
    parser.add_argument("--proxy-db", type=Path, default=PROXY_DB)
    parser.add_argument("--backup-dir", type=Path, default=BACKUP_DIR)
    parser.add_argument("--operator", default="")
    parser.add_argument("--confirmation", default="")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.command == "inspect":
        result = inspect(args.license_db, args.proxy_db, args.phase)
    elif args.command == "verify":
        result = verify(args.license_db, args.proxy_db, args.phase)
    else:
        if not args.apply or not args.operator.strip():
            raise RuntimeError("write operations require --apply and --operator")
        expected = CONFIRM_APPLY if args.command == "apply" else CONFIRM_ROLLBACK
        if args.confirmation != expected:
            raise RuntimeError(f"confirmation mismatch; expected {expected}")
        result = (
            apply_phase(args.license_db, args.proxy_db, args.backup_dir, args.phase, args.operator.strip())
            if args.command == "apply"
            else rollback_phase(args.license_db, args.proxy_db, args.backup_dir, args.phase, args.operator.strip())
        )
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
