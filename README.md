# Corebot

![Node CI](https://github.com/webllm/corebot/workflows/Node%20CI/badge.svg)
[![npm](https://img.shields.io/npm/v/@corebot/core.svg)](https://www.npmjs.com/package/@corebot/core)
![license](https://img.shields.io/npm/l/@corebot/core)

Lightweight but capable TypeScript bot architecture.
Single-process by default, tool- and skill-driven, MCP-ready, and safe-by-default.

## Features

- **Agent runtime** with tool-calling loop
- **Built-in tools** (fs, shell, web, memory, messaging, tasks, skills)
- **Skills** via `SKILL.md` (progressive loading)
- **MCP client** integration (tools injected dynamically)
- **SQLite storage** for chats, messages, summaries, and tasks
- **Scheduler** with `cron | interval | once`
- **Agent heartbeat** loop with debounce wake, ack suppression, and duplicate-delivery guard
- **CLI channel** for local usage (other channels stubbed)
- **Isolated tool runtime** for high-risk tools (`shell.exec`, `web.fetch`, `fs.write`)
- **Durable queue with idempotent publish** (retry/dead-letter/replay + dedupe by message id)
- **Inbound execution ledger** to avoid duplicate runtime/tool execution on re-queued messages
- **Queue backpressure + per-chat rate limit** (overflow to DLQ + overload backoff)
- **Observability endpoints** (`/health/*`, `/metrics`, `/status`) and SLO monitor
- **Webhook channel** (inbound POST + outbound pull API + optional token auth)
- **Migration safety** with pre-migration backups and migration history
- **Persistent audit events** for tool execution, denials, and errors

## CLI and SDK

- CLI: `corebot` (or `pnpm run dev` / `pnpm run start`)
- SDK: import from `@corebot/core` and manage lifecycle via `createCorebotApp()`
- CLI flags: `corebot --help`, `corebot --version`, `corebot preflight`

```ts
import { createCorebotApp, loadConfig } from "@corebot/core";

const app = await createCorebotApp({ config: loadConfig() });
await app.start();
// ...
await app.stop();
```

## Quick Start

```bash
pnpm install --frozen-lockfile
export OPENAI_API_KEY=YOUR_KEY
pnpm run dev
```

Type in the CLI prompt to chat. Use `/exit` to quit.

## Package Manager and Lockfile Policy

- Use `pnpm` only (`packageManager` is pinned in `package.json`).
- Commit both `pnpm-lock.yaml` and `pnpm-workspace.yaml`.
- Install with `pnpm install --frozen-lockfile` in local reproducible runs, CI, and Docker.
- Keep build-script approvals explicit in `pnpm-workspace.yaml` (`onlyBuiltDependencies`).
- If a newly added dependency needs lifecycle scripts, run `pnpm approve-builds` and commit the updated policy file.

## Example Commands

```bash
# Build + run production bundle locally
pnpm run build
node dist/bin.js

# Use a custom workspace/data directory
COREBOT_WORKSPACE=./workspace COREBOT_DATA_DIR=./data pnpm run dev

# Enable shell tool with executable allowlist
COREBOT_ALLOW_SHELL=true COREBOT_SHELL_ALLOWLIST="ls,git" pnpm run dev

# Enable web.search (Brave Search API)
BRAVE_API_KEY=YOUR_KEY COREBOT_ALLOWED_ENV=BRAVE_API_KEY pnpm run dev

# Restrict web.fetch to specific hosts/domains
COREBOT_WEB_ALLOWLIST="example.com,api.example.com" pnpm run dev

# Restrict web.fetch ports
COREBOT_WEB_ALLOWED_PORTS="443,8443" COREBOT_WEB_BLOCKED_PORTS="8080" pnpm run dev

# Isolate multiple high-risk tools in worker process
COREBOT_ISOLATION_TOOLS="shell.exec,web.fetch,fs.write" pnpm run dev

# Enable observability HTTP endpoints
COREBOT_OBS_HTTP_ENABLED=true COREBOT_OBS_HTTP_PORT=3210 pnpm run dev

# Enable webhook channel
COREBOT_WEBHOOK_ENABLED=true COREBOT_WEBHOOK_AUTH_TOKEN=YOUR_TOKEN pnpm run dev

# Manual database backup / restore
pnpm run ops:db:backup -- --db data/bot.sqlite
pnpm run ops:db:restore -- --db data/bot.sqlite --from data/backups/manual-xxxx.sqlite --force

# Validate startup config and MCP file before deployment
corebot preflight
corebot preflight --mcp-config ./path/to/.mcp.json
```

CLI queue ops:

- `/dlq list [inbound|outbound|all] [limit]`
- `/dlq replay <queueId|inbound|outbound|all> [limit]`

Example prompts (in CLI):

- “Schedule a daily summary at 9am.”
- “Save a short memory about my preferences.”
- “List available skills.”

## Configuration

You can configure via `config.json` or environment variables.

### config.json (example)

```json
{
  "workspaceDir": "workspace",
  "dataDir": "data",
  "sqlitePath": "data/bot.sqlite",
  "logLevel": "info",
  "provider": {
    "type": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "temperature": 0.2
  },
  "historyMaxMessages": 30,
  "storeFullMessages": false,
  "maxToolIterations": 8,
  "maxToolOutputChars": 50000,
  "skillsDir": "workspace/skills",
  "mcpConfigPath": ".mcp.json",
  "mcpSync": {
    "failureBackoffBaseMs": 1000,
    "failureBackoffMaxMs": 60000,
    "openCircuitAfterFailures": 5,
    "circuitResetMs": 30000
  },
  "heartbeat": {
    "enabled": false,
    "intervalMs": 300000,
    "wakeDebounceMs": 250,
    "wakeRetryMs": 1000,
    "promptPath": "HEARTBEAT.md",
    "activeHours": "",
    "skipWhenInboundBusy": true,
    "ackToken": "HEARTBEAT_OK",
    "suppressAck": true,
    "dedupeWindowMs": 86400000,
    "maxDispatchPerRun": 20
  },
  "scheduler": { "tickMs": 60000 },
  "bus": {
    "pollMs": 1000,
    "batchSize": 50,
    "maxAttempts": 5,
    "retryBackoffMs": 1000,
    "maxRetryBackoffMs": 60000,
    "processingTimeoutMs": 120000,
    "maxPendingInbound": 5000,
    "maxPendingOutbound": 5000,
    "overloadPendingThreshold": 2000,
    "overloadBackoffMs": 500,
    "perChatRateLimitWindowMs": 60000,
    "perChatRateLimitMax": 120
  },
  "observability": {
    "enabled": true,
    "reportIntervalMs": 30000,
    "http": { "enabled": true, "host": "127.0.0.1", "port": 3210 }
  },
  "slo": {
    "enabled": true,
    "alertCooldownMs": 60000,
    "maxPendingQueue": 2000,
    "maxDeadLetterQueue": 20,
    "maxToolFailureRate": 0.2,
    "maxSchedulerDelayMs": 60000,
    "maxMcpFailureRate": 0.3
  },
  "isolation": {
    "enabled": true,
    "toolNames": ["shell.exec"],
    "workerTimeoutMs": 30000,
    "maxWorkerOutputChars": 250000,
    "maxConcurrentWorkers": 4,
    "openCircuitAfterFailures": 5,
    "circuitResetMs": 30000
  },
  "allowShell": false,
  "allowedShellCommands": [],
  "allowedEnv": [],
  "allowedWebDomains": [],
  "allowedWebPorts": [],
  "blockedWebPorts": [],
  "allowedMcpServers": [],
  "allowedMcpTools": [],
  "adminBootstrapKey": "",
  "adminBootstrapSingleUse": true,
  "adminBootstrapMaxAttempts": 5,
  "adminBootstrapLockoutMinutes": 15,
  "webhook": {
    "enabled": false,
    "host": "0.0.0.0",
    "port": 8788,
    "path": "/webhook",
    "authToken": "",
    "maxBodyBytes": 1000000
  },
  "cli": { "enabled": true }
}
```

### Environment variables

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `OPENAI_TEMPERATURE`
- `COREBOT_WORKSPACE`
- `COREBOT_DATA_DIR`
- `COREBOT_SQLITE_PATH`
- `COREBOT_LOG_LEVEL`
- `COREBOT_HISTORY_MAX`
- `COREBOT_STORE_FULL`
- `COREBOT_MAX_TOOL_ITER`
- `COREBOT_MAX_TOOL_OUTPUT`
- `COREBOT_SKILLS_DIR`
- `COREBOT_MCP_CONFIG`
- `COREBOT_MCP_SYNC_BACKOFF_BASE_MS`
- `COREBOT_MCP_SYNC_BACKOFF_MAX_MS`
- `COREBOT_MCP_SYNC_OPEN_CIRCUIT_AFTER_FAILURES`
- `COREBOT_MCP_SYNC_CIRCUIT_RESET_MS`
- `COREBOT_HEARTBEAT_ENABLED`
- `COREBOT_HEARTBEAT_INTERVAL_MS`
- `COREBOT_HEARTBEAT_WAKE_DEBOUNCE_MS`
- `COREBOT_HEARTBEAT_WAKE_RETRY_MS`
- `COREBOT_HEARTBEAT_PROMPT_PATH`
- `COREBOT_HEARTBEAT_ACTIVE_HOURS`
- `COREBOT_HEARTBEAT_SKIP_WHEN_INBOUND_BUSY`
- `COREBOT_HEARTBEAT_ACK_TOKEN`
- `COREBOT_HEARTBEAT_SUPPRESS_ACK`
- `COREBOT_HEARTBEAT_DEDUPE_WINDOW_MS`
- `COREBOT_HEARTBEAT_MAX_DISPATCH_PER_RUN`
- `COREBOT_ISOLATION_ENABLED`
- `COREBOT_ISOLATION_TOOLS`
- `COREBOT_ISOLATION_WORKER_TIMEOUT_MS`
- `COREBOT_ISOLATION_MAX_WORKER_OUTPUT_CHARS`
- `COREBOT_ISOLATION_MAX_CONCURRENT_WORKERS`
- `COREBOT_ISOLATION_OPEN_CIRCUIT_AFTER_FAILURES`
- `COREBOT_ISOLATION_CIRCUIT_RESET_MS`
- `COREBOT_ALLOW_SHELL`
- `COREBOT_SHELL_ALLOWLIST`
- `COREBOT_ALLOWED_ENV`
- `COREBOT_WEB_ALLOWLIST`
- `COREBOT_WEB_ALLOWED_PORTS`
- `COREBOT_WEB_BLOCKED_PORTS`
- `COREBOT_BUS_POLL_MS`
- `COREBOT_BUS_BATCH_SIZE`
- `COREBOT_BUS_MAX_ATTEMPTS`
- `COREBOT_BUS_RETRY_BACKOFF_MS`
- `COREBOT_BUS_MAX_RETRY_BACKOFF_MS`
- `COREBOT_BUS_PROCESSING_TIMEOUT_MS`
- `COREBOT_BUS_MAX_PENDING_INBOUND`
- `COREBOT_BUS_MAX_PENDING_OUTBOUND`
- `COREBOT_BUS_OVERLOAD_PENDING_THRESHOLD`
- `COREBOT_BUS_OVERLOAD_BACKOFF_MS`
- `COREBOT_BUS_CHAT_RATE_WINDOW_MS`
- `COREBOT_BUS_CHAT_RATE_MAX`
- `COREBOT_OBS_ENABLED`
- `COREBOT_OBS_REPORT_MS`
- `COREBOT_OBS_HTTP_ENABLED`
- `COREBOT_OBS_HTTP_HOST`
- `COREBOT_OBS_HTTP_PORT`
- `COREBOT_SLO_ENABLED`
- `COREBOT_SLO_ALERT_COOLDOWN_MS`
- `COREBOT_SLO_MAX_PENDING_QUEUE`
- `COREBOT_SLO_MAX_DEAD_LETTER_QUEUE`
- `COREBOT_SLO_MAX_TOOL_FAILURE_RATE`
- `COREBOT_SLO_MAX_SCHEDULER_DELAY_MS`
- `COREBOT_SLO_MAX_MCP_FAILURE_RATE`
- `COREBOT_SLO_ALERT_WEBHOOK_URL`
- `COREBOT_MCP_ALLOWED_SERVERS`
- `COREBOT_MCP_ALLOWED_TOOLS`
- `COREBOT_ADMIN_BOOTSTRAP_KEY`
- `COREBOT_ADMIN_BOOTSTRAP_SINGLE_USE`
- `COREBOT_ADMIN_BOOTSTRAP_MAX_ATTEMPTS`
- `COREBOT_ADMIN_BOOTSTRAP_LOCKOUT_MINUTES`
- `COREBOT_WEBHOOK_ENABLED`
- `COREBOT_WEBHOOK_HOST`
- `COREBOT_WEBHOOK_PORT`
- `COREBOT_WEBHOOK_PATH`
- `COREBOT_WEBHOOK_AUTH_TOKEN`
- `COREBOT_WEBHOOK_MAX_BODY_BYTES`

Notes:
- `COREBOT_ALLOWED_ENV` is used by tools that explicitly gate env access (for example `web.search`) and by isolated `shell.exec` workers.
- `COREBOT_SHELL_ALLOWLIST` matches executable names (for example `ls,git`), not full command prefixes.
- `COREBOT_WEB_ALLOWLIST` restricts `web.fetch` target hosts (exact host or subdomain match).
- `COREBOT_WEB_ALLOWED_PORTS` and `COREBOT_WEB_BLOCKED_PORTS` provide port allow/deny controls for `web.fetch`.
- `COREBOT_ISOLATION_TOOLS` defaults to `shell.exec`; add `web.fetch` and/or `fs.write` to isolate network and file-write execution as well.
- `COREBOT_ISOLATION_MAX_CONCURRENT_WORKERS` caps simultaneous isolated workers (default `4`).
- `COREBOT_ISOLATION_OPEN_CIRCUIT_AFTER_FAILURES` and `COREBOT_ISOLATION_CIRCUIT_RESET_MS` control per-tool circuit breaker for repeated worker failures.
- Default policy denies non-admin `fs.write` to protected paths (`skills/`, `IDENTITY.md`, `TOOLS.md`, `USER.md`, `.mcp.json`).
- `COREBOT_MCP_ALLOWED_SERVERS` and `COREBOT_MCP_ALLOWED_TOOLS` act as allowlists when set; empty lists allow all discovered MCP servers/tools.
- `COREBOT_MCP_SYNC_*` controls MCP auto-sync retry backoff and temporary circuit-open window after repeated failures.
- `COREBOT_HEARTBEAT_ACTIVE_HOURS` accepts `HH:mm-HH:mm` in local process time; empty means always active.
- `COREBOT_HEARTBEAT_PROMPT_PATH` is resolved relative to `workspaceDir` and must be non-empty to dispatch heartbeat turns.
- `COREBOT_WEBHOOK_AUTH_TOKEN` can be sent via `Authorization: Bearer <token>` or `x-corebot-token`.
- `COREBOT_ADMIN_BOOTSTRAP_SINGLE_USE=true` invalidates bootstrap elevation after first successful use.
- `COREBOT_ADMIN_BOOTSTRAP_MAX_ATTEMPTS` and `COREBOT_ADMIN_BOOTSTRAP_LOCKOUT_MINUTES` control invalid-key lockout policy.

## Deployment Guide

1) **Build**  
```bash
pnpm install --frozen-lockfile
pnpm run build
```

2) **Run**
```bash
export OPENAI_API_KEY=YOUR_KEY
node dist/bin.js
# Or directly: node dist/main.js
```

3) **Persist data**  
Ensure `data/` and `workspace/` are persisted (bind mount or volume). Corebot auto-creates them if missing.

4) **Config**  
Use `config.json` for stable configuration in production; use env vars for secrets.

