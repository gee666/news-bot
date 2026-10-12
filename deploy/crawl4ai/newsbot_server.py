"""Keep the official /crawl API and egress guards, but never pool browser state."""
import asyncio
import json

import crawler_pool
from crawl4ai import AsyncWebCrawler
from crawl4ai.browser_manager import BrowserManager
from fastapi.responses import JSONResponse


original_browser_args = BrowserManager._build_browser_args


def verified_browser_args(manager):
    launch = original_browser_args(manager)
    # 0.9.4 adds these unconditionally after enforce_egress scrubs config.
    # Keep certificate checks and the normal browser automation identity.
    launch["args"] = [arg for arg in launch["args"] if not arg.startswith((
        "--ignore-certificate-errors", "--disable-blink-features=AutomationControlled"))]
    return launch


BrowserManager._build_browser_args = verified_browser_args


async def no_permanent_browser(_config):
    return None


async def fresh_crawler(config):
    crawler = AsyncWebCrawler(config=config)
    try:
        await crawler.start()
    except BaseException:
        await crawler.close()
        raise
    return crawler


async def close_crawler(crawler):
    await crawler.close()


# api.py imports these functions at request time. Keep official SSRF, auth,
# untrusted-config deserialization, body limits and response serialization.
crawler_pool.init_permanent = no_permanent_browser
crawler_pool.get_crawler = fresh_crawler
crawler_pool.release_crawler = close_crawler

from server import app  # noqa: E402

busy = False

EXPECTED_BROWSER_CONFIG = {
    "type": "BrowserConfig",
    "params": {"headless": True, "java_script_enabled": True, "text_mode": False},
}
EXPECTED_CRAWLER_CONFIG = {
    "type": "CrawlerRunConfig",
    "params": {
        "cache_mode": {"type": "CacheMode", "params": "disabled"},
        "word_count_threshold": 1,
        "excluded_tags": ["nav", "footer", "aside"],
        "wait_until": "domcontentloaded",
        "page_timeout": 30000,
        "delay_before_return_html": 3,
        "scan_full_page": True,
        "max_scroll_steps": 5,
        "scroll_delay": 0.3,
    },
}


def supported_configs(browser, run):
    # Comparing serialized JSON also distinguishes Python True from numeric 1.
    return (json.dumps(browser, sort_keys=True) == json.dumps(EXPECTED_BROWSER_CONFIG, sort_keys=True)
            and json.dumps(run, sort_keys=True) == json.dumps(EXPECTED_CRAWLER_CONFIG, sort_keys=True))


@app.middleware("http")
async def single_job(request, call_next):
    global busy
    if request.url.path == "/health":
        return await call_next(request)
    if request.url.path != "/crawl" or request.method != "POST":
        return JSONResponse({"error": "endpoint_disabled"}, status_code=404)
    if busy:
        return JSONResponse({"error": "crawler_busy"}, status_code=429)
    busy = True
    try:
        async with asyncio.timeout(55):
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 16384:
                    return JSONResponse({"error": "body_too_large"}, status_code=413)
            try:
                payload = json.loads(body)
            except (ValueError, UnicodeDecodeError):
                return JSONResponse({"error": "invalid_json"}, status_code=400)
            if (not isinstance(payload, dict)
                    or set(payload) - {"urls", "browser_config", "crawler_config"}
                    or not isinstance(payload.get("urls"), list)
                    or len(payload["urls"]) != 1):
                return JSONResponse({"error": "single_url_required"}, status_code=400)
            browser = payload.get("browser_config", {})
            run = payload.get("crawler_config", {})
            if not supported_configs(browser, run):
                return JSONResponse({"error": "unsupported_config"}, status_code=400)
            # Starlette caches body for call_next after request.stream().
            request._body = bytes(body)
            return await call_next(request)
    except TimeoutError:
        return JSONResponse({"error": "crawl_timeout"}, status_code=504)
    finally:
        busy = False
