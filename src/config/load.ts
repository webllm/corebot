import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { ConfigSchema, type Config } from "./schema.js";

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
    allowShell: process.env.COREBOT_ALLOW_SHELL
      ? process.env.COREBOT_ALLOW_SHELL === "true"
      : undefined,
    allowedShellCommands: process.env.COREBOT_SHELL_ALLOWLIST
      ? process.env.COREBOT_SHELL_ALLOWLIST.split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : undefined,
    allowedEnv: process.env.COREBOT_ALLOWED_ENV
      ? process.env.COREBOT_ALLOWED_ENV.split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : undefined,
    allowedWebDomains: process.env.COREBOT_WEB_ALLOWLIST
      ? process.env.COREBOT_WEB_ALLOWLIST.split(",")
          .map((item) => item.trim().toLowerCase().replace(/^\*\./, ""))
          .filter(Boolean)
      : undefined,
    adminBootstrapKey: process.env.COREBOT_ADMIN_BOOTSTRAP_KEY,
    adminBootstrapSingleUse: process.env.COREBOT_ADMIN_BOOTSTRAP_SINGLE_USE
      ? process.env.COREBOT_ADMIN_BOOTSTRAP_SINGLE_USE === "true"
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
