import { z } from "zod";

export const ConfigSchema = z.object({
  workspaceDir: z.string().default("workspace"),
  dataDir: z.string().default("data"),
  sqlitePath: z.string().default("data/bot.sqlite"),
  logLevel: z.string().default("info"),
  provider: z
    .object({
      type: z.enum(["openai"]).default("openai"),
      apiKey: z.string().optional(),
      baseUrl: z.string().default("https://api.openai.com/v1"),
      model: z.string().default("gpt-4o-mini"),
      temperature: z.number().default(0.2)
    })
    .default({}),
  historyMaxMessages: z.number().default(30),
  storeFullMessages: z.boolean().default(false),
  maxToolIterations: z.number().default(8),
  maxToolOutputChars: z.number().default(50_000),
  skillsDir: z.string().default("workspace/skills"),
  mcpConfigPath: z.string().default(".mcp.json"),
  scheduler: z
    .object({
      tickMs: z.number().default(60_000)
    })
    .default({}),
  bus: z
    .object({
      pollMs: z.number().int().min(10).default(1_000),
      batchSize: z.number().int().min(1).max(500).default(50),
      maxAttempts: z.number().int().min(1).max(20).default(5),
      retryBackoffMs: z.number().int().min(50).default(1_000),
      maxRetryBackoffMs: z.number().int().min(100).default(60_000),
      processingTimeoutMs: z.number().int().min(1_000).default(120_000)
    })
    .default({}),
  allowShell: z.boolean().default(false),
  allowedShellCommands: z.array(z.string()).default([]),
  allowedEnv: z.array(z.string()).default([]),
  allowedWebDomains: z.array(z.string()).default([]),
  allowedWebPorts: z.array(z.number().int().min(1).max(65535)).default([]),
  blockedWebPorts: z.array(z.number().int().min(1).max(65535)).default([]),
  adminBootstrapKey: z.string().optional(),
  adminBootstrapSingleUse: z.boolean().default(true),
  adminBootstrapMaxAttempts: z.number().int().min(1).max(20).default(5),
  adminBootstrapLockoutMinutes: z.number().int().min(1).max(24 * 60).default(15),
  cli: z
    .object({
      enabled: z.boolean().default(true)
    })
    .default({})
});

export type Config = z.infer<typeof ConfigSchema>;
