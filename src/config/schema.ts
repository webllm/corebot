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
      processingTimeoutMs: z.number().int().min(1_000).default(120_000),
      maxPendingInbound: z.number().int().min(1).default(5_000),
      maxPendingOutbound: z.number().int().min(1).default(5_000),
      overloadPendingThreshold: z.number().int().min(1).default(2_000),
      overloadBackoffMs: z.number().int().min(0).default(500),
      perChatRateLimitWindowMs: z.number().int().min(1_000).default(60_000),
      perChatRateLimitMax: z.number().int().min(1).default(120)
    })
    .default({}),
  observability: z
    .object({
      enabled: z.boolean().default(true),
      reportIntervalMs: z.number().int().min(1_000).default(30_000),
      http: z
        .object({
          enabled: z.boolean().default(false),
          host: z.string().default("127.0.0.1"),
          port: z.number().int().min(1).max(65535).default(3210)
        })
        .default({})
    })
    .default({}),
  slo: z
    .object({
      enabled: z.boolean().default(true),
      alertCooldownMs: z.number().int().min(1_000).default(60_000),
      maxPendingQueue: z.number().int().min(1).default(2_000),
      maxDeadLetterQueue: z.number().int().min(0).default(20),
      maxToolFailureRate: z.number().min(0).max(1).default(0.2),
      maxSchedulerDelayMs: z.number().int().min(0).default(60_000),
      maxMcpFailureRate: z.number().min(0).max(1).default(0.3),
      alertWebhookUrl: z.string().url().optional()
    })
    .default({}),
  isolation: z
    .object({
      enabled: z.boolean().default(true),
      toolNames: z.array(z.string()).default(["shell.exec"]),
      workerTimeoutMs: z.number().int().min(1_000).default(30_000),
      maxWorkerOutputChars: z.number().int().min(1_000).max(2_000_000).default(250_000),
      maxConcurrentWorkers: z.number().int().min(1).max(64).default(4),
      openCircuitAfterFailures: z.number().int().min(1).max(50).default(5),
      circuitResetMs: z.number().int().min(1_000).max(3_600_000).default(30_000)
    })
    .default({}),
  allowShell: z.boolean().default(false),
  allowedShellCommands: z.array(z.string()).default([]),
  allowedEnv: z.array(z.string()).default([]),
  allowedWebDomains: z.array(z.string()).default([]),
  allowedWebPorts: z.array(z.number().int().min(1).max(65535)).default([]),
  blockedWebPorts: z.array(z.number().int().min(1).max(65535)).default([]),
  allowedMcpServers: z.array(z.string()).default([]),
  allowedMcpTools: z.array(z.string()).default([]),
  adminBootstrapKey: z.string().optional(),
  adminBootstrapSingleUse: z.boolean().default(true),
  adminBootstrapMaxAttempts: z.number().int().min(1).max(20).default(5),
  adminBootstrapLockoutMinutes: z.number().int().min(1).max(24 * 60).default(15),
  webhook: z
    .object({
      enabled: z.boolean().default(false),
      host: z.string().default("0.0.0.0"),
      port: z.number().int().min(1).max(65535).default(8788),
      path: z.string().default("/webhook"),
      authToken: z.string().optional(),
      maxBodyBytes: z.number().int().min(1_024).max(10_000_000).default(1_000_000)
    })
    .default({}),
  cli: z
    .object({
      enabled: z.boolean().default(true)
    })
    .default({})
});

export type Config = z.infer<typeof ConfigSchema>;