## Docker

Build and run using the included `Dockerfile`:

```bash
docker build -t corebot .
docker run -it --rm \\
  -e OPENAI_API_KEY=YOUR_KEY \\
  -v $(pwd)/data:/app/data \\
  -v $(pwd)/workspace:/app/workspace \\
  corebot
```

Optional: mount `.mcp.json` or `config.json` if you want MCP or custom settings:

```bash
docker run -it --rm \\
  -e OPENAI_API_KEY=YOUR_KEY \\
  -v $(pwd)/data:/app/data \\
  -v $(pwd)/workspace:/app/workspace \\
  -v $(pwd)/.mcp.json:/app/.mcp.json \\
  -v $(pwd)/config.json:/app/config.json \\
  corebot
```

## CI Template (GitHub Actions)

```yaml
name: ci
on:
  push:
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
```

## Built-in Tools

- `fs.read`, `fs.write`, `fs.list`
- `shell.exec` (disabled by default)
- `web.fetch`, `web.search` (Brave Search API)
- `memory.read`, `memory.write`
- `message.send`, `chat.register`, `chat.set_role`
- `tasks.schedule`, `tasks.list`, `tasks.update`
- `skills.list`, `skills.read`, `skills.enable`, `skills.disable`, `skills.enabled`
- `heartbeat.status`, `heartbeat.trigger`, `heartbeat.enable` (admin only)
- `mcp.reload` (admin only; force refresh MCP config and tool bindings)
- `bus.dead_letter.list`, `bus.dead_letter.replay` (admin only)

