import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../src/config/schema.js";
import { SqliteStorage } from "../src/storage/sqlite.js";
import type { ToolContext } from "../src/tools/registry.js";
import type { SkillIndexEntry } from "../src/skills/types.js";
import type { IsolatedToolRuntime } from "../src/isolation/runtime.js";
import type { HeartbeatController } from "../src/heartbeat/service.js";

type TestConfigOverrides = Partial<
  Omit<
    Config,
    | "provider"
    | "heartbeat"
    | "scheduler"
    | "bus"
    | "observability"
    | "slo"
    | "isolation"
    | "webhook"
    | "cli"
  >
> & {
  provider?: Partial<Config["provider"]>;
  heartbeat?: Partial<Config["heartbeat"]>;
  scheduler?: Partial<Config["scheduler"]>;
  bus?: Partial<Config["bus"]>;
  observability?: Partial<Config["observability"]>;
  slo?: Partial<Config["slo"]>;
  isolation?: Partial<Config["isolation"]>;
  webhook?: Partial<Config["webhook"]>;
  cli?: Partial<Config["cli"]>;
};

export const createConfig = (
  workspaceDir: string,
  dataDir: string,
  overrides: TestConfigOverrides = {}
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
      temperature: 0.2,
      timeoutMs: 60_000,
      maxInputTokens: 128_000,
      reserveOutputTokens: 4_096
    },
    historyMaxMessages: 30,
    storeFullMessages: false,
    maxToolIterations: 8,
    maxToolOutputChars: 50_000,
    skillsDir: path.join(workspaceDir, "skills"),
    mcpConfigPath: path.join(workspaceDir, ".mcp.json"),
    mcpSync: {
      failureBackoffBaseMs: 1_000,
      failureBackoffMaxMs: 60_000,
      openCircuitAfterFailures: 5,
      circuitResetMs: 30_000
    },
    heartbeat: {
      enabled: false,
      intervalMs: 300_000,
      wakeDebounceMs: 250,
      wakeRetryMs: 1_000,
      promptPath: "HEARTBEAT.md",
      activeHours: "",
      skipWhenInboundBusy: true,
      ackToken: "HEARTBEAT_OK",
      suppressAck: true,
      dedupeWindowMs: 86_400_000,
      maxDispatchPerRun: 20
    },
    scheduler: { tickMs: 60_000 },
    bus: {
      pollMs: 50,
      batchSize: 20,
      maxAttempts: 3,
      retryBackoffMs: 20,
      maxRetryBackoffMs: 200,
      processingTimeoutMs: 500,
      maxPendingInbound: 5_000,
      maxPendingOutbound: 5_000,
      overloadPendingThreshold: 2_000,
      overloadBackoffMs: 500,
      perChatRateLimitWindowMs: 60_000,
      perChatRateLimitMax: 120
    },
    observability: {
      enabled: false,
      reportIntervalMs: 5_000,
      http: {
        enabled: false,
        host: "127.0.0.1",
        port: 3210
      }
    },
    slo: {
      enabled: false,
      alertCooldownMs: 60_000,
      maxPendingQueue: 2_000,
      maxDeadLetterQueue: 20,
      maxToolFailureRate: 0.2,
      maxSchedulerDelayMs: 60_000,
      maxMcpFailureRate: 0.3,
      alertWebhookUrl: undefined
    },
    isolation: {
      enabled: true,
      toolNames: ["shell.exec"],
      workerTimeoutMs: 30_000,
      maxWorkerOutputChars: 250_000,
      maxConcurrentWorkers: 4,
      openCircuitAfterFailures: 5,
      circuitResetMs: 30_000
    },
    allowShell: false,
    allowedShellCommands: [],
    allowedEnv: [],
    allowedWebDomains: [],
    allowedWebPorts: [],
    blockedWebPorts: [],
    allowedMcpServers: [],
    allowedMcpTools: [],
    allowedChannelIdentities: [],
    adminBootstrapKey: undefined,
    adminBootstrapSingleUse: true,
    adminBootstrapMaxAttempts: 5,
    adminBootstrapLockoutMinutes: 15,
    webhook: {
      enabled: false,
      host: "127.0.0.1",
      port: 8788,
      path: "/webhook",
      authToken: undefined,
      maxBodyBytes: 1_000_000
    },
    cli: { enabled: false }
  };

  return {
    ...base,
    ...overrides,
    provider: { ...base.provider, ...(overrides.provider ?? {}) },
    heartbeat: { ...base.heartbeat, ...(overrides.heartbeat ?? {}) },
    scheduler: { ...base.scheduler, ...(overrides.scheduler ?? {}) },
    bus: { ...base.bus, ...(overrides.bus ?? {}) },
    observability: {
      ...base.observability,
      ...(overrides.observability ?? {}),
      http: {
        ...base.observability.http,
        ...(overrides.observability?.http ?? {})
      }
    },
    slo: { ...base.slo, ...(overrides.slo ?? {}) },
    isolation: { ...base.isolation, ...(overrides.isolation ?? {}) },
    webhook: { ...base.webhook, ...(overrides.webhook ?? {}) },
    cli: { ...base.cli, ...(overrides.cli ?? {}) }
  };
};

export const createStorageFixture = (overrides: TestConfigOverrides = {}) => {
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
  isolatedRuntime?: IsolatedToolRuntime;
  heartbeat?: HeartbeatController;
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
    heartbeat: params.heartbeat,
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
    skills: params.skills ?? [],
    isolatedRuntime: params.isolatedRuntime
  };

  return { context, outbound };
};
