# Private Crawl4AI service

Build this directory. The base image is the official Crawl4AI 0.9.4 image pinned by digest. No Python dependency installation is needed.

The wrapper retains the official `/crawl` implementation, token authentication, untrusted-config parser and DNS-pinning egress broker. It changes browser lifecycle: no startup browser, no browser pool, one request at a time, new browser per job, close on success/error. Only `POST /crawl` and `/health` remain enabled. Other APIs, user cookies, persistent sessions, hooks, caller JS and arbitrary browser configuration are unavailable. Website JavaScript remains enabled.

The official library adds certificate-bypass flags after its own egress guard has scrubbed the configuration. The wrapper removes those flags and the automation-concealment flag from generated Chromium launch arguments. Chromium still uses the official image's `--no-sandbox`. Keep the container unprivileged, with no host mounts except a read-only token, no Docker socket and no access to database networks. Running Chromium with a renderer sandbox needs separate host seccomp/user-namespace work; it was not claimed here.

Root integration requirements:

- Build `./deploy/crawl4ai`, cap `cpus: 2`, `mem_limit: 1536m`, `shm_size: 256m`. Do not publish any host ports.
- Set `CRAWL4AI_API_TOKEN` via a mounted `/run/secrets/api_token` readable by UID 999, or a protected environment injection. Do not print it. The image refuses an unauthenticated non-loopback bind.
- Put crawler and app on a dedicated private network, not the database network. The standard deployment uses the built-in DNS-pinning egress broker, no app proxy. Drop all capabilities and set `no-new-privileges:true`. No extra proxy/server integration is needed.
- Set app `RESEARCH_CRAWLER_URL=http://crawl4ai:11235` and `RESEARCH_CRAWLER_API_TOKEN` to the matching secret. These are administrator settings, never user inputs.
- Optional adapter limits are `RESEARCH_CRAWLER_TIMEOUT_MS` default 60000, `RESEARCH_CRAWLER_MAX_BYTES` default 5000000 with no model-input character cap. The service enforces a 16KiB request body cap, 40s crawl deadline and 55s request deadline including browser startup. A concurrent request gets 429 rather than queuing unbounded work.

The Host allowlist is exactly `crawl4ai`, `localhost`, `127.0.0.1`, with ports accepted by the official Host middleware. App calls `http://crawl4ai:11235`; health checks use localhost. Other Host headers return 400. The config explicitly keeps security enabled, bearer authentication and deny-by-default CORS, retaining merged security headers and official egress guards.

The wrapper accepts only the adapter's exact fixed BrowserConfig/CrawlerRunConfig values. Cleaning excludes `nav`, `footer`, `aside`, not `header` or `table`. Word threshold remains 1. CacheMode is `disabled`, so the SDK neither reads nor writes per-crawl HTML/markdown cache. Both BYPASS and DISABLED disable writes in pinned 0.9.4; DISABLED makes the no-persistence contract explicit. There is no service-side pruning filter or fitted-markdown selection. The app uses full raw Markdown for website indexes. Article-purpose reads apply Mozilla Readability to the returned rendered HTML, then convert the selected article to CommonMark/GFM with tables. Images and explicit links are preserved in that article, but assets/navigation are not evidence candidates. Missing/unreadable article HTML fails closed, never falls back to page-wide Markdown. The crawler request/wrapper contract is unchanged. Changing configuration values or adding fields returns 400, so deploy updated client and image together.

The 0.9.4 API forbids `BrowserConfig.proxy_config` in request JSON with HTTP 400. Do not enable it or strip that security check. The server sets `BrowserConfig.proxy_config` to its own pinning proxy. No app upstream-proxy integration is used.

Configured research reads use `fetchCrawlerPage(url)` from `src/pipeline/crawler-client.ts` before the HTTP reader. It returns `ResearchPage` plus `publishedAt`. It requires the normalized original result URL to equal the requested URL, independently validates public final redirect URLs, parses the exact response with Zod, uses `markdown.raw_markdown`, bounds body/text and rejects HTTP errors, challenges, empty output and known SPA load-error shells. Only a completed successful HTTP 200 SPA load-error shell gets one retry after 1000ms, using a fresh service context and the same total configured deadline. Challenges, HTTP errors, blocked URLs, malformed replies and in-flight timeouts are not retried. It does not write evidence/source roles or infer authority from successful rendering. No publication timestamp is inferred from related article cards or page prose.

Live probe details and limitations are in `tmp/crawler-deployment-probe.md`; Host/cleaning follow-up evidence is in `tmp/crawler-host-cleaning-report.md`. Final cache/no-write and result-identity checks are in `tmp/crawler-cache-identity-report.md`. Wrapper unit tests run inside the pinned image with `python -m unittest test_newsbot_server -v`, mounting `test_newsbot_server.py` into `/app` read-only. Probe scripts use generated disposable secrets; regenerate one before rerunning. Production app/db were not restarted or modified.

## Reading behavior

Research preserves headings, tables and numeric rows. Article publication/update dates come only from explicit publisher metadata, never retrieval time or related-article cards. Login redirects, access challenges and loading-error screens are not article content, and restricted targets are not bypassed.

Reader failures can fall back to a bounded HTTP attempt. Research page and search budgets still apply; a preferred domain changes fetch order, not authority. Exact social posts are selected by post identity, and arXiv reads verify paper/version identity before describing a result as full text. See [source collection](../../src/sources/README.md) for publisher ingestion and [processing](../../src/pipeline/README.md) for research and generation.