### Tool API Reference

#### File System

| Tool | Parameters | Description |
|------|-----------|-------------|
| `fs.read` | `path: string` | Read a text file within the workspace |
| `fs.write` | `path: string`, `content: string`, `mode?: "overwrite"\|"append"` (default `"overwrite"`) | Write a text file within the workspace |
| `fs.list` | `path?: string` (default `"."`) | List files in a workspace directory |

#### Shell

| Tool | Parameters | Description |
|------|-----------|-------------|
| `shell.exec` | `command: string`, `cwd?: string`, `timeoutMs?: number` (default 20000, max 120000) | Execute a command. Disabled by default; requires `allowShell=true`. Admin only. |

Commands are tokenized and executed directly (no shell interpreter). If `allowedShellCommands` is non-empty, only listed executable names are permitted.

#### Web

| Tool | Parameters | Description |
|------|-----------|-------------|
| `web.fetch` | `url: string`, `method?: "GET"\|"POST"` (default `"GET"`), `headers?: Record<string,string>`, `body?: string`, `timeoutMs?: number` (default 15000), `maxResponseChars?: number` (default 200000) | Fetch a URL over HTTP |
| `web.search` | `query: string`, `count?: number` (default 5, max 10) | Search the web using Brave Search API. Requires `BRAVE_API_KEY` in `allowedEnv`. |

