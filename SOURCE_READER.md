# Rendered sources and evidence resolution

## Reader selection

The app uses [Crawl4AI](https://github.com/unclecode/crawl4ai), pinned to version 0.9.4 and an image digest in `deploy/crawl4ai/Dockerfile`.

GitHub's 2026-10-01 snapshot showed 84,587 stars for Crawl4AI and 187,272 for Firecrawl. Crawl4AI fits this deployment because its self-hosted API renders JavaScript and returns Markdown without a paid extraction API or a separate LLM extraction call. It is Apache-2.0 licensed. Stars indicate adoption, not a guarantee of extraction accuracy or access to protected sites.

## Deployment and limits

Compose now runs the app, PostgreSQL and Crawl4AI. The crawler has no published host port and does not share the database network. It requires the private `CRAWL4AI_API_TOKEN`; the app sends that token only to the configured crawler service, not to target websites.

The crawler runs one browser job at a time, with two CPUs, 1536 MiB RAM and 256 MiB shared memory. Each request gets a fresh browser context. It receives no user-account cookies or Pi/Telegram credentials. SDK page caching is disabled; article retention belongs to PostgreSQL.

The pinned service validates and DNS-pins public targets, including redirects and subresources. Private/metadata targets are blocked. The API wrapper accepts only the fixed crawl configuration and health requests. Certificate checks remain enabled. Chromium still uses the upstream container's no-sandbox mode; container isolation is not a claim that renderer exploits are impossible.

## Reading behavior

Configured research reads use Crawl4AI first. JavaScript remains enabled, with bounded rendering delay and scrolling. Navigation, footer and aside elements are excluded; headings, tables and short numeric rows are retained.

A completed HTTP-200 loading-error shell gets up to two delayed retries within the same crawler deadline. If rendering or article extraction still fails, one HTTP reader attempt can recover static content. HTTP transport errors and temporary statuses get at most two attempts by default, configurable with `RESEARCH_HTTP_MAX_ATTEMPTS` up to three. Login redirects, access challenges and load-error screens are never article content. Restricted targets are not retried through a bypass.

Failed pages and superseded assessments retain their story associations for diagnostics. Their short cache expiry permits another read; it is not the diagnostic retention period. Publication accepts only read public relevant evidence with a current primary/supporting assessment. Raw link anchors and archived judgments cannot bypass that gate.

`RESEARCH_PREFERRED_DOMAINS` controls fetch order only. It does not grant authority. `researchMaxPages`, default 5, caps visited page URLs, including irrelevant reads, uncertain reads, failed fetches and cached documents. Already-seen normalized URLs, including known redirect destinations, do not get another slot. This is a work limit, not a target of five relevant pages. Reader transport retries remain bounded separately. All supplied source URLs remain stored even when a fetch fails. Events at or above `researchThreshold`, default 5, reserve a bounded primary-search allowance even if supplied links fill the reading quota. The default search budget is two. The one-time migration intentionally enables this single user's existing zero search budget because they requested primary searches at score 5 and above. It changes the legacy threshold 7 to 5 for that profile, without replacing their interest profile or versions. An explicit zero still disables search after migration. Searches can seek lawful author manuscripts, open-access publications and institutional repositories, never paywall circumvention.

The reader removes exact repeated rows only from explicitly animated containers, so a looping demonstration cannot displace product and pricing sections during article selection. Static repeated observations and tables stay intact. Up to two observed announcement, paper or pricing links become discovery candidates and share the existing research page budget; their target content must still be read and assessed.

X/Twitter status pages are read by exact post ID and author handle, not generic article selection across replies. Up to two separately labeled same-author posts actually present on the page can establish operational involvement. A missing requested post stays unavailable; previews, badges and unread employee assertions do not grant authority. A read involved party's own announcement can be primary regardless of platform. For incident news, a venue's general rankings page stays supporting background unless its text establishes the incident itself. Own product documentation, such as Bento's actual editor features, and original research explaining a reported method can still be primary for their stated claims.

arXiv abs/PDF/HTML references prefer official full-paper HTML, retaining the original abstract citation and any explicitly requested revision. A full-paper result requires an actual LaTeXML document and matching paper/version identity, not a generic HTML shell. Sections, tables and MathML presentation numbers are retained. The existing character limit still bounds the stored/model excerpt, with truncation explicit.

If full HTML is unavailable or cannot be verified, one matching abstract representation is tried. Metadata records `paper.extent`, observed version, actual `readUrl`, representation-read count and the full-text failure. At most two representations are read for one paper, and both consume the existing research page budget. If only one slot remains, an unavailable HTML read cannot trigger another fetch. Same-paper representation aliases and verified revision aliases do not trigger repeated assessments. Transport retries remain separately bounded. No unread PDF is called full text. Abstracts support only their stated claims; absence from an abstract or truncated excerpt is not proof of absence from the paper. No PDF dependency was added.

Publication/update dates are recorded only when explicitly supplied by the publisher metadata. Retrieval time is not used as publication time, and dates on related article cards are not borrowed.

## Editorial changes

The generation pipeline now builds a cited evidence brief before drafting:

- The event comes from the collected reports, not whichever fetched page is easiest to read.
- Incidental reseller offers do not replace a model-release story.
- Claims retain their source IDs and exact supporting spans.
- Current terms, historical comparisons, disputes and superseded rumors are distinguished.
- Primary means the author of the information: a firsthand statement, original research, interview or investigation. Platform does not decide authority. Luna assesses exact read support per claim; primary sources outrank professional reporting, which outranks discovery/reposts. A newspaper's own investigation can be primary, while a newspaper quoting another report may not be.
- Required prices, limits, baselines, capabilities and availability are checked against the actual draft. A contract listing fact IDs alone is insufficient.
- Secondary timestamps cannot supply a missing official date or override newer official terms.

Terminal editorial validation failures withhold the affected story, preserve its published snapshot and remain visible in processing status. They no longer stop independent stories from completing. Unchanged failures are not repeatedly sent to the model; changed evidence or explicit correction can retry them. Provider outages and rate limits still pause requests normally.

## Live checks

Fresh-context service probes retrieved the actual OpenAI Sol release, Pro-plan help page and DevDay recap. A delayed JavaScript fixture inserted a pricing table after initial HTML; Markdown included its headings and numeric rows. Cookie isolation, private-target rejection, authentication, host checks and single-job limits were tested.

Actual isolated application runs then fetched those pages through Crawl4AI, assessed them and ran generation:

- Sol passed with a release-focused headline, no DS Lab focus drift, and all ten required facts covered.
- Combined Pro pricing passed with $200/$500, 20× to 10×, 25×, scoped 300 tokens/s and the October 29 transition, with 23 required facts covered.

Those runs used real public source material and models but disposable database schemas. They are not evidence that every existing channel message has already been rewritten.

The fetched official pages did not state every numeric multiplier used in the pricing case. Those particular figures remained attributed to the collected secondary reports. The software must not credit OpenAI with a number merely because an official link appears below the post.

## Curated publisher sources

The app can collect configured RSS/Atom feeds and publisher websites alongside Telegram, on the existing three-hour collection schedule in fixed UTC+02:00. Collection uses the batch cutoff and source publication dates; eligible entries are processed oldest to newest. Missing publication dates are skipped by default. An operator may explicitly choose `collect_once`; these records retain `published_at = null` and are not assigned a fabricated publication date. Collected edits create revisions and update the existing story/post when matched.

Manage publisher sources in the app's source settings panel. Five predefined sources are available for seeding: OpenAI and Anthropic news websites, plus Google AI, NVIDIA and Hugging Face feeds. Review each source's publisher, URL and allowed article path prefixes. Invalid stored entries are isolated; disable a broken entry rather than deleting its history. Once items have been collected, changing a source's kind or URL is blocked to preserve identity; add a replacement source instead. Disabling a source stops future collection without deleting collected items or publication history.

Each source has a configurable per-collection article budget from 1 to 5; the predefined sources use 2. The collection interval is the existing `collectionCron` setting, defaulting to every three hours. A publisher label or configured domain is not proof of authority; evidence roles remain story- and claim-specific. Availability of source configuration does not establish that production collection has run or that new articles have been published.
