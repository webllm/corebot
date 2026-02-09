import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import type { SqliteStorage } from "../storage/sqlite.js";
import type { McpManager } from "../mcp/manager.js";
import type { MessageBus } from "../bus/bus.js";
import type { Config } from "../config/schema.js";
import type { SkillIndexEntry } from "../skills/types.js";
import type { Logger } from "pino";
import type { ToolPolicyEngine } from "./policy.js";
import type { RuntimeTelemetry } from "../observability/telemetry.js";
import type { IsolatedToolRuntime } from "../isolation/runtime.js";
import type { HeartbeatController } from "../heartbeat/service.js";
import { nowIso } from "../util/time.js";

const SENSITIVE_KEY_PATTERN = /(key|token|secret|password|authorization|cookie)/i;

const redactValue = (value: unknown, depth = 0): unknown => {
  if (depth >= 4) {
    return "[DEPTH_LIMIT]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      redacted[key] = "[REDACTED]";
    } else {
      redacted[key] = redactValue(entry, depth + 1);
    }
  }
  return redacted;
};

export type ToolContext = {
  workspaceDir: string;
  chat: { channel: string; chatId: string; role: "admin" | "normal"; id: string };
  storage: SqliteStorage;
  mcp: McpManager;
  mcpReloader?: (params?: McpReloadRequest) => Promise<McpReloadResult>;
  heartbeat?: HeartbeatController;
  logger: Logger;
  bus: MessageBus;
  config: Config;
  skills: SkillIndexEntry[];
  isolatedRuntime?: IsolatedToolRuntime;
};

export type McpReloadRequest = {
  force?: boolean;
  reason?: string;
  audit?: {
    chatFk?: string;
    channel?: string;
    chatId?: string;
    actorRole?: string;
  };
};

export type McpReloadResult = {
  reloaded: boolean;
  reason: string;
  toolCount: number;
  configSignature: string;
  skipCause?: "unchanged" | "backoff" | "circuit_open";
  retryAt?: string;
};

export interface ToolSpec<TArgs extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: TArgs;
  run: (args: z.infer<TArgs>, ctx: ToolContext) => Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolSpec<any>>();
  private toolDefs: ToolDefinition[] = [];

  constructor(
    private policyEngine?: ToolPolicyEngine,
    private telemetry?: RuntimeTelemetry
  ) {}

  register<TArgs extends z.ZodType>(tool: ToolSpec<TArgs>) {
    this.tools.set(tool.name, tool as unknown as ToolSpec<any>);
    const jsonSchema = z.toJSONSchema(tool.schema) as Record<string, unknown>;
    this.upsertDefinition({
      name: tool.name,
      description: tool.description,
      parameters: jsonSchema
    });
  }

  registerRaw(def: ToolDefinition, handler: (args: unknown, ctx: ToolContext) => Promise<string>) {
    const schema = z.any();
    const spec: ToolSpec<any> = {
      name: def.name,
      description: def.description,
      schema,
      run: async (args, ctx) => handler(args, ctx)
    };
    this.tools.set(def.name, spec);
    this.upsertDefinition(def);
  }

  removeByPrefix(prefix: string) {
    for (const name of [...this.tools.keys()]) {
      if (name.startsWith(prefix)) {
        this.tools.delete(name);
      }
    }
    this.toolDefs = this.toolDefs.filter((def) => !def.name.startsWith(prefix));
  }

  replaceRawByPrefix(
    prefix: string,
    defs: ToolDefinition[],
    handler: (def: ToolDefinition) => (args: unknown, ctx: ToolContext) => Promise<string>
  ) {
    const nextTools = new Map(this.tools);
    for (const name of [...nextTools.keys()]) {
      if (name.startsWith(prefix)) {
        nextTools.delete(name);
      }
    }

    const nextDefMap = new Map<string, ToolDefinition>();
    for (const def of this.toolDefs) {
      if (!def.name.startsWith(prefix)) {
        nextDefMap.set(def.name, def);
      }
    }

    for (const def of defs) {
      const spec: ToolSpec<any> = {
        name: def.name,
        description: def.description,
        schema: z.any(),
        run: async (args, ctx) => handler(def)(args, ctx)
      };
      nextTools.set(def.name, spec);
      nextDefMap.set(def.name, def);
    }

    this.tools = nextTools;
    this.toolDefs = [...nextDefMap.values()];
  }

  listDefinitions(): ToolDefinition[] {
    return [...this.toolDefs];
  }

  async execute(name: string, args: unknown, ctx: ToolContext): Promise<string> {
    const startedAt = Date.now();
    const argsJson = JSON.stringify(redactValue(args));
    const writeAudit = (params: {
      outcome: string;
      reason?: string;
      metadata?: Record<string, unknown>;
    }) => {
      try {
        ctx.storage.insertAuditEvent({
          at: nowIso(),
          eventType: "tool.execute",
          toolName: name,
          chatFk: ctx.chat.id,
          channel: ctx.chat.channel,
          chatId: ctx.chat.chatId,
          actorRole: ctx.chat.role,
          outcome: params.outcome,
          reason: params.reason,
          argsJson,
          metadataJson: params.metadata ? JSON.stringify(params.metadata) : undefined
        });
      } catch {
        // Audit write should not impact tool execution path.
      }
    };

    const tool = this.tools.get(name);
    if (!tool) {
      this.telemetry?.recordToolExecution(name, Date.now() - startedAt, false);
      writeAudit({
        outcome: "error",
        reason: "tool_not_found"
      });
      throw new Error(`Tool not found: ${name}`);
    }
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      this.telemetry?.recordToolExecution(name, Date.now() - startedAt, false);
      writeAudit({
        outcome: "invalid_args",
        reason: parsed.error.message
      });
      throw new Error(`Invalid arguments for ${name}: ${parsed.error.message}`);
    }
    if (this.policyEngine) {
      const decision = await this.policyEngine.authorize({
        toolName: name,
        args: parsed.data,
        ctx
      });
      if (!decision.allowed) {
        this.telemetry?.recordToolExecution(name, Date.now() - startedAt, false);
        writeAudit({
          outcome: "denied",
          reason: decision.reason ?? "access denied"
        });
        throw new Error(`Policy denied ${name}: ${decision.reason ?? "access denied"}`);
      }
    }
    try {
      const result = await tool.run(parsed.data, ctx);
      this.telemetry?.recordToolExecution(name, Date.now() - startedAt, true);
      writeAudit({
        outcome: "success",
        metadata: {
          durationMs: Date.now() - startedAt
        }
      });
      if (result.length > ctx.config.maxToolOutputChars) {
        return result.slice(0, ctx.config.maxToolOutputChars) + "\n...truncated";
      }
      return result;
    } catch (error) {
      this.telemetry?.recordToolExecution(name, Date.now() - startedAt, false);
      const message = error instanceof Error ? error.message : String(error);
      writeAudit({
        outcome: "error",
        reason: message,
        metadata: {
          durationMs: Date.now() - startedAt
        }
      });
      throw error;
    }
  }

  private upsertDefinition(def: ToolDefinition) {
    this.toolDefs = this.toolDefs.filter((entry) => entry.name !== def.name);
    this.toolDefs.push(def);
  }
}