#### Memory

| Tool | Parameters | Description |
|------|-----------|-------------|
| `memory.read` | `scope?: "global"\|"chat"\|"all"` (default `"all"`) | Read memory content |
| `memory.write` | `scope?: "global"\|"chat"` (default `"chat"`), `content: string`, `mode?: "append"\|"replace"` (default `"append"`) | Write memory. Global scope is admin only. |

Memory files: `workspace/memory/MEMORY.md` (global), `workspace/memory/{channel}_{chatId}.md` (per-chat).

#### Messaging

| Tool | Parameters | Description |
|------|-----------|-------------|
| `message.send` | `content: string`, `channel?: string`, `chatId?: string` | Send a message. Cross-chat sending is admin only. |
| `chat.register` | `channel?: string`, `chatId?: string`, `role?: "admin"\|"normal"`, `bootstrapKey?: string` | Register a chat for full message storage. See Admin Bootstrap below. |
| `chat.set_role` | `channel: string`, `chatId: string`, `role: "admin"\|"normal"` | Set chat role. Admin only. |

#### Tasks

| Tool | Parameters | Description |
|------|-----------|-------------|
| `tasks.schedule` | `prompt: string`, `scheduleType: "cron"\|"interval"\|"once"`, `scheduleValue: string`, `contextMode?: "group"\|"isolated"` (default `"group"`) | Create a scheduled task |
| `tasks.list` | `includeInactive?: boolean` (default `true`) | List tasks for this chat |
| `tasks.update` | `taskId: string`, `status?: "active"\|"paused"\|"done"`, `scheduleType?`, `scheduleValue?`, `contextMode?` | Update a task. Cross-chat updates are admin only. |

