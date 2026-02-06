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
  allowShell: z.boolean().default(false),
  allowedShellCommands: z.array(z.string()).default([]),
  allowedEnv: z.array(z.string()).default([]),
  adminBootstrapKey: z.string().optional(),
  cli: z
    .object({
      enabled: z.boolean().default(true)
    })
    .default({})
});

export type Config = z.infer<typeof ConfigSchema>;
