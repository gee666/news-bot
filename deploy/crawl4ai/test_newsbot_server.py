"""Run inside the pinned image: python -m unittest test_newsbot_server -v."""
import copy
import os
import unittest

os.environ["CRAWL4AI_API_TOKEN"] = "unit-test-token"

from fastapi.testclient import TestClient
from crawl4ai import BrowserConfig, CrawlerRunConfig
from crawl4ai.cache_context import CacheContext, CacheMode
from crawl4ai.async_configs import Provenance, UntrustedConfigError
from egress_broker import ALLOW_INTERNAL, ALLOW_INSECURE_TLS, enforce_egress
from utils import load_config
import newsbot_server as wrapper


class RequestContractTests(unittest.TestCase):
    def test_exact_payload(self):
        self.assertTrue(wrapper.supported_configs(
            wrapper.EXPECTED_BROWSER_CONFIG, wrapper.EXPECTED_CRAWLER_CONFIG))

    def test_disabled_cache_never_reads_or_writes(self):
        config = CrawlerRunConfig.load(wrapper.EXPECTED_CRAWLER_CONFIG, provenance=Provenance.UNTRUSTED)
        self.assertEqual(config.cache_mode, CacheMode.DISABLED)
        for mode in [CacheMode.BYPASS, config.cache_mode]:
            cache = CacheContext("https://example.com/", mode, False)
            self.assertFalse(cache.should_read())
            self.assertFalse(cache.should_write())
        self.assertTrue(CacheContext("https://example.com/", CacheMode.ENABLED, False).should_write())

    def test_changed_and_extra_fields_rejected(self):
        for key, value in {
            "cache_mode": {"type": "CacheMode", "params": "bypass"},
            "word_count_threshold": 5,
            "excluded_tags": ["nav", "footer", "aside", "header", "table"],
            "page_timeout": 120000,
            "markdown_generator": {"type": "PruningContentFilter", "params": {}},
            "js_code": "document.body.innerHTML='fake'",
        }.items():
            with self.subTest(key=key):
                run = copy.deepcopy(wrapper.EXPECTED_CRAWLER_CONFIG)
                run["params"][key] = value
                self.assertFalse(wrapper.supported_configs(wrapper.EXPECTED_BROWSER_CONFIG, run))
        browser = copy.deepcopy(wrapper.EXPECTED_BROWSER_CONFIG)
        browser["params"]["headless"] = 1
        self.assertFalse(wrapper.supported_configs(browser, wrapper.EXPECTED_CRAWLER_CONFIG))
        browser = copy.deepcopy(wrapper.EXPECTED_BROWSER_CONFIG)
        browser["extra"] = "unexpected"
        self.assertFalse(wrapper.supported_configs(browser, wrapper.EXPECTED_CRAWLER_CONFIG))

    def test_missing_fields_rejected(self):
        for field in wrapper.EXPECTED_CRAWLER_CONFIG["params"]:
            run = copy.deepcopy(wrapper.EXPECTED_CRAWLER_CONFIG)
            del run["params"][field]
            self.assertFalse(wrapper.supported_configs(wrapper.EXPECTED_BROWSER_CONFIG, run))

    def test_merged_security_defaults_preserved(self):
        config = load_config()
        security = config["security"]
        self.assertEqual(security["trusted_hosts"], ["crawl4ai", "localhost", "127.0.0.1"])
        self.assertTrue(security["enabled"])
        self.assertFalse(security["jwt_enabled"])
        self.assertEqual(security["cors_allow_origins"], [])
        self.assertEqual(security["headers"]["x_content_type_options"], "nosniff")
        self.assertFalse(ALLOW_INTERNAL)
        self.assertFalse(ALLOW_INSECURE_TLS)
        browser = BrowserConfig(ignore_https_errors=True)
        enforce_egress(browser)
        self.assertFalse(browser.ignore_https_errors)
        with self.assertRaises(UntrustedConfigError):
            BrowserConfig.load({"type": "BrowserConfig", "params": {
                "proxy_config": {"server": "http://unsafe:3128"}}}, provenance=Provenance.UNTRUSTED)

    def test_host_guard_and_auth(self):
        client = TestClient(wrapper.app, base_url="http://crawl4ai:11235")
        for host in ["crawl4ai:11235", "localhost:11235", "127.0.0.1:11235"]:
            self.assertEqual(client.get("/health", headers={"Host": host}).status_code, 200)
        for host in ["attacker.example", "crawl4ai.attacker.example", "172.18.0.2:11235"]:
            self.assertEqual(client.get("/health", headers={"Host": host}).status_code, 400)
        payload = {"urls": ["https://example.com/"],
                   "browser_config": wrapper.EXPECTED_BROWSER_CONFIG,
                   "crawler_config": wrapper.EXPECTED_CRAWLER_CONFIG}
        self.assertEqual(client.post("/crawl", json=payload).status_code, 401)
        self.assertEqual(client.post("/crawl", json=payload,
                         headers={"Host": "attacker.example", "Authorization": "Bearer unit-test-token"}).status_code, 400)


if __name__ == "__main__":
    unittest.main()