`scheduleValue` format: cron expression for `cron`, milliseconds string for `interval`, ISO datetime for `once`.

#### Skills Management

| Tool | Parameters | Description |
|------|-----------|-------------|
| `skills.list` | *(none)* | List available skills with enabled status |
| `skills.read` | `name: string` | Read a skill file content |
| `skills.enable` | `name: string` | Enable a skill for this chat |
| `skills.disable` | `name: string` | Disable a skill (always-skills cannot be disabled) |
| `skills.enabled` | *(none)* | List currently enabled skill names |

#### Admin Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `heartbeat.status` | *(none)* | Show heartbeat runtime status, config, and next due chats. Admin only. |
| `heartbeat.trigger` | `reason?: string`, `force?: boolean`, `channel?: string`, `chatId?: string` | Queue an immediate heartbeat wake (optional force and target chat). Admin only. |
| `heartbeat.enable` | `enabled: boolean`, `reason?: string` | Enable/disable runtime heartbeat loop without restart. Admin only. |
| `mcp.reload` | `reason?: string`, `force?: boolean` (default `true`) | Reload MCP config and re-register tools. Set `force=false` to respect no-change checks and failure backoff. Admin only. |
| `bus.dead_letter.list` | `direction?: "inbound"\|"outbound"`, `limit?: number` (default 20) | List dead-letter queue entries. Admin only. |
| `bus.dead_letter.replay` | `queueId?: string`, `direction?: "inbound"\|"outbound"`, `limit?: number` (default 10) | Replay dead-letter entries back to pending. Admin only. |

