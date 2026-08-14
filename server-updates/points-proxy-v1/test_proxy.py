#!/usr/bin/env python3
import importlib.util
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError


MODULE_PATH = Path(__file__).with_name("product_report_proxy.py")
SPEC = importlib.util.spec_from_file_location("product_report_proxy", MODULE_PATH)
proxy = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = proxy
SPEC.loader.exec_module(proxy)


class ProxyLedgerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="por-proxy-test-")
        proxy.DB_PATH = os.path.join(self.temp.name, "points.sqlite3")
        self.session = proxy.Session(
            token_hash="test", code_id="MAIN-A", machine_code="MACHINE-A", license_id="MAIN-A",
            device_credential="credential", device_session="session", expires_at=9_999_999_999,
        )
        with proxy.database() as db:
            proxy.ensure_schema(db)
            now = proxy.utc_now()
            db.execute(
                "INSERT INTO wallets(app_name,code_id,machine_code,balance_milli,total_topup_milli,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                (proxy.APP_NAME, self.session.code_id, self.session.machine_code, 500_000, 500_000, now, now),
            )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_duplicate_request_is_rejected_and_settled_once(self) -> None:
        request_id = "b4f81b86-1a5b-4e39-830e-1271165bb8ee"
        proxy.reserve_request(self.session, request_id, "report-a", "summary:1", "summary", "gpt-5.5", 1, 1000)
        with self.assertRaises(proxy.ApiError):
            proxy.reserve_request(self.session, request_id, "report-a", "summary:1", "summary", "gpt-5.5", 1, 1000)
        proxy.settle_request(
            self.session, request_id, "success", "gpt-5.5",
            {"input_tokens": 1000, "output_tokens": 500, "cached_input_tokens": 0, "cache_creation_input_tokens": 0},
            1000, 1500, True,
        )
        proxy.settle_request(self.session, request_id, "success", "gpt-5.5", None, 1000, 1500, True)
        with proxy.database() as db:
            row = db.execute("SELECT COUNT(*) AS c FROM ledger WHERE request_id=?", (request_id,)).fetchone()
            wallet = db.execute("SELECT locked_milli FROM wallets WHERE code_id=?", (self.session.code_id,)).fetchone()
        self.assertEqual(row["c"], 1)
        self.assertEqual(wallet["locked_milli"], 0)

    def test_missing_usage_with_content_is_not_free(self) -> None:
        request_id = "f82324d3-df4f-42a4-badb-e0ba393b8f3f"
        proxy.reserve_request(self.session, request_id, "report-b", "part:1", "final_part", "gpt-5.5", 1, 1200)
        proxy.settle_request(self.session, request_id, "aborted", "gpt-5.5", None, 1200, 2400, True)
        with proxy.database() as db:
            row = db.execute("SELECT usage_source,charged_milli FROM model_requests WHERE request_id=?", (request_id,)).fetchone()
        self.assertEqual(row["usage_source"], "estimated")
        self.assertGreater(row["charged_milli"], 0)

    def test_old_machine_session_is_revoked_after_wallet_rebind(self) -> None:
        raw = "temporary-session-token"
        token_hash = proxy.hashlib.sha256(raw.encode()).hexdigest()
        self.session.token_hash = token_hash
        with proxy.SESSION_LOCK:
            proxy.SESSIONS[token_hash] = self.session
        with proxy.database() as db:
            db.execute(
                "UPDATE wallets SET machine_code='MACHINE-B' WHERE app_name=? AND code_id=?",
                (proxy.APP_NAME, self.session.code_id),
            )
        class Headers:
            @staticmethod
            def get(name: str, fallback: str = "") -> str:
                return f"Bearer {raw}" if name.lower() == "authorization" else fallback
        with self.assertRaises(proxy.ApiError):
            proxy.require_session(Headers())

    def test_task_reservations_allow_four_parallel_source_clean_jobs(self) -> None:
        for index in range(4):
            proxy.reserve_request(
                self.session,
                f"a57e23b0-2e3f-4b3b-8af2-00000000000{index}",
                "report-parallel",
                f"source:{index}",
                "source_clean",
                "gpt-5.5",
                1,
                1000,
            )
        with proxy.database() as db:
            running = db.execute(
                "SELECT COUNT(*) AS c FROM model_requests WHERE status='running'"
            ).fetchone()["c"]
            locked = db.execute(
                "SELECT locked_milli FROM wallets WHERE code_id=?", (self.session.code_id,)
            ).fetchone()["locked_milli"]
        self.assertEqual(running, 4)
        self.assertGreater(locked, 0)
        self.assertLessEqual(locked, 500_000)

    def test_fifth_parallel_job_and_second_report_are_rejected(self) -> None:
        for index in range(4):
            proxy.reserve_request(
                self.session,
                f"b57e23b0-2e3f-4b3b-8af2-00000000000{index}",
                "report-one",
                f"source:{index}",
                "source_clean",
                "gpt-5.5",
                1,
                1000,
            )
        with self.assertRaises(proxy.ApiError) as limit_error:
            proxy.reserve_request(
                self.session,
                "b57e23b0-2e3f-4b3b-8af2-000000000009",
                "report-one",
                "source:9",
                "source_clean",
                "gpt-5.5",
                1,
                1000,
            )
        self.assertEqual(limit_error.exception.status, 429)

        with self.assertRaises(proxy.ApiError) as report_error:
            proxy.reserve_request(
                self.session,
                "b57e23b0-2e3f-4b3b-8af2-000000000008",
                "report-two",
                "summary:other",
                "summary",
                "gpt-5.5",
                1,
                1000,
            )
        self.assertEqual(report_error.exception.status, 429)

    def test_unknown_task_type_is_not_given_an_unbounded_reservation_profile(self) -> None:
        self.assertNotIn("invented_expensive_task", proxy.ALLOWED_TASK_TYPES)

    def test_daily_cap_counts_running_reservations(self) -> None:
        original_limit = proxy.DAILY_COST_LIMIT_CNY
        proxy.DAILY_COST_LIMIT_CNY = 0.01
        try:
            with self.assertRaises(proxy.ApiError) as error:
                proxy.reserve_request(
                    self.session,
                    "c57e23b0-2e3f-4b3b-8af2-000000000001",
                    "report-daily-cap",
                    "final:1",
                    "final_part",
                    "gpt-5.5",
                    1,
                    1000,
                )
            self.assertEqual(error.exception.status, 503)
        finally:
            proxy.DAILY_COST_LIMIT_CNY = original_limit

    def test_empty_or_zero_provider_usage_falls_back_to_estimation(self) -> None:
        self.assertIsNone(proxy.provider_usage({"usage": {}}))
        self.assertIsNone(proxy.provider_usage({
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        }))
        usage = proxy.provider_usage({
            "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}
        })
        self.assertEqual(usage["input_tokens"], 100)
        self.assertEqual(usage["output_tokens"], 20)

    def test_provider_usage_frames_never_move_backwards(self) -> None:
        earlier = {"input_tokens": 100, "output_tokens": 20, "cached_input_tokens": 10, "cache_creation_input_tokens": 0}
        later = {"input_tokens": 80, "output_tokens": 25, "cached_input_tokens": 5, "cache_creation_input_tokens": 0}
        self.assertEqual(proxy.merge_provider_usage(earlier, later), {
            "input_tokens": 100,
            "output_tokens": 25,
            "cached_input_tokens": 10,
            "cache_creation_input_tokens": 0,
            "response_model": "",
        })

    def test_restart_conservatively_settles_submitted_requests(self) -> None:
        request_id = "d57e23b0-2e3f-4b3b-8af2-000000000001"
        proxy.reserve_request(
            self.session, request_id, "report-crash", "summary:crash", "summary", "gpt-5.5", 1, 1400
        )
        proxy.mark_upstream_submitted(request_id)
        proxy.recover_interrupted_requests()
        with proxy.database() as db:
            request = db.execute(
                "SELECT status,usage_source,charged_milli FROM model_requests WHERE request_id=?", (request_id,)
            ).fetchone()
            wallet = db.execute(
                "SELECT balance_milli,locked_milli FROM wallets WHERE code_id=?", (self.session.code_id,)
            ).fetchone()
        self.assertEqual(request["status"], "interrupted_estimated")
        self.assertEqual(request["usage_source"], "estimated")
        self.assertGreater(request["charged_milli"], 0)
        self.assertEqual(wallet["locked_milli"], 0)
        self.assertLess(wallet["balance_milli"], 500_000)

    def test_response_model_mismatch_uses_the_more_conservative_price(self) -> None:
        requested_charge, requested_cost = proxy.points_for_usage("claude-sonnet-4-6", 100_000, 20_000)
        charged, cost = proxy.points_for_verified_usage(
            "claude-sonnet-4-6", "gpt-5.5", 100_000, 20_000, 0, 0
        )
        self.assertGreater(charged, requested_charge)
        self.assertGreater(cost, requested_cost)

    def test_model_specific_route_can_use_an_independent_provider(self) -> None:
        original_base = proxy.PROVIDER_ROUTES["claude-sonnet-4-6"][0]
        original_key = proxy.PROVIDER_ROUTES["claude-sonnet-4-6"][1]
        try:
            proxy.PROVIDER_ROUTES["claude-sonnet-4-6"] = ("https://backup.example/v1", "backup-key")
            self.assertEqual(
                proxy.provider_route("claude-sonnet-4-6"), ("https://backup.example/v1", "backup-key")
            )
        finally:
            proxy.PROVIDER_ROUTES["claude-sonnet-4-6"] = (original_base, original_key)

    def test_higher_response_model_price_is_not_capped_by_cheaper_request_reserve(self) -> None:
        request_id = "e57e23b0-2e3f-4b3b-8af2-000000000001"
        proxy.reserve_request(
            self.session, request_id, "report-model-mismatch", "final:mismatch",
            "final_part", "claude-sonnet-4-6", 1, 100_000
        )
        usage = {
            "input_tokens": 100_000,
            "output_tokens": 5_000,
            "cached_input_tokens": 0,
            "cache_creation_input_tokens": 0,
            "response_model": "gpt-5.5",
        }
        expected, _ = proxy.points_for_verified_usage("claude-sonnet-4-6", "gpt-5.5", 100_000, 5_000)
        proxy.settle_request(
            self.session, request_id, "success", "claude-sonnet-4-6", usage, 100_000, 15_000, True
        )
        with proxy.database() as db:
            request = db.execute(
                "SELECT charged_milli,response_model FROM model_requests WHERE request_id=?", (request_id,)
            ).fetchone()
            wallet = db.execute(
                "SELECT balance_milli,locked_milli FROM wallets WHERE code_id=?", (self.session.code_id,)
            ).fetchone()
        self.assertEqual(request["charged_milli"], expected)
        self.assertEqual(request["response_model"], "gpt-5.5")
        self.assertEqual(wallet["balance_milli"], 500_000 - expected)
        self.assertEqual(wallet["locked_milli"], 0)


class ProviderKeyringTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="por-provider-keyring-")
        self.path = Path(self.temp.name, "provider-keys.json")
        self.fallback = {model: ("https://fallback.example/v1", "fallback-secret-0001") for model in proxy.ALLOWED_MODELS}
        self.keyring = proxy.ProviderKeyring(str(self.path), self.fallback, proxy.ALLOWED_MODELS)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_keyring(self, generation: int, active: str, keys: dict[str, str]) -> None:
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps({
            "version": 1,
            "generation": generation,
            "profiles": {
                "ccg-main": {
                    "base_url": "https://provider.example/v1",
                    "active_key_id": active,
                    "keys": keys,
                }
            },
            "models": {model: "ccg-main" for model in proxy.ALLOWED_MODELS},
        }), encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, self.path)

    def test_atomic_rotation_changes_only_new_request_snapshots(self) -> None:
        self.write_keyring(1, "key-a", {"key-a": "secret-a-0000000001"})
        old_request = self.keyring.active("gpt-5.5")
        self.write_keyring(2, "key-b", {
            "key-a": "secret-a-0000000001",
            "key-b": "secret-b-0000000002",
        })
        new_request = self.keyring.active("gpt-5.5")
        self.assertEqual(old_request.key_id, "key-a")
        self.assertEqual(new_request.key_id, "key-b")
        self.assertEqual(old_request.key_id, "key-a", "in-flight snapshot must remain immutable")
        self.assertEqual([route.key_id for route in self.keyring.candidates("gpt-5.5")], ["key-b", "key-a"])

    def test_invalid_replacement_keeps_last_known_good_without_exposing_secrets(self) -> None:
        self.write_keyring(1, "key-a", {"key-a": "secret-a-0000000001"})
        self.assertEqual(self.keyring.active("gpt-5.5").key_id, "key-a")
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text('{"version":1,"profiles":', encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, self.path)
        self.assertEqual(self.keyring.active("gpt-5.5").key_id, "key-a")
        health_text = json.dumps(self.keyring.health())
        self.assertIn("last_known_good", health_text)
        self.assertNotIn("secret-a-0000000001", health_text)

    def test_missing_file_uses_existing_environment_route_for_compatibility(self) -> None:
        active = self.keyring.active("claude-sonnet-4-6")
        self.assertEqual(active.base_url, "https://fallback.example/v1")
        self.assertEqual(active.key_id, "environment")

    def test_installer_creates_a_private_server_only_keyring(self) -> None:
        install = Path(__file__).with_name("install.sh").read_text(encoding="utf-8")
        service = Path(__file__).with_name("product-report-proxy.service").read_text(encoding="utf-8")
        self.assertIn("chmod 0600 /etc/product-operation-report/provider-keys.json", install)
        self.assertIn("-m 0750 -o root -g product-report-proxy /etc/product-operation-report", install)
        self.assertIn("provider_keyring.py", install)
        self.assertIn("ReadOnlyPaths=/etc/product-operation-report", service)

    def test_auth_failure_uses_standby_before_any_stream_is_returned(self) -> None:
        candidates = (
            proxy.ProviderRouteSnapshot("gpt-5.5", "https://provider.example/v1", "key-b", "secret-b-0000000002"),
            proxy.ProviderRouteSnapshot("gpt-5.5", "https://provider.example/v1", "key-a", "secret-a-0000000001"),
        )
        successful_stream = object()
        authorizations = []

        def fake_open(request, timeout):
            authorizations.append(request.get_header("Authorization"))
            if len(authorizations) == 1:
                raise HTTPError(request.full_url, 401, "unauthorized", {}, io.BytesIO(b"rejected"))
            return successful_stream

        with patch.object(proxy, "urlopen", side_effect=fake_open):
            opened = proxy.open_provider_stream(candidates, b"{}", "test-request")
        self.assertIs(opened, successful_stream)
        self.assertEqual(len(authorizations), 2)

    def test_non_auth_provider_failure_does_not_try_a_second_key(self) -> None:
        candidates = (
            proxy.ProviderRouteSnapshot("gpt-5.5", "https://provider.example/v1", "key-b", "secret-b-0000000002"),
            proxy.ProviderRouteSnapshot("gpt-5.5", "https://provider.example/v1", "key-a", "secret-a-0000000001"),
        )
        calls = []

        def fake_open(request, timeout):
            calls.append(request)
            raise HTTPError(request.full_url, 429, "rate limited", {}, io.BytesIO(b"retry later"))

        with patch.object(proxy, "urlopen", side_effect=fake_open):
            with self.assertRaises(HTTPError):
                proxy.open_provider_stream(candidates, b"{}", "test-request")
        self.assertEqual(len(calls), 1)

