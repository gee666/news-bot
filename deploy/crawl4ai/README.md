# Shared host Crawl4AI service

The crawler now lives in `/home/oira666/Work/crawl4ai` and runs outside Docker as `crawl4ai.service` in the deployment user's systemd manager. That project's README, service code and tests define the browser lifecycle, API authentication, sandbox and DNS-pinned egress rules. There is no newsbot-owned crawler image to build.

Host applications use `http://127.0.0.1:11235`. Newsbot's Compose app mounts `${CRAWL4AI_SOCKET_DIR:-../crawl4ai/tmp/api}` read-only at `/run/crawl4ai` and uses the Unix socket there. `RESEARCH_CRAWLER_DOCKER_URL` remains the request identity, default `http://host.docker.internal:11235`; the Undici dispatcher connects over the socket, not TCP. The container's node UID must match the service UID, currently 1000. Mount the directory rather than the socket inode so a service restart remains visible. UFW currently blocks Docker-to-host TCP; no firewall changes were made. Set `CRAWL4AI_API_TOKEN` to a credential authorized by the shared service. Its API must not bind a LAN or wildcard address.

The adapter in `src/pipeline/crawler-client.ts` retains the exact typed single-URL payload and validates result identity, final redirects, response size, and article readability. Ordinary `/crawl` reads use headless Chromium. With `RESEARCH_CRAWLER_HEADED_FALLBACK=true`, blocked or unreadable pages get one `/crawl/headed` attempt within the same total deadline. Both endpoints use the same restricted caller configuration; the service owns the browser mode. Login and verification screens remain restricted content, not evidence.

The service starts with two concurrent jobs and reuses up to two browser processes across modes. Each request gets isolated contexts. It does not use your personal Chromium profile or preserve verification cookies. Headed reads require the host graphical session and do not guarantee access to bot-protected websites.

For migration and root-owned watchdog updates, see [Linux deployment](../../docs/linux-deployment.md#shared-host-crawler). Old crawler Docker deployment files have been retired. Keep the previous image until rollback is no longer needed.

## Personal Chromium fallback

`RESEARCH_CRAWLER_PERSONAL_FALLBACK=true` lets newsbot request `/crawl/personal` instead of `/crawl/headed` for exact HTTPS Binance announcement-detail URLs. This option defaults to false. The host service must separately authorize the newsbot principal and enable its own personal-browser policy. Other clients cannot select newsbot's browser, and request payloads cannot supply CDP endpoints.

On Chromium versions with the built-in option, open `chrome://inspect/#remote-debugging`, select "Allow remote debugging for this browser instance", and approve the local client's connection. The desktop browser does not need restarting. The modern endpoint may lack `/json/version`; the service reads the direct WebSocket address from the operator-configured `DevToolsActivePort` file. Never publish that file or endpoint. The listener must be loopback-only.

The service keeps a CDP connection and creates only its own tabs in the regular profile. Unlike ordinary crawler contexts, these reads use the user's existing cookies and are not DNS-pinned or session-isolated. This is a narrow operator-approved exception for public Binance announcements, not a general-purpose personal-browser API. Cookies are not exported. Existing user tabs and browser-wide settings must not be changed. Chrome may require approval again after the service or browser reconnects; unavailable personal Chrome preserves the restricted diagnosis rather than falling through to unapproved browsing.