## Security Model

### Roles

Corebot uses two roles: **admin** and **normal**. New chats default to `normal`.

### Admin Bootstrap

The first admin is created through a bootstrap flow:

1. Set `COREBOT_ADMIN_BOOTSTRAP_KEY` in config/env.
2. A user calls `chat.register` with `role=admin` and `bootstrapKey=<the key>`.
3. If the key matches, the chat is promoted to admin.
4. With `adminBootstrapSingleUse=true` (default), the key is invalidated after first use.
5. After `adminBootstrapMaxAttempts` (default 5) failed attempts, bootstrap locks for `adminBootstrapLockoutMinutes` (default 15).
6. Once an admin exists, new admins can only be granted by existing admins via `chat.set_role`.

### Permission Matrix

| Capability | Normal | Admin |
|-----------|--------|-------|
| File read/write/list (within workspace) | Yes | Yes |
| File write to protected paths | No | Yes |
| Shell execution | No | Yes |
| Web fetch (policy-restricted) | Yes | Yes |
| Memory write (chat scope) | Yes | Yes |
| Memory write (global scope) | No | Yes |
| Send message (same chat) | Yes | Yes |
| Send message (cross-chat) | No | Yes |
| Register own chat | Yes | Yes |
| Register other chats | No | Yes |
| Update own tasks | Yes | Yes |
| Update other chats' tasks | No | Yes |
| Heartbeat control/status tools | No | Yes |
| MCP tool execution | No | Yes |
| MCP reload | No | Yes |
| Dead-letter queue operations | No | Yes |
| Set chat roles | No | Yes |

### Protected Workspace Paths

Non-admin `fs.write` is denied for: `IDENTITY.md`, `TOOLS.md`, `USER.md`, `.mcp.json`, `skills/` (and any path under it).

## Memory

Corebot maintains two types of persistent memory:

- **Global memory** (`workspace/memory/MEMORY.md`): shared across all chats. Admin-only for writes.
- **Per-chat memory** (`workspace/memory/{channel}_{chatId}.md`): scoped to a specific chat session.

Both are automatically included in the system prompt when available, except isolated scheduled-task runs (chat memory excluded).

## Conversation Compaction

