#!/usr/bin/env python3
import importlib.util
import io
import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
import uuid
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
        self.consume_patch = patch.object(
            proxy, "consume_authoritative_credits", side_effect=self.fake_consume
        )
        self.consume_mock = self.consume_patch.start()

    def fake_consume(self, session, amount_milli, billing_request_id, reason):
        with proxy.database() as db:
            wallet = db.execute(
                "SELECT balance_milli FROM wallets WHERE app_name=? AND code_id=?",
                (proxy.APP_NAME, session.code_id),
            ).fetchone()
        return max(0, wallet["balance_milli"] - amount_milli), session.unlimited

    def tearDown(self) -> None:
        self.consume_patch.stop()
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
            row = db.execute(
                "SELECT COUNT(*) AS c,MAX(description) AS description FROM ledger WHERE request_id=?", (request_id,)
            ).fetchone()
            wallet = db.execute("SELECT locked_milli FROM wallets WHERE code_id=?", (self.session.code_id,)).fetchone()
        self.assertEqual(row["c"], 1)
        self.assertEqual(row["description"], "资料汇总")
        self.assertEqual(wallet["locked_milli"], 0)

    def test_benchmark_search_is_server_priced_and_audited(self) -> None:
        request_id = "c4f81b86-1a5b-4e39-830e-1271165bb8ee"
        previous_price = proxy.WEB_SEARCH_USD_PER_CALL
        proxy.WEB_SEARCH_USD_PER_CALL = 0.01
        try:
            proxy.reserve_request(
                self.session, request_id, "report-search", "module:v1:benchmark-brands",
                "module_benchmark", "gpt-5.5", 1, 1000,
            )
            proxy.settle_request(
                self.session, request_id, "success", "gpt-5.5",
                {"input_tokens": 1000, "output_tokens": 200, "cached_input_tokens": 0,
                 "cache_creation_input_tokens": 0},
                1000, 600, True, search_calls=2,
            )
            with proxy.database() as db:
                request = db.execute(
                    "SELECT search_calls,status FROM model_requests WHERE request_id=?", (request_id,)
                ).fetchone()
                ledger = db.execute(
                    "SELECT description FROM ledger WHERE request_id=?", (request_id,)
                ).fetchone()
            self.assertEqual(request["search_calls"], 2)
            self.assertEqual(request["status"], "success")
            self.assertIn("联网搜索 2 次", ledger["description"])
            self.assertEqual(proxy.pricing()["webSearchUsdPerCall"], 0.01)
        finally:
            proxy.WEB_SEARCH_USD_PER_CALL = previous_price

    def test_benchmark_without_explicit_search_event_is_not_labeled_as_search(self) -> None:
        request_id = "c5f81b86-1a5b-4e39-830e-1271165bb8ee"
        proxy.reserve_request(
            self.session, request_id, "report-no-search", "module:v1:benchmark-no-search",
            "module_benchmark", "gpt-5.6-sol", 1, 1000,
        )
        proxy.settle_request(
            self.session, request_id, "success", "gpt-5.6-sol",
            {"input_tokens": 1000, "output_tokens": 200, "cached_input_tokens": 0,
             "cache_creation_input_tokens": 0},
            1000, 600, True, search_calls=0,
        )
        with proxy.database() as db:
            request = db.execute(
                "SELECT search_calls FROM model_requests WHERE request_id=?", (request_id,)
            ).fetchone()
            ledger = db.execute(
                "SELECT description FROM ledger WHERE request_id=?", (request_id,)
            ).fetchone()
        self.assertEqual(request["search_calls"], 0)
        self.assertEqual(ledger["description"], "M4 对标推荐")

    def test_benchmark_search_budget_stops_the_eleventh_upstream_attempt(self) -> None:
        report_id = "report-search-budget"
        previous_limit = proxy.WEB_SEARCH_REPORT_LIMIT
        proxy.WEB_SEARCH_REPORT_LIMIT = 10
        try:
            for index in range(10):
                request_id = str(uuid.uuid4())
                proxy.reserve_request(
                    self.session, request_id, report_id, f"module:v1:benchmark:{index}",
                    "module_benchmark", "gpt-5.5", index + 1, 1000,
                )
                proxy.mark_upstream_submitted(request_id)
                proxy.settle_request(
                    self.session, request_id, "failed", "gpt-5.5", None,
                    1000, 0, False,
                )
            with self.assertRaises(proxy.ApiError) as caught:
                proxy.reserve_request(
                    self.session, str(uuid.uuid4()), report_id, "module:v1:benchmark:11",
                    "module_benchmark", "gpt-5.5", 11, 1000,
                )
            self.assertEqual(caught.exception.status, 429)
            self.assertIn("search_budget_exhausted", caught.exception.message)
        finally:
            proxy.WEB_SEARCH_REPORT_LIMIT = previous_limit

    def test_only_benchmark_task_receives_web_search_tool(self) -> None:
        benchmark = {"model": "gpt-5.5"}
        normal = {"model": "gpt-5.5"}
        proxy.apply_server_task_options(benchmark, "module_benchmark")
        proxy.apply_server_task_options(normal, "module_product_info")
        self.assertEqual(benchmark["tools"], [{"type": "web_search"}])
        self.assertEqual(benchmark["tool_choice"], "required")
        self.assertEqual(benchmark["include"], ["web_search_call.action.sources"])
        self.assertNotIn("tools", normal)

    def test_benchmark_request_is_converted_to_responses_api_shape(self) -> None:
        body = proxy.responses_request_body({
            "model": "gpt-5.6-sol",
            "messages": [
                {"role": "system", "content": "只使用可靠来源"},
                {"role": "user", "content": "搜索酸菜品牌"},
            ],
            "max_completion_tokens": 5000,
        })
        self.assertEqual(body["model"], "gpt-5.6-sol")
        self.assertEqual(body["instructions"], "只使用可靠来源")
        self.assertEqual(body["input"], [{"role": "user", "content": "搜索酸菜品牌"}])
        self.assertEqual(body["tool_choice"], "required")
        self.assertEqual(body["include"], ["web_search_call.action.sources"])
        self.assertEqual(body["tools"][0]["type"], "web_search")
        self.assertTrue(body["tools"][0]["external_web_access"])
        self.assertEqual(body["tools"][0]["return_token_budget"], "unlimited")
        self.assertEqual(body["reasoning"], {"effort": "high"})

    def test_responses_completed_event_exposes_text_usage_and_search_sources(self) -> None:
        event = {
            "type": "response.completed",
            "response": {
                "model": "gpt-5.6-sol",
                "usage": {"input_tokens": 120, "output_tokens": 30, "total_tokens": 150,
                          "input_tokens_details": {"cached_tokens": 20}},
                "output": [
                    {"type": "web_search_call", "id": "search-1", "action": {
                        "type": "search", "query": "酸菜品牌 天猫",
                        "sources": [{"title": "旗舰店", "url": "https://brand.tmall.com/store"}],
                    }},
                    {"type": "message", "content": [{"type": "output_text", "text": "真实结果"}]},
                ],
            },
        }
        usage = proxy.provider_usage(event)
        self.assertEqual(usage["input_tokens"], 120)
        self.assertEqual(usage["cached_input_tokens"], 20)
        self.assertEqual(proxy.responses_output_text(event["response"]), "真实结果")
        calls, evidence = proxy.search_event_details(event)
        self.assertIn({"callId": "search-1", "query": "酸菜品牌 天猫"}, calls)
        self.assertEqual(evidence[0]["url"], "https://brand.tmall.com/store")

    def test_benchmark_task_has_a_server_enforced_model_route(self) -> None:
        self.assertEqual(proxy.model_for_task("module_benchmark", "gpt-5.6-sol"), "gpt-5.6-sol")
        self.assertEqual(proxy.model_for_task("module_benchmark", "gpt-5.5"), "gpt-5.5")
        with self.assertRaises(proxy.ApiError):
            proxy.model_for_task("module_benchmark", "claude-sonnet-4-6")
        self.assertEqual(proxy.model_for_task("module_product_info", "gpt-5.5"), "gpt-5.5")

    def test_gpt56_sol_price_is_registered_without_changing_gpt55(self) -> None:
        self.assertEqual(proxy.MODEL_PRICES["gpt-5.5"], (1.25, 7.5, 0.125, 0.8))
        self.assertEqual(proxy.MODEL_PRICES["gpt-5.6-sol"], (1.25, 10.0, 0.125, 1.0))

    def test_structured_search_events_extract_only_public_evidence(self) -> None:
        calls, evidence = proxy.search_event_details({
            "type": "response.web_search_call.completed",
            "id": "search-1",
            "action": {
                "query": "酸菜品牌 天猫",
                "sources": [
                    {"title": "品牌旗舰店", "url": "https://example.tmall.com/store"},
                    {"title": "本机", "url": "http://127.0.0.1/private"},
                    {"title": "危险", "url": "javascript:alert(1)"},
                ],
            },
        })
        self.assertEqual(calls, [{"callId": "search-1", "query": "酸菜品牌 天猫"}])
        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0]["url"], "https://example.tmall.com/store")
        self.assertEqual(evidence[0]["platform"], "天猫")

    def test_citations_without_a_search_call_do_not_fake_an_invocation(self) -> None:
        calls, evidence = proxy.search_event_details({
            "choices": [{"delta": {"annotations": [{
                "type": "url_citation",
                "url_citation": {"title": "公开页面", "url": "https://example.com/page"},
            }]}}],
        })
        self.assertEqual(calls, [])
        self.assertEqual(len(evidence), 1)

    def test_large_report_modules_have_non_truncating_output_reserves(self) -> None:
        self.assertGreaterEqual(proxy.MAX_OUTPUT_TOKENS, 12_000)
        self.assertGreaterEqual(proxy.TASK_OUTPUT_RESERVES["module_material_review"], 10_000)
        self.assertGreaterEqual(proxy.TASK_OUTPUT_RESERVES["module_ranking"], 10_000)
        self.assertGreaterEqual(proxy.TASK_OUTPUT_RESERVES["module_audience_sp_scene"], 10_000)

    def test_same_running_task_is_not_submitted_twice(self) -> None:
        first_request_id = "d4f81b86-1a5b-4e39-830e-1271165bb8ee"
        second_request_id = "e4f81b86-1a5b-4e39-830e-1271165bb8ee"
        proxy.reserve_request(
            self.session, first_request_id, "report-a", "evidence:1", "summary",
            "gpt-5.5", 1, 1000, "report-a:evidence:1",
        )
        with self.assertRaises(proxy.ApiError) as caught:
            proxy.reserve_request(
                self.session, second_request_id, "report-a", "evidence:1", "summary",
                "gpt-5.5", 2, 1000, "report-a:evidence:1",
            )
        self.assertEqual(caught.exception.status, 409)
        self.assertIn("仍在服务器处理中", caught.exception.message)
        with proxy.database() as db:
            count = db.execute(
                "SELECT COUNT(*) FROM model_requests WHERE task_key='evidence:1'"
            ).fetchone()[0]
        self.assertEqual(count, 1)

    def test_stream_heartbeat_and_safe_completion_without_provider_done(self) -> None:
        class SlowStream:
            def __iter__(self):
                time.sleep(0.03)
                yield b'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'

        items = list(proxy.provider_stream_items(SlowStream(), heartbeat_seconds=0.005))
        self.assertTrue(any(kind == "heartbeat" for kind, _value in items))
        self.assertTrue(any(kind == "line" for kind, _value in items))
        self.assertTrue(proxy.provider_stream_completed(False, "stop", None, True))
        self.assertTrue(proxy.provider_stream_completed(False, "", {"input_tokens": 1}, True))
        self.assertFalse(proxy.provider_stream_completed(False, "", None, True))

    def test_heartbeat_starts_before_provider_returns_response_headers(self) -> None:
        class Stream:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def __iter__(self):
                yield b'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'

        def slow_open(*_args):
            time.sleep(0.03)
            return Stream()

        with patch.object(proxy, "open_provider_stream", side_effect=slow_open):
            items = list(proxy.provider_request_items((), b"{}", "request", heartbeat_seconds=0.005))
        self.assertEqual(items[0][0], "heartbeat")
        self.assertTrue(any(kind == "line" for kind, _value in items))

    def test_session_refresh_replaces_stale_proxy_balance_with_license_balance(self) -> None:
        payload = {
            "machine_code": self.session.machine_code,
            "license_id": self.session.license_id,
            "device_credential": self.session.device_credential,
            "device_session": self.session.device_session,
        }
        with patch.object(
            proxy, "verify_license",
            return_value=(self.session.code_id, 201_000, "primary", False),
        ):
            proxy.create_session(payload)
        with proxy.database() as db:
            wallet = db.execute(
                "SELECT balance_milli,total_topup_milli FROM wallets WHERE code_id=?",
                (self.session.code_id,),
            ).fetchone()
        self.assertEqual(wallet["balance_milli"], 201_000)
        self.assertEqual(wallet["total_topup_milli"], 500_000, "a balance refresh is not a new grant")

    def test_billing_failure_releases_lock_instead_of_creating_ghost_balance(self) -> None:
        request_id = "a4f81b86-1a5b-4e39-830e-1271165bb8ee"
        billing_id = "report-a:source_clean:file-1:batch-1"
        proxy.reserve_request(
            self.session, request_id, "report-a", "source:1", "source_clean",
            "gpt-5.5", 1, 1000, billing_id,
        )
        self.consume_mock.side_effect = proxy.ApiError(503, "temporary billing outage")
        proxy.settle_request(
            self.session, request_id, "success", "gpt-5.5",
            {"input_tokens": 1000, "output_tokens": 100, "cached_input_tokens": 0,
             "cache_creation_input_tokens": 0},
            1000, 300, True,
        )
        with proxy.database() as db:
            request = db.execute(
                "SELECT status,billing_request_id,billing_error FROM model_requests WHERE request_id=?",
                (request_id,),
            ).fetchone()
            locked = db.execute(
                "SELECT locked_milli FROM wallets WHERE code_id=?", (self.session.code_id,)
            ).fetchone()["locked_milli"]
        self.assertEqual(request["status"], "billing_failed")
        self.assertEqual(request["billing_request_id"], billing_id)
        self.assertIn("temporary", request["billing_error"])
        self.assertEqual(locked, 0)

    def test_retries_share_logical_task_but_bill_unique_upstream_attempts(self) -> None:
        logical_billing_id = "report-a:source_clean:file-1:batch-1"
        first_request_id = "1a4f81b8-1a5b-4e39-830e-1271165bb8ee"
        second_request_id = "2a4f81b8-1a5b-4e39-830e-1271165bb8ee"
        self.consume_mock.reset_mock()

        proxy.reserve_request(
            self.session, first_request_id, "report-a", "source:1", "source_clean",
            "gpt-5.5", 1, 1000, logical_billing_id,
        )
        proxy.settle_request(
            self.session, first_request_id, "success", "gpt-5.5",
            {"input_tokens": 1000, "output_tokens": 100, "cached_input_tokens": 0,
             "cache_creation_input_tokens": 0},
            1000, 300, True,
        )

        proxy.reserve_request(
            self.session, second_request_id, "report-a", "source:1", "source_clean",
            "gpt-5.5", 1, 1000, logical_billing_id,
        )
        proxy.settle_request(
            self.session, second_request_id, "success", "gpt-5.5",
            {"input_tokens": 1600, "output_tokens": 350, "cached_input_tokens": 0,
             "cache_creation_input_tokens": 0},
            1600, 900, True,
        )

        consume_ids = [call.args[2] for call in self.consume_mock.call_args_list]
        self.assertEqual(consume_ids, [first_request_id, second_request_id])
        with proxy.database() as db:
            rows = db.execute(
                "SELECT request_id,billing_request_id,status,attempt FROM model_requests "
                "WHERE request_id IN (?,?) ORDER BY request_id",
                (first_request_id, second_request_id),
            ).fetchall()
            wallet = db.execute(
                "SELECT locked_milli FROM wallets WHERE code_id=?", (self.session.code_id,)
            ).fetchone()
        self.assertEqual([row["billing_request_id"] for row in rows], [logical_billing_id, logical_billing_id])
        self.assertEqual([row["status"] for row in rows], ["success", "success"])
        self.assertEqual([row["attempt"] for row in rows], [1, 2])
        self.assertEqual(wallet["locked_milli"], 0)

    def test_legacy_amount_conflict_releases_reservation_without_second_charge(self) -> None:
        request_id = "3a4f81b8-1a5b-4e39-830e-1271165bb8ee"
        logical_billing_id = "report-a:source_clean:file-conflict:batch-1"
        proxy.reserve_request(
            self.session, request_id, "report-a", "source:conflict", "source_clean",
            "gpt-5.5", 2, 1400, logical_billing_id,
        )
        self.consume_mock.side_effect = proxy.ApiError(409, "request_id 已用于不同的消费请求。")
        proxy.settle_request(
            self.session, request_id, "success", "gpt-5.5",
            {"input_tokens": 1400, "output_tokens": 300, "cached_input_tokens": 0,
             "cache_creation_input_tokens": 0},
            1400, 900, True,
        )
        with proxy.database() as db:
            before = db.execute(
                "SELECT status,reserved_milli,billing_error FROM model_requests WHERE request_id=?",
                (request_id,),
            ).fetchone()
            locked_before = db.execute(
                "SELECT locked_milli FROM wallets WHERE code_id=?", (self.session.code_id,)
            ).fetchone()["locked_milli"]
        self.assertEqual(before["status"], "billing_failed")
        self.assertIn("不同的消费请求", before["billing_error"])
        self.assertEqual(locked_before, 0)

        self.consume_mock.reset_mock()
        self.consume_mock.side_effect = self.fake_consume
        proxy.retry_pending_billing(self.session)
        self.consume_mock.assert_not_called()
        with proxy.database() as db:
            after = db.execute(
                "SELECT status,charged_milli,billing_result_status,billing_error "
                "FROM model_requests WHERE request_id=?",
                (request_id,),
            ).fetchone()
            locked_after = db.execute(
                "SELECT locked_milli FROM wallets WHERE code_id=?", (self.session.code_id,)
            ).fetchone()["locked_milli"]
        self.assertEqual(after["status"], "billing_failed")
        self.assertEqual(after["charged_milli"], 0)
        self.assertEqual(after["billing_result_status"], "billing_failed")
        self.assertIn("不同的消费请求", after["billing_error"])
        self.assertEqual(locked_after, 0)

    def test_unlimited_license_is_not_blocked_by_zero_balance(self) -> None:
        self.session.unlimited = True
        with proxy.database() as db:
            db.execute(
                "UPDATE wallets SET balance_milli=0 WHERE app_name=? AND code_id=?",
                (proxy.APP_NAME, self.session.code_id),
            )
        request_id = "c4f81b86-1a5b-4e39-830e-1271165bb8ee"
        proxy.reserve_request(
            self.session, request_id, "report-unlimited", "summary:1", "summary",
            "gpt-5.5", 1, 1000, "report-unlimited:summary:1",
        )
        proxy.settle_request(
            self.session, request_id, "success", "gpt-5.5",
            {"input_tokens": 1000, "output_tokens": 100, "cached_input_tokens": 0,
             "cache_creation_input_tokens": 0},
            1000, 300, True,
        )
        with proxy.database() as db:
            request = db.execute(
                "SELECT status,charged_milli FROM model_requests WHERE request_id=?", (request_id,)
            ).fetchone()
        self.assertEqual(request["status"], "success")
        self.assertEqual(request["charged_milli"], 0)

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
        self.assertEqual(request["status"], "billing_pending")
        self.assertEqual(request["usage_source"], "estimated")
        self.assertGreater(request["charged_milli"], 0)
        self.assertGreater(wallet["locked_milli"], 0)
        self.assertEqual(wallet["balance_milli"], 500_000)
        proxy.retry_pending_billing(self.session)
        with proxy.database() as db:
            request = db.execute(
                "SELECT status FROM model_requests WHERE request_id=?", (request_id,)
            ).fetchone()
            wallet = db.execute(
                "SELECT balance_milli,locked_milli FROM wallets WHERE code_id=?", (self.session.code_id,)
            ).fetchone()
        self.assertEqual(request["status"], "interrupted_estimated")
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
            "remaining_credits": 100,
        }
        result.update(overrides)
        return result

    def test_authoritative_consume_uses_stable_hashed_billing_id(self) -> None:
        session = proxy.Session(
            token_hash="test", code_id="PRIMARY-001", machine_code="MACHINE-A",
            license_id="PRIMARY-001", device_credential="credential",
            device_session="session", expires_at=9_999_999_999,
        )
        captured = {}

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            @staticmethod
            def read(_limit):
                return json.dumps({
                    "ok": True,
                    "app_name": proxy.APP_NAME,
                    "code_id": "PRIMARY-001",
                    "remaining_credits": 80,
                    "unlimited": False,
                }).encode("utf-8")

        def fake_open(request, timeout):
            captured["body"] = json.loads(request.data.decode("utf-8"))
            captured["authorization"] = request.get_header("Authorization")
            captured["credential"] = request.get_header("X-device-credential")
            captured["timeout"] = timeout
            return Response()

        with patch.object(proxy, "urlopen", side_effect=fake_open):
            remaining, unlimited = proxy.consume_authoritative_credits(
                session, 20_000, "report-a:source_clean:file-1:batch-1", "product_operation_report:source_clean"
            )
        self.assertEqual(remaining, 80_000)
        self.assertFalse(unlimited)
        self.assertEqual(captured["body"]["amount"], 20)
        self.assertRegex(captured["body"]["request_id"], r"^por-[0-9a-f]{64}$")
        self.assertNotIn("source_clean", captured["body"]["request_id"])
        self.assertEqual(captured["authorization"], "Bearer session")
        self.assertEqual(captured["credential"], "credential")

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

    def test_machine_code_comparison_is_case_insensitive(self) -> None:
        code_id, points_milli, role = proxy.parse_license_response(
            self.valid_result(machine_code="B38301CAFA772CE3EAAFB1227B63125B"),
            200,
            "b38301cafa772ce3eaafb1227b63125b",
            {"primary"},
        )
        self.assertEqual(code_id, "PRIMARY-001")
        self.assertEqual(points_milli, 100_000)
        self.assertEqual(role, "primary")

    def test_main_and_topup_code_roles_are_not_interchangeable(self) -> None:
        with self.assertRaises(proxy.ApiError):
            proxy.parse_license_response(
                self.valid_result(code_role="auto_topup"), 200, "MACHINE-A", {"primary", "legacy_manual"}
            )
        with self.assertRaises(proxy.ApiError):
            proxy.parse_license_response(
                self.valid_result(code_role="primary"), 200, "MACHINE-A", {"auto_topup"}
            )

    def test_explicit_zero_remaining_credits_never_reissues_granted_points(self) -> None:
        code_id, points_milli, role = proxy.parse_license_response(
            self.valid_result(remaining_credits=0),
            200,
            "MACHINE-A",
            {"primary"},
        )
        self.assertEqual(code_id, "PRIMARY-001")
        self.assertEqual(points_milli, 0)
        self.assertEqual(role, "primary")

    def test_legacy_remaining_points_is_accepted_when_unambiguous(self) -> None:
        response = self.valid_result()
        response.pop("remaining_credits")
        response["remaining_points"] = 25
        _, points_milli, _ = proxy.parse_license_response(
            response, 200, "MACHINE-A", {"primary"}
        )
        self.assertEqual(points_milli, 25_000)

    def test_conflicting_credit_fields_are_rejected(self) -> None:
        response = self.valid_result(remaining_credits=100, remaining_points=99)
        with self.assertRaises(proxy.ApiError):
            proxy.parse_license_response(response, 200, "MACHINE-A", {"primary"})

    def test_authenticated_device_status_can_default_to_primary_role(self) -> None:
        response = self.valid_result()
        response.pop("code_role")
        response.update({
            "primary_code_id": "PRIMARY-001",
            "primary_activation_code": "",
            "transfer_count": 0,
            "balance_mode": "server_managed",
            "balance_authoritative": True,
            "unlimited": False,
            "entitlement_type": "credits",
        })
        code_id, points_milli, role = proxy.parse_license_response(
            response, 200, "MACHINE-A", {"primary", "legacy_manual"}, default_role="primary"
        )
        self.assertEqual(code_id, "PRIMARY-001")
        self.assertEqual(points_milli, 100_000)
        self.assertEqual(role, "primary")

    def test_activation_response_cannot_omit_code_role(self) -> None:
        response = self.valid_result()
        response.pop("code_role")
        with self.assertRaises(proxy.ApiError):
            proxy.parse_license_response(response, 200, "MACHINE-A", {"auto_topup"})

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
                "remaining_credits": 100,
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
                    self.valid_result(remaining_credits=invalid_points), 200, "MACHINE-A", {"primary"}
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
