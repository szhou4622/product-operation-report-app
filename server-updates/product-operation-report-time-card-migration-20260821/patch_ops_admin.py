#!/usr/bin/env python3

import argparse
import ast
import hashlib
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

OPS_FILE = Path("/opt/ovdt-ops-admin/ops_admin_server.py")
BACKUP_ROOT = Path("/opt/ovdt-ops-admin/backups/product-operation-report-no-time-codes")
EXPECTED_SHA256 = "0355268c24c7abd9a3058fddab55f615c2b47354a84dad2c2d2ec2d6ed0c6f61"
CONFIRMATION = "DISABLE-ProductOperationReport-TIME-CODES"
SERVER_GUARD = 'if clean_app == "ProductOperationReport" and duration_days > 0:'


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def patched_text(source):
    server_before = '''    if duration_days < 0:
        raise ValueError("有效天数不能小于 0。")
    if not unlimited and duration_days <= 0 and credits <= 0:
'''
    server_after = '''    if duration_days < 0:
        raise ValueError("有效天数不能小于 0。")
    if clean_app == "ProductOperationReport" and duration_days > 0:
        raise ValueError("ProductOperationReport 只支持积分码和无限码，不能生成时间卡。")
    if not unlimited and duration_days <= 0 and credits <= 0:
'''
    options_before = '''              <select name="license_mode">
                <option value="credits">积分码</option>
                <option value="month">月卡 30 天</option>
                <option value="year">年卡 365 天</option>
                <option value="custom_days">自定义天数</option>
                <option value="unlimited">永久/无限</option>
              </select>
'''
    options_after = '''              <select name="license_mode">
                <option value="credits">积分码</option>
                {"" if app_name == "ProductOperationReport" else '<option value="month">月卡 30 天</option><option value="year">年卡 365 天</option><option value="custom_days">自定义天数</option>'}
                <option value="unlimited">永久/无限</option>
              </select>
'''
    field_before = '''            <div class="field">
              <label>自定义天数</label>
              <input name="duration_days" type="number" min="1" max="3650" value="30" placeholder="例如 90">
            </div>
'''
    field_after = '''            {"" if app_name == "ProductOperationReport" else '<div class="field"><label>自定义天数</label><input name="duration_days" type="number" min="1" max="3650" value="30" placeholder="例如 90"></div>'}
'''
    hint_before = '''          <p class="muted">月卡/年卡从用户第一次激活成功那一刻开始计时。一次最多 500 个。</p>
'''
    hint_after = '''          <p class="muted">{"ProductOperationReport 仅支持积分码和永久/无限码。" if app_name == "ProductOperationReport" else "月卡/年卡从用户第一次激活成功那一刻开始计时。"}一次最多 500 个。</p>
'''
    replacements = (
        (server_before, server_after, "server guard"),
        (options_before, options_after, "license-mode options"),
        (field_before, field_after, "duration field"),
        (hint_before, hint_after, "form hint"),
    )
    result = source
    for before, after, label in replacements:
        if before not in result:
            raise RuntimeError(f"expected {label} block not found; refuse to patch unknown source")
        result = result.replace(before, after, 1)
    return result


def inspect(path):
    source = path.read_text(encoding="utf-8")
    patchable = False
    patched_sha256 = None
    patch_error = None
    if SERVER_GUARD not in source:
        try:
            candidate = patched_text(source)
            ast.parse(candidate)
            patchable = True
            patched_sha256 = hashlib.sha256(candidate.encode("utf-8")).hexdigest()
        except Exception as error:
            patch_error = str(error)
    return {
        "ok": True,
        "mode": "read_only",
        "path": str(path),
        "sha256": sha256(path),
        "product_report_time_guard": SERVER_GUARD in source,
        "product_report_form_guard": 'app_name == "ProductOperationReport" else' in source,
        "expected_source_hash": sha256(path) == EXPECTED_SHA256,
        "patchable": patchable,
        "patched_sha256": patched_sha256,
        "patch_error": patch_error,
    }


def apply(path, backup_root, operator):
    before_hash = sha256(path)
    source = path.read_text(encoding="utf-8")
    if SERVER_GUARD in source:
        raise RuntimeError("ProductOperationReport time-card guard is already present")
    if before_hash != EXPECTED_SHA256:
        raise RuntimeError(f"ops source changed: expected {EXPECTED_SHA256}, actual {before_hash}")
    result = patched_text(source)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_dir = backup_root / stamp
    backup_dir.mkdir(parents=True, exist_ok=False)
    backup = backup_dir / path.name
    shutil.copy2(path, backup)
    temp = path.with_suffix(path.suffix + ".product-report-time-guard.tmp")
    temp.write_text(result, encoding="utf-8")
    os.replace(temp, path)
    after_hash = sha256(path)
    audit = {
        "request_id": f"ops-disable-product-report-time-codes-{stamp}",
        "operator": operator,
        "reason": "ProductOperationReport is points-only; prevent new incompatible time cards",
        "path": str(path),
        "backup": str(backup),
        "sha256_before": before_hash,
        "sha256_after": after_hash,
        "created_at": utc_now(),
    }
    (backup_dir / "audit.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"ok": True, "applied": True, **audit}


def rollback(path, backup, operator):
    if not backup or not backup.is_file():
        raise RuntimeError("rollback requires --backup pointing to the exact saved ops_admin_server.py")
    current = path.read_text(encoding="utf-8")
    if SERVER_GUARD not in current:
        raise RuntimeError("current ops source does not contain the ProductOperationReport guard")
    before = sha256(path)
    temp = path.with_suffix(path.suffix + ".rollback.tmp")
    shutil.copy2(backup, temp)
    os.replace(temp, path)
    return {
        "ok": True,
        "rolled_back": True,
        "operator": operator,
        "backup": str(backup),
        "sha256_before": before,
        "sha256_after": sha256(path),
        "rolled_back_at": utc_now(),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("inspect", "apply", "rollback"), nargs="?", default="inspect")
    parser.add_argument("--path", type=Path, default=OPS_FILE)
    parser.add_argument("--backup-root", type=Path, default=BACKUP_ROOT)
    parser.add_argument("--backup", type=Path)
    parser.add_argument("--operator", default="")
    parser.add_argument("--confirmation", default="")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.command == "inspect":
        result = inspect(args.path)
    else:
        if not args.apply or not args.operator.strip() or args.confirmation != CONFIRMATION:
            raise RuntimeError(f"write operation requires --apply, --operator and --confirmation {CONFIRMATION}")
        result = (
            apply(args.path, args.backup_root, args.operator.strip())
            if args.command == "apply"
            else rollback(args.path, args.backup, args.operator.strip())
        )
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
