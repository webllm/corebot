import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../src/config/schema.js";
import { SqliteStorage } from "../src/storage/sqlite.js";
import type { ToolContext } from "../src/tools/registry.js";
import type { SkillIndexEntry } from "../src/skills/types.js";

export const createConfig = (
  workspaceDir: string,
  dataDir: string,
  overrides: Partial<Config> = {}
): Config => {
  const base: Config = {
    workspaceDir,
    dataDir,
    sqlitePath: path.join(dataDir, "bot.sqlite"),
    logLevel: "info",
    provider: {
      type: "openai",
      apiKey: "test-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      temperature: 0.2
    },
    historyMaxMessages: 30,
    storeFullMessages: false,
    maxToolIterations: 8,
    maxToolOutputChars: 50_000,
    skillsDir: path.join(workspaceDir, "skills"),
    mcpConfigPath: path.join(workspaceDir, ".mcp.json"),
    scheduler: { tickMs: 60_000 },
    bus: {
      pollMs: 50,
      batchSize: 20,
      maxAttempts: 3,
      retryBackoffMs: 20,
      maxRetryBackoffMs: 200,
      processingTimeoutMs: 500
    },
    allowShell: false,
    allowedShellCommands: [],
    allowedEnv: [],
    allowedWebDomains: [],
    allowedWebPorts: [],
    blockedWebPorts: [],
    adminBootstrapKey: undefined,
    adminBootstrapSingleUse: true,
    adminBootstrapMaxAttempts: 5,
    adminBootstrapLockoutMinutes: 15,
    cli: { enabled: false }
  };

  return {
    ...base,
    ...overrides,
    provider: { ...base.provider, ...(overrides.provider ?? {}) },
    scheduler: { ...base.scheduler, ...(overrides.scheduler ?? {}) },
    bus: { ...base.bus, ...(overrides.bus ?? {}) },
    cli: { ...base.cli, ...(overrides.cli ?? {}) }
  };
};

export const createStorageFixture = (overrides: Partial<Config> = {}) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "corebot-test-"));
  const workspaceDir = path.join(rootDir, "workspace");
  const dataDir = path.join(rootDir, "data");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, "memory"), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, "skills"), { recursive: true });

  const config = createConfig(workspaceDir, dataDir, overrides);
  const storage = new SqliteStorage(config);
  storage.init();

  const cleanup = () => {
    storage.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  };

  return { rootDir, workspaceDir, dataDir, config, storage, cleanup };
};

const createNoopLogger = () =>
  ({
    fatal: () => undefined,
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => createNoopLogger()
  }) as any;

export const createToolContext = (params: {
  config: Config;
  storage: SqliteStorage;
  workspaceDir: string;
  channel?: string;
  chatId?: string;
  chatRole?: "admin" | "normal";
  chatFk?: string;
  skills?: SkillIndexEntry[];
}) => {
  const outbound: Array<{ channel: string; chatId: string; content: string }> = [];
  const chat = {
    channel: params.channel ?? "cli",
    chatId: params.chatId ?? "local",
    role: params.chatRole ?? "normal",
    id: params.chatFk ?? "chat-fk"
  };

  const context: ToolContext = {
    workspaceDir: params.workspaceDir,
    chat,
    storage: params.storage,
    mcp: {} as any,
    logger: createNoopLogger(),
    bus: {
      publishInbound: () => undefined,
      publishOutbound: (message: { channel: string; chatId: string; content: string }) => {
        outbound.push(message);
      },
      onInbound: () => undefined,
      onOutbound: () => undefined,
      start: () => undefined
    } as any,
    config: params.config,
    skills: params.skills ?? []
  };

  return { context, outbound };
};