When the stored message count for a chat exceeds `historyMaxMessages * 2`, Corebot automatically compacts:

1. Recent messages are sent to the LLM to generate a bullet summary (max 150 words).
2. Old messages beyond `historyMaxMessages` are pruned from storage.
3. The summary is stored in `conversation_state` and included in future system prompts.

This keeps context manageable while preserving key facts and decisions.

## Inbound Execution Ledger

To ensure idempotency when messages are re-queued (e.g., after a retry), Corebot maintains an `inbound_executions` table:

- Before processing, the router checks if the inbound message was already processed.
- If completed, the cached response is reused without re-running the LLM or tools.
- If a previous run is stale (older than `bus.processingTimeoutMs`), it is reclaimed.
- Outbound message IDs are deterministic (`outbound:{channel}:{chatId}:{inboundId}`), so re-processing does not create duplicate replies.

## Skills

Skills live in `workspace/skills/<skill-name>/SKILL.md` and support frontmatter:

```markdown
---
name: web-research
description: "Web search + citation formatting"
always: false
requires:
  - env: ["BRAVE_API_KEY"]
tools:
  - web.search
  - web.fetch
---
# Web Research Skill
...
```

New skill directories/files are discovered dynamically during message handling, so adding a skill does not require a process restart.

## MCP Integration

Create `.mcp.json` in repo root:

```json
{
  "servers": {
    "myserver": {
      "command": "npx",
      "args": ["@example/mcp-server"]
    }
  }
}
```

MCP tools are injected as: `mcp__<server>__<tool>`.

`.mcp.json` is checked and auto-synced during message handling; changes are applied without restart.  
You can also force refresh manually with `mcp.reload`.
If `.mcp.json` is invalid (for example malformed JSON), reload is rejected and the previous MCP tool set remains active.
Each enabled server must define exactly one of `command` or `url`; `args/env` are only valid with `command`.
Use `corebot preflight` to validate config and `.mcp.json` before rolling out changes.
Reload attempts are tracked in telemetry (`corebot_mcp_reload_*`) and persisted in `audit_events` with reason/duration metadata.

## Agent Heartbeat

Heartbeat runs as a synthetic inbound turn per chat and reuses the same router/runtime/tool stack. It supports:

- interval scheduling per chat
- wake coalescing (debounce)
- inbound-busy skip/retry gate
- ack suppression (`ackToken`)
- recent duplicate suppression (`dedupeWindowMs`)

Behavior controls live under `heartbeat.*` config and are also available via admin tools `heartbeat.status`, `heartbeat.trigger`, and `heartbeat.enable`.

## Scheduler

Tasks support:

- `cron` (cron expression)
- `interval` (milliseconds)
- `once` (ISO datetime)

Scheduler emits synthetic inbound messages with `context_mode`:
- `group`: include chat context
- `isolated`: minimal context

## Operations

- Health endpoints:
  - `GET /health/live`
  - `GET /health/ready`
  - `GET /health/startup`
- Runtime endpoints:
  - `GET /metrics` (Prometheus format)
  - `GET /status` (JSON snapshot with queue/tool/scheduler/MCP health)
- Webhook channel:
  - `POST <COREBOT_WEBHOOK_PATH>` with JSON `{chatId, content, senderId?, id?, createdAt?, metadata?}`
  - `GET <COREBOT_WEBHOOK_PATH>/outbound?chatId=<id>&limit=<n>`

Detailed incident and recovery procedures are documented in `RUNBOOK.md`.

## Workspace Layout

```
workspace/
  IDENTITY.md
  USER.md
  TOOLS.md
  memory/
    MEMORY.md
  skills/
    <skill-name>/SKILL.md
```

## Roadmap

- WhatsApp / Telegram adapters
- Container sandbox for tools
- Additional provider adapters
- Multi-instance coordination and queue partitioning

## Inspiration

Corebot is inspired by NanoClaw + NanoBot patterns.

---

For the full architecture details, see [ARCHITECTURE.md](./ARCHITECTURE.md).
For the operations runbook, see [RUNBOOK.md](./RUNBOOK.md).
For contribution guidelines, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
