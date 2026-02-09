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
   - `corebot_heartbeat_calls_total`
   - `corebot_heartbeat_scope_sent_total{scope="delivery"}`
   - `corebot_heartbeat_scope_skipped_total{scope="delivery"}`
2. For on-demand diagnostics use `GET /status`.
3. If SLO alerts are enabled, check logs and optional `COREBOT_SLO_ALERT_WEBHOOK_URL` sink.
4. Use admin tool `heartbeat.status` to inspect runtime enablement, next due chats, and active config.

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

## 8) Circuit Breaker Recovery (Isolated Runtime)

When a high-risk tool (e.g., `shell.exec`) fails consecutively, the circuit breaker opens:

1. **Symptom**: tool calls return `Isolated runtime circuit open for <tool> until <time>`.
2. **Automatic recovery**: the circuit resets after `COREBOT_ISOLATION_CIRCUIT_RESET_MS` (default 30s).
3. **Manual recovery**: restart the process to immediately reset all circuits.
4. **Root cause investigation**:
   - Check logs for `isolated runtime circuit opened after repeated failures`.
   - Look at the `error` field for the underlying failure reason.
   - Common causes: workspace path issues, command not found, network errors, worker crashes.
5. **Tuning**:
   - Increase `COREBOT_ISOLATION_OPEN_CIRCUIT_AFTER_FAILURES` if transient failures are expected.
   - Increase `COREBOT_ISOLATION_CIRCUIT_RESET_MS` if you want longer cooldown periods.
   - Increase `COREBOT_ISOLATION_MAX_CONCURRENT_WORKERS` if workers are queuing up.

## 9) Common Troubleshooting

### Bot not responding
1. Check `/health/ready` — if not `200`, the bus or scheduler may be stopped.
2. Check logs for `runtime error` or `Provider error`.
3. Verify `OPENAI_API_KEY` is set and valid.
4. Check queue: `GET /status` shows queue depth. If inbound queue is growing, the processor may be stuck.

### Messages going to dead-letter queue
1. List dead-letter entries: `/dlq list` in CLI, or use the `bus.dead_letter.list` tool (admin only). `GET /status` only shows queue counts.
2. Check `lastError` field for the failure reason.
3. Common causes: LLM provider errors (rate limits, auth), tool execution failures.
4. After fixing root cause, replay: `/dlq replay inbound`.

### High memory usage
1. Check message count in SQLite — compaction should be pruning old messages.
2. If `storeFullMessages=true`, consider switching to `false` (only registered chats store full history).
3. Tune `historyMaxMessages` lower to trigger compaction sooner.

### MCP tools not appearing
1. Check `.mcp.json` exists and is valid JSON.
2. Verify the MCP server command works independently.
3. Check `allowedMcpServers` and `allowedMcpTools` include the expected entries.
4. Check logs for `failed to sync MCP tools`.
5. Force reload: use `mcp.reload` tool (admin only).

### Heartbeat not producing expected outbound alerts
1. Confirm `heartbeat.enabled=true` (or use `heartbeat.enable` tool for runtime switch).
2. Verify `heartbeat.promptPath` exists under workspace and is non-empty.
3. Check `heartbeat.activeHours` window and local server timezone assumptions.
4. Check `heartbeat.delivery` audit events:
   - `reason=ok_token` means pure ACK was intentionally suppressed.
   - `reason=duplicate` means same content hash was already sent within dedupe window.
5. If inbound queue is continuously busy, tune `heartbeat.skipWhenInboundBusy` and `heartbeat.wakeRetryMs`.

### Scheduled task not firing
1. Check `tasks.list` — verify `status=active` and `nextRunAt` is in the past.
2. Scheduler ticks every `scheduler.tickMs` (default 60s), so tasks may have up to 60s delay.
3. Check logs for `scheduler` entries.
4. Verify the task's `scheduleValue` is a valid cron expression / interval / ISO datetime.

### Admin bootstrap not working
1. Verify `COREBOT_ADMIN_BOOTSTRAP_KEY` is set.
2. Check if bootstrap is already used (`adminBootstrapSingleUse=true`).
3. Check if locked out due to failed attempts (check logs for lockout messages).
4. If locked, wait for `adminBootstrapLockoutMinutes` to expire. Restarting alone does not clear lockout state because it is persisted in SQLite meta.

## 10) Performance Tuning

### Queue Throughput
| Parameter | Default | Effect |
|-----------|---------|--------|
| `bus.pollMs` | 1000 | Lower = faster processing, higher CPU |
| `bus.batchSize` | 50 | Messages processed per poll cycle |
| `bus.maxAttempts` | 5 | Retries before dead-letter |
| `bus.retryBackoffMs` | 1000 | Base retry delay (exponential: delay × 2^attempt) |
| `bus.maxRetryBackoffMs` | 60000 | Cap on retry delay |
| `bus.processingTimeoutMs` | 120000 | Stale processing threshold |

### Context Window
| Parameter | Default | Effect |
|-----------|---------|--------|
| `historyMaxMessages` | 30 | Messages included in LLM context |
| `maxToolIterations` | 8 | Max tool-calling loop iterations |
| `maxToolOutputChars` | 50000 | Truncation limit per tool output |

### Isolation Workers
| Parameter | Default | Effect |
|-----------|---------|--------|
| `isolation.maxConcurrentWorkers` | 4 | Parallel isolated tool executions |
| `isolation.workerTimeoutMs` | 30000 | Per-worker timeout |
| `isolation.maxWorkerOutputChars` | 250000 | Worker stdout cap |

### Rate Limiting
| Parameter | Default | Effect |
|-----------|---------|--------|
| `bus.perChatRateLimitWindowMs` | 60000 | Sliding window duration |
| `bus.perChatRateLimitMax` | 120 | Max messages per chat per window |
| `bus.overloadPendingThreshold` | 2000 | Queue depth that triggers backoff |
| `bus.overloadBackoffMs` | 500 | Delay added when overloaded |

## 11) Log Interpretation

Corebot uses Pino structured JSON logs. Key log messages:

| Log Message | Level | Meaning |
|-------------|-------|---------|
| `runtime observability snapshot` | info | Periodic metrics report |
| `MCP tools synchronized` | info | MCP config reloaded successfully |
| `bus message dropped by flow control` | warn | Queue overflow or rate limit hit |
| `bus message dead-lettered` | error | Message exceeded max retry attempts |
| `bus message scheduled for retry` | warn | Transient failure, will retry |
| `recovered stale processing bus messages` | warn | Stale processing messages requeued on startup |
| `isolated runtime circuit opened after repeated failures` | warn | Circuit breaker tripped |
| `isolated runtime circuit closed after cooldown` | info | Circuit breaker recovered |
| `runtime error` | error | LLM provider or agent error |
| `tool error` | error | Tool execution failure |
| `failed to sync MCP tools` | warn | MCP config or server issue |
| `SLO breach: ...` | warn | A threshold was exceeded |
