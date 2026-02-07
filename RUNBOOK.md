# Corebot Runbook

## 1) Startup Checklist

1. Run `pnpm install --frozen-lockfile`.
2. Verify config and secrets (`OPENAI_API_KEY`, webhook token, MCP allowlists).
3. Start service (`pnpm run dev` or `node dist/main.js`).
4. Check health endpoints:
   - `GET /health/live` should be `200`.
   - `GET /health/startup` should be `200`.
   - `GET /health/ready` should be `200`.

## 2) Runtime Monitoring

1. Scrape `GET /metrics` for:
   - `corebot_queue_pending`
   - `corebot_queue_dead_letter`
   - `corebot_tools_failure_rate`
   - `corebot_scheduler_max_delay_ms`
   - `corebot_mcp_failure_rate`
2. For on-demand diagnostics use `GET /status`.
3. If SLO alerts are enabled, check logs and optional `COREBOT_SLO_ALERT_WEBHOOK_URL` sink.

## 3) Queue / DLQ Operations

1. List dead-letter entries:
   - CLI: `/dlq list [inbound|outbound|all] [limit]`
   - Tool: `bus.dead_letter.list`
2. Replay dead-letter entries:
   - CLI: `/dlq replay <queueId|inbound|outbound|all> [limit]`
   - Tool: `bus.dead_letter.replay`
3. If queue overflow/rate-limit drops happen repeatedly:
   - increase `COREBOT_BUS_MAX_PENDING_*` carefully,
   - tune `COREBOT_BUS_CHAT_RATE_*`,
   - investigate noisy chats and failing tools.

## 4) Database Backup / Restore

1. Create backup:
   - `pnpm run ops:db:backup -- --db data/bot.sqlite`
2. Restore backup (service must be stopped):
   - `pnpm run ops:db:restore -- --db data/bot.sqlite --from <backup.sqlite> --force`
3. Restore script writes a pre-restore snapshot beside DB before overwrite.

## 5) Migration Failure Recovery

1. On migration failure, startup error includes `Restore backup: <path>`.
2. Stop service immediately.
3. Restore using the reported backup path.
4. Inspect `migration_history` table and fix migration/root cause before retry.

## 6) Security / Audit Review

1. MCP usage should be constrained with:
   - `COREBOT_MCP_ALLOWED_SERVERS`
   - `COREBOT_MCP_ALLOWED_TOOLS`
2. Tool execution audit is stored in `audit_events`:
   - denials (`outcome=denied`)
   - errors (`outcome=error`)
   - success (`outcome=success`)
3. Sensitive args are redacted in audit JSON for keys like `token`, `secret`, `password`, `key`.

## 7) Webhook Channel Ops

1. Inbound endpoint: `POST <COREBOT_WEBHOOK_PATH>`.
2. Outbound pull endpoint: `GET <COREBOT_WEBHOOK_PATH>/outbound?chatId=<id>&limit=<n>`.
3. Use `COREBOT_WEBHOOK_AUTH_TOKEN` and send token via:
   - `Authorization: Bearer <token>`, or
   - `x-corebot-token`.
