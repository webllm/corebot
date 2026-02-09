# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] - Unreleased

### Added
- **Agent runtime** with OpenAI-compatible LLM provider and tool-calling loop (max 8 iterations).
- **Built-in tools**: `fs.read`, `fs.write`, `fs.list`, `shell.exec`, `web.fetch`, `web.search`, `memory.read`, `memory.write`, `message.send`, `chat.register`, `chat.set_role`, `tasks.schedule`, `tasks.list`, `tasks.update`, `skills.list`, `skills.read`, `skills.enable`, `skills.disable`, `skills.enabled`, `mcp.reload`, `bus.dead_letter.list`, `bus.dead_letter.replay`.
- **Heartbeat subsystem** with per-chat scheduler, wake debounce, inbound-busy gating, ACK suppression, duplicate-delivery guard, and admin control tools (`heartbeat.status`, `heartbeat.trigger`, `heartbeat.enable`).
- **CLI channel** for local interactive usage.
- **Webhook channel** with inbound POST and outbound pull API, optional bearer token auth.
- **Skills system** via `SKILL.md` files with YAML frontmatter, progressive loading, and hot-reload.
- **MCP client integration**: connect to stdio/SSE servers, auto-discover tools, hot-reload without restart.
- **SQLite storage** with WAL mode for chats, messages, conversation state, tasks, task runs, and audit events.
- **Durable message queue** with idempotent publish (dedupe by message id), retry with exponential backoff, and dead-letter queue with replay.
- **Inbound execution ledger** for re-processing idempotency.
- **Bus backpressure** (queue caps, overload backoff) and **per-chat rate limiting**.
- **Scheduler** supporting `cron`, `interval`, and `once` task types with `group`/`isolated` context modes.
- **Isolated tool runtime** for high-risk tools (`shell.exec`, `web.fetch`, `fs.write`) with worker pool, concurrency cap, and per-tool circuit breaker.
- **Role-based tool policy engine** with admin/normal roles, protected workspace paths, and admin bootstrap with lockout.
- **Observability**: Prometheus-format `/metrics`, health endpoints (`/health/live`, `/health/ready`, `/health/startup`), `/status` JSON snapshot, and SLO monitor with configurable thresholds and webhook alerts.
- **Persistent audit events** for tool execution (success, denied, error) with sensitive argument redaction.
- **Conversation compaction** via LLM summarization when message count exceeds threshold.
- **Per-chat memory** files alongside global memory.
- **Migration safety** with pre-migration backups and migration history.
- **Database backup/restore** operational scripts.
- **SDK exports** (`createCorebotApp`, `loadConfig`, core classes and types).
- **Docker** multi-stage build.
- **CI template** for GitHub Actions.
- WhatsApp and Telegram channel stubs (not yet implemented).
