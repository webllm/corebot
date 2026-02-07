import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { ConfigSchema, type Config } from "./schema.js";

const parseCsv = (value?: string) =>
  value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : undefined;

const parseNumberCsv = (value?: string) => {
  const parsed = parseCsv(value);
  if (!parsed) {
    return undefined;
  }
  return parsed.map((item) => Number(item));
};

const readJsonIfExists = (filePath: string): Record<string, unknown> => {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
};

export const loadConfig = (): Config => {
  dotenv.config();
  const root = process.cwd();
  const configPath = path.join(root, "config.json");
  const fileConfig = readJsonIfExists(configPath);

  const envConfig: Record<string, unknown> = {
    workspaceDir: process.env.COREBOT_WORKSPACE,
    dataDir: process.env.COREBOT_DATA_DIR,
    sqlitePath: process.env.COREBOT_SQLITE_PATH,
    logLevel: process.env.COREBOT_LOG_LEVEL,
    historyMaxMessages: process.env.COREBOT_HISTORY_MAX
      ? Number(process.env.COREBOT_HISTORY_MAX)
      : undefined,
    storeFullMessages: process.env.COREBOT_STORE_FULL
      ? process.env.COREBOT_STORE_FULL === "true"
      : undefined,
    maxToolIterations: process.env.COREBOT_MAX_TOOL_ITER
      ? Number(process.env.COREBOT_MAX_TOOL_ITER)
      : undefined,
    maxToolOutputChars: process.env.COREBOT_MAX_TOOL_OUTPUT
      ? Number(process.env.COREBOT_MAX_TOOL_OUTPUT)
      : undefined,
    skillsDir: process.env.COREBOT_SKILLS_DIR,
    mcpConfigPath: process.env.COREBOT_MCP_CONFIG,
    bus: {
      pollMs: process.env.COREBOT_BUS_POLL_MS
        ? Number(process.env.COREBOT_BUS_POLL_MS)
        : undefined,
      batchSize: process.env.COREBOT_BUS_BATCH_SIZE
        ? Number(process.env.COREBOT_BUS_BATCH_SIZE)
        : undefined,
      maxAttempts: process.env.COREBOT_BUS_MAX_ATTEMPTS
        ? Number(process.env.COREBOT_BUS_MAX_ATTEMPTS)
        : undefined,
      retryBackoffMs: process.env.COREBOT_BUS_RETRY_BACKOFF_MS
        ? Number(process.env.COREBOT_BUS_RETRY_BACKOFF_MS)
        : undefined,
      maxRetryBackoffMs: process.env.COREBOT_BUS_MAX_RETRY_BACKOFF_MS
        ? Number(process.env.COREBOT_BUS_MAX_RETRY_BACKOFF_MS)
        : undefined,
      processingTimeoutMs: process.env.COREBOT_BUS_PROCESSING_TIMEOUT_MS
        ? Number(process.env.COREBOT_BUS_PROCESSING_TIMEOUT_MS)
        : undefined,
      maxPendingInbound: process.env.COREBOT_BUS_MAX_PENDING_INBOUND
        ? Number(process.env.COREBOT_BUS_MAX_PENDING_INBOUND)
        : undefined,
      maxPendingOutbound: process.env.COREBOT_BUS_MAX_PENDING_OUTBOUND
        ? Number(process.env.COREBOT_BUS_MAX_PENDING_OUTBOUND)
        : undefined,
      overloadPendingThreshold: process.env.COREBOT_BUS_OVERLOAD_PENDING_THRESHOLD
        ? Number(process.env.COREBOT_BUS_OVERLOAD_PENDING_THRESHOLD)
        : undefined,
      overloadBackoffMs: process.env.COREBOT_BUS_OVERLOAD_BACKOFF_MS
        ? Number(process.env.COREBOT_BUS_OVERLOAD_BACKOFF_MS)
        : undefined,
      perChatRateLimitWindowMs: process.env.COREBOT_BUS_CHAT_RATE_WINDOW_MS
        ? Number(process.env.COREBOT_BUS_CHAT_RATE_WINDOW_MS)
        : undefined,
      perChatRateLimitMax: process.env.COREBOT_BUS_CHAT_RATE_MAX
        ? Number(process.env.COREBOT_BUS_CHAT_RATE_MAX)
        : undefined
    },
    observability: {
      enabled: process.env.COREBOT_OBS_ENABLED
        ? process.env.COREBOT_OBS_ENABLED === "true"
        : undefined,
      reportIntervalMs: process.env.COREBOT_OBS_REPORT_MS
        ? Number(process.env.COREBOT_OBS_REPORT_MS)
        : undefined,
      http: {
        enabled: process.env.COREBOT_OBS_HTTP_ENABLED
          ? process.env.COREBOT_OBS_HTTP_ENABLED === "true"
          : undefined,
        host: process.env.COREBOT_OBS_HTTP_HOST,
        port: process.env.COREBOT_OBS_HTTP_PORT
          ? Number(process.env.COREBOT_OBS_HTTP_PORT)
          : undefined
      }
    },
    slo: {
      enabled: process.env.COREBOT_SLO_ENABLED
        ? process.env.COREBOT_SLO_ENABLED === "true"
        : undefined,
      alertCooldownMs: process.env.COREBOT_SLO_ALERT_COOLDOWN_MS
        ? Number(process.env.COREBOT_SLO_ALERT_COOLDOWN_MS)
        : undefined,
      maxPendingQueue: process.env.COREBOT_SLO_MAX_PENDING_QUEUE
        ? Number(process.env.COREBOT_SLO_MAX_PENDING_QUEUE)
        : undefined,
      maxDeadLetterQueue: process.env.COREBOT_SLO_MAX_DEAD_LETTER_QUEUE
        ? Number(process.env.COREBOT_SLO_MAX_DEAD_LETTER_QUEUE)
        : undefined,
      maxToolFailureRate: process.env.COREBOT_SLO_MAX_TOOL_FAILURE_RATE
        ? Number(process.env.COREBOT_SLO_MAX_TOOL_FAILURE_RATE)
        : undefined,
      maxSchedulerDelayMs: process.env.COREBOT_SLO_MAX_SCHEDULER_DELAY_MS
        ? Number(process.env.COREBOT_SLO_MAX_SCHEDULER_DELAY_MS)
        : undefined,
      maxMcpFailureRate: process.env.COREBOT_SLO_MAX_MCP_FAILURE_RATE
        ? Number(process.env.COREBOT_SLO_MAX_MCP_FAILURE_RATE)
        : undefined,
      alertWebhookUrl: process.env.COREBOT_SLO_ALERT_WEBHOOK_URL
    },
    isolation: {
      enabled: process.env.COREBOT_ISOLATION_ENABLED
        ? process.env.COREBOT_ISOLATION_ENABLED === "true"
        : undefined,
      toolNames: parseCsv(process.env.COREBOT_ISOLATION_TOOLS),
      workerTimeoutMs: process.env.COREBOT_ISOLATION_WORKER_TIMEOUT_MS
        ? Number(process.env.COREBOT_ISOLATION_WORKER_TIMEOUT_MS)
        : undefined,
      maxWorkerOutputChars: process.env.COREBOT_ISOLATION_MAX_WORKER_OUTPUT_CHARS
        ? Number(process.env.COREBOT_ISOLATION_MAX_WORKER_OUTPUT_CHARS)
        : undefined,
      maxConcurrentWorkers: process.env.COREBOT_ISOLATION_MAX_CONCURRENT_WORKERS
        ? Number(process.env.COREBOT_ISOLATION_MAX_CONCURRENT_WORKERS)
        : undefined,
      openCircuitAfterFailures: process.env.COREBOT_ISOLATION_OPEN_CIRCUIT_AFTER_FAILURES
        ? Number(process.env.COREBOT_ISOLATION_OPEN_CIRCUIT_AFTER_FAILURES)
        : undefined,
      circuitResetMs: process.env.COREBOT_ISOLATION_CIRCUIT_RESET_MS
        ? Number(process.env.COREBOT_ISOLATION_CIRCUIT_RESET_MS)
        : undefined
    },
    allowShell: process.env.COREBOT_ALLOW_SHELL
      ? process.env.COREBOT_ALLOW_SHELL === "true"
      : undefined,
    allowedShellCommands: parseCsv(process.env.COREBOT_SHELL_ALLOWLIST),
    allowedEnv: parseCsv(process.env.COREBOT_ALLOWED_ENV),
    allowedWebDomains: parseCsv(process.env.COREBOT_WEB_ALLOWLIST)?.map((item) =>
      item.toLowerCase().replace(/^\*\./, "")
    ),
    allowedWebPorts: parseNumberCsv(process.env.COREBOT_WEB_ALLOWED_PORTS),
    blockedWebPorts: parseNumberCsv(process.env.COREBOT_WEB_BLOCKED_PORTS),
    allowedMcpServers: parseCsv(process.env.COREBOT_MCP_ALLOWED_SERVERS),
    allowedMcpTools: parseCsv(process.env.COREBOT_MCP_ALLOWED_TOOLS),
    adminBootstrapKey: process.env.COREBOT_ADMIN_BOOTSTRAP_KEY,
    adminBootstrapSingleUse: process.env.COREBOT_ADMIN_BOOTSTRAP_SINGLE_USE
      ? process.env.COREBOT_ADMIN_BOOTSTRAP_SINGLE_USE === "true"
      : undefined,
    adminBootstrapMaxAttempts: process.env.COREBOT_ADMIN_BOOTSTRAP_MAX_ATTEMPTS
      ? Number(process.env.COREBOT_ADMIN_BOOTSTRAP_MAX_ATTEMPTS)
      : undefined,
    adminBootstrapLockoutMinutes: process.env.COREBOT_ADMIN_BOOTSTRAP_LOCKOUT_MINUTES
      ? Number(process.env.COREBOT_ADMIN_BOOTSTRAP_LOCKOUT_MINUTES)
      : undefined,
    webhook: {
      enabled: process.env.COREBOT_WEBHOOK_ENABLED
        ? process.env.COREBOT_WEBHOOK_ENABLED === "true"
        : undefined,
      host: process.env.COREBOT_WEBHOOK_HOST,
      port: process.env.COREBOT_WEBHOOK_PORT
        ? Number(process.env.COREBOT_WEBHOOK_PORT)
        : undefined,
      path: process.env.COREBOT_WEBHOOK_PATH,
      authToken: process.env.COREBOT_WEBHOOK_AUTH_TOKEN,
      maxBodyBytes: process.env.COREBOT_WEBHOOK_MAX_BODY_BYTES
        ? Number(process.env.COREBOT_WEBHOOK_MAX_BODY_BYTES)
        : undefined
    },
    provider: {
      type: "openai",
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL,
      model: process.env.OPENAI_MODEL,
      temperature: process.env.OPENAI_TEMPERATURE
        ? Number(process.env.OPENAI_TEMPERATURE)
        : undefined
    }
  };

  const parsed = ConfigSchema.safeParse({
    ...fileConfig,
    ...envConfig,
    bus: {
      ...(typeof fileConfig.bus === "object" ? fileConfig.bus : {}),
      ...(typeof envConfig.bus === "object" ? envConfig.bus : {})
    },
    observability: {
      ...(typeof fileConfig.observability === "object"
        ? fileConfig.observability
        : {}),
      ...(typeof envConfig.observability === "object"
        ? envConfig.observability
        : {}),
      http: {
        ...((typeof (fileConfig.observability as any)?.http === "object"
          ? (fileConfig.observability as any).http
          : {}) as Record<string, unknown>),
        ...((typeof (envConfig.observability as any)?.http === "object"
          ? (envConfig.observability as any).http
          : {}) as Record<string, unknown>)
      }
    },
    slo: {
      ...(typeof fileConfig.slo === "object" ? fileConfig.slo : {}),
      ...(typeof envConfig.slo === "object" ? envConfig.slo : {})
    },
    isolation: {
      ...(typeof fileConfig.isolation === "object" ? fileConfig.isolation : {}),
      ...(typeof envConfig.isolation === "object" ? envConfig.isolation : {})
    },
    webhook: {
      ...(typeof fileConfig.webhook === "object" ? fileConfig.webhook : {}),
      ...(typeof envConfig.webhook === "object" ? envConfig.webhook : {})
    },
    provider: {
      ...(typeof fileConfig.provider === "object" ? fileConfig.provider : {}),
      ...(typeof envConfig.provider === "object" ? envConfig.provider : {})
    }
  });

  if (!parsed.success) {
    throw new Error(`Invalid config: ${parsed.error.message}`);
  }

  return parsed.data;
};