class LicenseContractTests(unittest.TestCase):
    def valid_result(self, **overrides):
        result = {
            "ok": True,
            "app_name": proxy.APP_NAME,
            "code_id": "PRIMARY-001",
            "code_role": "primary",
            "machine_code": "MACHINE-A",
            "binding_status": "active",
            "remaining_points": 100,
        }
        result.update(overrides)
        return result

    def test_license_success_must_be_boolean_true(self) -> None:
        for rejected in (False, "false", 0, 1, "true", None):
            result = self.valid_result(ok=rejected)
            with self.subTest(ok=rejected), self.assertRaises(proxy.ApiError):
                proxy.parse_license_response(result, 200, "MACHINE-A", {"primary"})

    def test_license_requires_server_code_id_and_exact_identity(self) -> None:
        invalid_results = (
            self.valid_result(code_id=""),
            self.valid_result(app_name="AnotherApp"),
            self.valid_result(machine_code="MACHINE-B"),
            self.valid_result(binding_status="unbound"),
        )
        for result in invalid_results:
            with self.subTest(result=result), self.assertRaises(proxy.ApiError):
                proxy.parse_license_response(result, 200, "MACHINE-A", {"primary"})

    def test_main_and_topup_code_roles_are_not_interchangeable(self) -> None:
        with self.assertRaises(proxy.ApiError):
            proxy.parse_license_response(
                self.valid_result(code_role="auto_topup"), 200, "MACHINE-A", {"primary", "legacy_manual"}
            )
        with self.assertRaises(proxy.ApiError):
            proxy.parse_license_response(
                self.valid_result(code_role="primary"), 200, "MACHINE-A", {"auto_topup"}
            )

    def test_explicit_zero_remaining_points_never_reissues_granted_points(self) -> None:
        code_id, points_milli, role = proxy.parse_license_response(
            self.valid_result(remaining_points=0),
            200,
            "MACHINE-A",
            {"primary"},
        )
        self.assertEqual(code_id, "PRIMARY-001")
        self.assertEqual(points_milli, 0)
        self.assertEqual(role, "primary")

    def test_nested_request_echo_cannot_supply_a_server_code_id(self) -> None:
        response = {
            "ok": True,
            "request": {
                "license_id": "CLIENT-CHOSEN",
                "app_name": proxy.APP_NAME,
                "machine_code": "MACHINE-A",
            },
            "data": {
                "binding_status": "active",
                "code_role": "primary",
                "remaining_points": 100,
            },
        }
        with self.assertRaises(proxy.ApiError):
            proxy.parse_license_response(response, 200, "MACHINE-A", {"primary"})

    def test_conflicting_nested_status_cannot_be_hidden_by_outer_success(self) -> None:
        response = self.valid_result()
        response["data"] = {"valid": False}
        with self.assertRaises(proxy.ApiError):
            proxy.parse_license_response(response, 200, "MACHINE-A", {"primary"})

    def test_conflicting_top_level_aliases_are_rejected(self) -> None:
        for alias in ("success", "valid", "activated", "license_id", "activation_id"):
            response = self.valid_result()
            response[alias] = False if alias in {"success", "valid", "activated"} else "CLIENT-CHOSEN"
            with self.subTest(alias=alias), self.assertRaises(proxy.ApiError):
                proxy.parse_license_response(response, 200, "MACHINE-A", {"primary"})

    def test_boolean_or_string_points_are_not_numbers(self) -> None:
        for invalid_points in (True, False, "100"):
            with self.subTest(points=invalid_points), self.assertRaises(proxy.ApiError):
                proxy.parse_license_response(
                    self.valid_result(remaining_points=invalid_points), 200, "MACHINE-A", {"primary"}
                )

    def test_nginx_public_entrypoints_have_rate_and_connection_limits(self) -> None:
        config = MODULE_PATH.with_name("nginx-location.conf").read_text(encoding="utf-8")
        self.assertIn("limit_req zone=por_session", config)
        self.assertIn("limit_req zone=por_redeem", config)
        self.assertIn("limit_req zone=por_chat", config)
        self.assertIn("limit_conn por_conn", config)
        self.assertIn("return 404", config)
        common = MODULE_PATH.with_name("nginx-proxy-common.conf").read_text(encoding="utf-8")
        self.assertNotIn("proxy_read_timeout", common)
        self.assertIn("proxy_read_timeout 360s", config)


if __name__ == "__main__":
    unittest.main()
