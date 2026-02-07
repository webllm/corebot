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
- **CLI channel** for local usage (other channels stubbed)
- **Isolated tool runtime** for high-risk tools (`shell.exec`, `web.fetch`, `fs.write`)
- **Durable queue with idempotent publish** (retry/dead-letter/replay + dedupe by message id)
- **Inbound execution ledger** to avoid duplicate runtime/tool execution on re-queued messages
- **Queue backpressure + per-chat rate limit** (overflow to DLQ + overload backoff)
- **Observability endpoints** (`/health/*`, `/metrics`, `/status`) and SLO monitor
- **Webhook channel** (inbound POST + outbound pull API + optional token auth)
- **Migration safety** with pre-migration backups and migration history
- **Persistent audit events** for tool execution, denials, and errors

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
node dist/main.js

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
  "scheduler": { "tickMs": 60000 },
  "bus": {
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
- `COREBOT_BUS_MAX_PENDING_INBOUND`
- `COREBOT_BUS_MAX_PENDING_OUTBOUND`
- `COREBOT_BUS_OVERLOAD_PENDING_THRESHOLD`
- `COREBOT_BUS_OVERLOAD_BACKOFF_MS`
- `COREBOT_BUS_CHAT_RATE_WINDOW_MS`
- `COREBOT_BUS_CHAT_RATE_MAX`
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
- `COREBOT_ALLOWED_ENV` is default-deny. Include keys explicitly (for example `BRAVE_API_KEY`) for tools that need env access.
- `COREBOT_SHELL_ALLOWLIST` matches executable names (for example `ls,git`), not full command prefixes.
- `COREBOT_WEB_ALLOWLIST` restricts `web.fetch` target hosts (exact host or subdomain match).
- `COREBOT_WEB_ALLOWED_PORTS` and `COREBOT_WEB_BLOCKED_PORTS` provide port allow/deny controls for `web.fetch`.
- `COREBOT_ISOLATION_TOOLS` defaults to `shell.exec`; add `web.fetch` and/or `fs.write` to isolate network and file-write execution as well.
- `COREBOT_ISOLATION_MAX_CONCURRENT_WORKERS` caps simultaneous isolated workers (default `4`).
- `COREBOT_ISOLATION_OPEN_CIRCUIT_AFTER_FAILURES` and `COREBOT_ISOLATION_CIRCUIT_RESET_MS` control per-tool circuit breaker for repeated worker failures.
- Default policy denies non-admin `fs.write` to protected paths (`skills/`, `IDENTITY.md`, `TOOLS.md`, `USER.md`, `.mcp.json`).
- `COREBOT_MCP_ALLOWED_SERVERS` and `COREBOT_MCP_ALLOWED_TOOLS` enforce explicit MCP allowlists (supports `*` wildcard in tool patterns).
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
node dist/main.js
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
- `bus.dead_letter.list`, `bus.dead_letter.replay` (admin only)

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

For the full architecture details, see `ARCHITECTURE.md`.

## License

[MIT](./LICENSE)
