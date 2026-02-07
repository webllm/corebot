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
