import fs from "node:fs";
import { z } from "zod";
import type { McpConfigFile } from "./types.js";

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

const mcpServerConfigSchema = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    url: z.string().url().optional(),
    env: z.record(z.string(), z.string()).optional(),
    disabled: z.boolean().optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.disabled) {
      return;
    }

    const hasCommand = typeof value.command === "string" && value.command.length > 0;
    const hasUrl = typeof value.url === "string" && value.url.length > 0;
    if (hasCommand === hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must define exactly one of 'command' or 'url' when not disabled"
      });
    }

    if (!hasCommand && value.args && value.args.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'args' is only valid when 'command' is set"
      });
    }

    if (!hasCommand && value.env && Object.keys(value.env).length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'env' is only valid when 'command' is set"
      });
    }
  });

const mcpConfigSchema = z
  .object({
    servers: z.record(
      z
        .string()
        .min(1, "server name cannot be empty")
        .regex(
          SERVER_NAME_PATTERN,
          "server name must match /^[A-Za-z0-9_.-]+$/"
        ),
      mcpServerConfigSchema
    )
  })
  .strict();

const formatZodIssues = (issues: z.ZodIssue[]) =>
  issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

export const parseMcpConfigJson = (raw: string): McpConfigFile => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid MCP config JSON: ${detail}`);
  }

  const validated = mcpConfigSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Invalid MCP config: ${formatZodIssues(validated.error.issues)}`);
  }
  return validated.data as McpConfigFile;
};

export const readMcpConfigFile = (configPath: string): McpConfigFile | null => {
  if (!fs.existsSync(configPath)) {
    return null;
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  return parseMcpConfigJson(raw);
};

