# Telegram setup

From the project root, install the project's dependencies and use an interactive terminal:

```bash
npm run cli -- login
npm run cli -- discover
npm run cli -- smoke
npm run cli -- smoke --source -1001234567890 --limit 3 --output tmp/telegram-samples.json
```

The equivalent development invocation is:

```bash
npx tsx --env-file-if-exists=.env src/cli.ts login
```

Login needs an existing Telegram user account and an API ID/hash from https://my.telegram.org. Set TELEGRAM_API_ID and TELEGRAM_API_HASH server-side, or enter them when prompted. Enter your phone number with its country code, then the Telegram login code and any two-step-verification password. All input is hidden, including API credentials. Codes and passwords are never saved. No automatic account registration or channel joining is implemented.

Set TELEGRAM_SESSION_DIR to a persistent private directory. Its default is tmp/telegram-session. The application restricts the directory to 0700 and session/credential files to 0600. Treat both session.txt and api.json as secrets. Do not commit, inspect, paste or share them. Mount a private volume at the configured path for containers, and run login with an attached terminal. The application must run as the owner of that directory.

Login does not need PostgreSQL. Discovery does; it applies migrations, resolves TELEGRAM_DESTINATION through CheckChatInvite and stores its Bot API numeric ID in operational_state under telegram_destination. The default invite is the destination specified in IMPLEMENTATION_PLAN.md. If Telegram returns only invite metadata without a numeric ID, the command stops without joining. Add the account to the destination yourself and rerun discovery.

Discovery includes subscribed broadcast channels, including archived channels. It excludes private chats, groups and the destination. Rerun discover to refresh subscriptions. Departed channels become inactive without deleting content; manually disabled sources stay disabled.

Smoke samples active, enabled sources only. It defaults to three channels and three usable text/caption messages per channel, scanning at most fifteen recent messages each. Options are --source with a source UUID or Telegram numeric ID, --channels from 1 to 20, --limit from 1 to 10, and --output with a new file under tmp/. Output files are 0600 and are never overwritten. Without --output, samples go to the terminal. Smoke does not apply migrations, save items, advance cursors, mark messages read, increment views, join channels or publish. Keep private samples local and out of Git. Do not send them to external inference without separate approval.

## Integration

src/telegram/batch.ts exports collectTelegramBatch(batchId: string, cutoff: Date, windowHours = 48): Promise<number>. The caller owns the singleton batch and its saved cutoff. The collector saves per-source batch membership, changed source-independent items/revisions/links, and the cursor transactionally. Completed sources are skipped on resume. Failed sources retain their previous cursor and can retry.

Collection scans the rolling window again to find edits behind the high-water mark. It ignores posts and edits after the cutoff and media-only messages. Hidden-target changes create revisions even when visible text is unchanged. Repeated unchanged items do not enter another batch. Item retention timestamps never advance during refetches.

All link spans use UTF-16 code units in original_text, not normalized_text. URLs are retained as evidence, including non-HTTP targets; downstream fetching and rendering must enforce their own scheme policy. Telegram provider identity and access data belong in metadata or the source cursor, not mandatory source-item columns. Restricted Telegram origins use access-restricted t.me/c links; they are not public links.

This module makes no model calls and sends no Telegram messages. Destination bot send/edit verification and enabling publication remain separate steps.
