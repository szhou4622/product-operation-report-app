#!/usr/bin/env python3

import json
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path

import migrate_time_cards as migration


def create_license_db(path):
    db = sqlite3.connect(path)
    db.executescript(
        """
        CREATE TABLE redeem_codes (
          app_name TEXT,code_id TEXT,code_hash TEXT,credits INTEGER,unlimited INTEGER,
          license_type TEXT,expires_at TEXT,disabled INTEGER,created_at TEXT,note TEXT,
          duration_days INTEGER,code_plaintext TEXT
        );
        CREATE TABLE activations (
          app_name TEXT,code_id TEXT,bound_machine_code TEXT,activated_at TEXT,last_seen_at TEXT,
          payload_json TEXT,binding_status TEXT,credential_version INTEGER,transfer_count INTEGER,
          last_bound_at TEXT,last_unbound_at TEXT,previous_machine_code TEXT,binding_role TEXT,
          merged_into_code_id TEXT
        );
        CREATE TABLE point_accounts (
          app_name TEXT,code_id TEXT,machine_code TEXT,code_hash TEXT,balance INTEGER,unlimited INTEGER,
          created_at TEXT,updated_at TEXT,balance_mode TEXT,balance_source TEXT,migration_status TEXT,billing_api TEXT
        );
        CREATE TABLE credit_transactions (
          transaction_id TEXT,app_name TEXT,code_id TEXT,request_id TEXT,machine_code TEXT,
          transaction_type TEXT,amount INTEGER,reason TEXT,balance_before INTEGER,balance_after INTEGER,
          unlimited INTEGER,client_version TEXT,created_at TEXT
        );
        CREATE TABLE point_reservations (
          app_name TEXT,code_id TEXT,points INTEGER
        );
        CREATE TABLE admin_credit_adjustments (
          app_name TEXT,code_id TEXT,amount INTEGER
        );
        CREATE TABLE time_renewals (
          app_name TEXT,primary_code_id TEXT,renewal_code_id TEXT,duration_days INTEGER
        );
        """
    )
    now = "2026-08-07T04:13:59Z"
    for code_id in migration.phase_ids("all"):
        db.execute(
            "INSERT INTO redeem_codes VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                migration.APP_NAME,code_id,f"hash-{code_id}",0,0,"time_30d","",0,now,"",30,
                f"TEST-{code_id}",
            ),
        )
    for phase, code_id, machine, previous in (
        ("unbound", migration.PHASES["unbound"][0], "", "OLD-MACHINE"),
        ("active", migration.PHASES["active"][0], "ACTIVE-MACHINE", ""),
    ):
        payload = {
            "app_name": migration.APP_NAME,
            "code_id": code_id,
            "credits": 0,
            "unlimited": False,
            "license_type": "time_30d",
            "duration_days": 30,
            "expires_at": "2026-09-30T00:00:00Z",
        }
        db.execute(
            "INSERT INTO activations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                migration.APP_NAME,code_id,machine,now,now,json.dumps(payload),phase,1,0,now,now,
                previous,"primary","",
            ),
        )
    db.commit()
    db.close()


def create_proxy_db(path):
    db = sqlite3.connect(path)
    db.executescript(
        """
        CREATE TABLE model_requests (app_name TEXT,code_id TEXT,charged_milli INTEGER,started_at TEXT);
        CREATE TABLE ledger (app_name TEXT,code_id TEXT,points_delta_milli INTEGER);
        CREATE TABLE wallets (app_name TEXT,code_id TEXT);
        """
    )
    db.close()


def scalar(path, sql):
    with closing(sqlite3.connect(path)) as db:
        return db.execute(sql).fetchone()[0]


def main():
    with tempfile.TemporaryDirectory(prefix="por-time-migration-test-") as root_text:
        root = Path(root_text)
        license_db = root / "license.sqlite3"
        proxy_db = root / "proxy.sqlite3"
        backups = root / "backups"
        create_license_db(license_db)
        create_proxy_db(proxy_db)

        inspected = migration.inspect(license_db, proxy_db, "all")
        assert len(inspected["cards"]) == 5
        assert all(item["credits_after"] == 2000 for item in inspected["cards"])

        for phase in ("unused", "unbound", "active"):
            result = migration.apply_phase(license_db, proxy_db, backups, phase, "test-operator")
            assert result["ok"] is True
            verified = migration.verify(license_db, proxy_db, phase)
            assert all(row["credits"] == 2000 and row["license_type"] == "standard" for row in verified["results"])

        assert scalar(license_db, "SELECT COUNT(*) FROM redeem_codes WHERE license_type='standard' AND credits=2000") == 5
        assert scalar(license_db, "SELECT COUNT(*) FROM license_type_migrations WHERE status='applied'") == 5
        assert scalar(license_db, "SELECT COUNT(*) FROM point_accounts WHERE balance=2000") == 2
        assert scalar(license_db, "SELECT COUNT(*) FROM credit_transactions WHERE transaction_type='migration_opening_balance'") == 2
        assert scalar(proxy_db, "SELECT COUNT(*) FROM model_requests") == 0

        for phase in ("active", "unbound", "unused"):
            result = migration.rollback_phase(license_db, proxy_db, backups, phase, "test-operator")
            assert result["ok"] is True

        assert scalar(license_db, "SELECT COUNT(*) FROM redeem_codes WHERE license_type='time_30d' AND duration_days=30") == 5
        assert scalar(license_db, "SELECT COUNT(*) FROM license_type_migrations WHERE status='rolled_back'") == 5
        assert scalar(license_db, "SELECT COUNT(*) FROM point_accounts") == 0
        assert scalar(license_db, "SELECT COUNT(*) FROM credit_transactions") == 0
    print("migration apply/verify/rollback test passed")


if __name__ == "__main__":
    main()
