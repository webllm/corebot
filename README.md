# Corebot

Lightweight but capable TypeScript bot architecture inspired by NanoClaw + NanoBot patterns.
Single-process by default, tool- and skill-driven, MCP-ready, and safe-by-default.

## Features

- **Agent runtime** with tool-calling loop
- **Built-in tools** (fs, shell, web, memory, messaging, tasks, skills)
- **Skills** via `SKILL.md` (progressive loading)
- **MCP client** integration (tools injected dynamically)
- **SQLite storage** for chats, messages, summaries, and tasks
- **Scheduler** with `cron | interval | once`
- **CLI channel** for local usage (other channels stubbed)
- **Isolated tool runtime** for high-risk tools (process sandbox v1)

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
```

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
  "isolation": {
    "enabled": true,
    "toolNames": ["shell.exec"],
    "workerTimeoutMs": 30000,
    "maxWorkerOutputChars": 250000
  },
  "allowShell": false,
  "allowedShellCommands": [],
  "allowedEnv": [],
  "allowedWebDomains": [],
  "allowedWebPorts": [],
  "blockedWebPorts": [],
  "adminBootstrapKey": "",
  "adminBootstrapSingleUse": true,
  "adminBootstrapMaxAttempts": 5,
  "adminBootstrapLockoutMinutes": 15,
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
- `COREBOT_ALLOW_SHELL`
- `COREBOT_SHELL_ALLOWLIST`
- `COREBOT_ALLOWED_ENV`
- `COREBOT_WEB_ALLOWLIST`
- `COREBOT_WEB_ALLOWED_PORTS`
- `COREBOT_WEB_BLOCKED_PORTS`
- `COREBOT_ADMIN_BOOTSTRAP_KEY`
- `COREBOT_ADMIN_BOOTSTRAP_SINGLE_USE`
- `COREBOT_ADMIN_BOOTSTRAP_MAX_ATTEMPTS`
- `COREBOT_ADMIN_BOOTSTRAP_LOCKOUT_MINUTES`

Notes:
- `COREBOT_ALLOWED_ENV` is default-deny. Include keys explicitly (for example `BRAVE_API_KEY`) for tools that need env access.
- `COREBOT_SHELL_ALLOWLIST` matches executable names (for example `ls,git`), not full command prefixes.
- `COREBOT_WEB_ALLOWLIST` restricts `web.fetch` target hosts (exact host or subdomain match).
- `COREBOT_WEB_ALLOWED_PORTS` and `COREBOT_WEB_BLOCKED_PORTS` provide port allow/deny controls for `web.fetch`.
- `COREBOT_ISOLATION_TOOLS` defaults to `shell.exec`; this tool runs in an isolated worker process with minimal env exposure.
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

## Project Structure

```
src/
  main.ts
  agent/
  bus/
  channels/
  config/
  mcp/
  observability/
  scheduler/
  skills/
  storage/
  tools/
  util/
```

## Roadmap

- WhatsApp / Telegram / Webhook adapters
- Container sandbox for tools
- Additional provider adapters
- Permission system + per-chat policies

---

For the full architecture details, see `ARCHITECTURE.md`.
