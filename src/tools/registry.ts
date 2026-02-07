import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
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

export type ToolContext = {
  workspaceDir: string;
  chat: { channel: string; chatId: string; role: "admin" | "normal"; id: string };
  storage: SqliteStorage;
  mcp: McpManager;
  logger: Logger;
  bus: MessageBus;
  config: Config;
  skills: SkillIndexEntry[];
  isolatedRuntime?: IsolatedToolRuntime;
};

export interface ToolSpec<TArgs extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: TArgs;
  run: (args: z.infer<TArgs>, ctx: ToolContext) => Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolSpec<z.ZodTypeAny>>();
  private toolDefs: ToolDefinition[] = [];

  constructor(
    private policyEngine?: ToolPolicyEngine,
    private telemetry?: RuntimeTelemetry
  ) {}

  register<TArgs extends z.ZodTypeAny>(tool: ToolSpec<TArgs>) {
    this.tools.set(tool.name, tool as unknown as ToolSpec<z.ZodTypeAny>);
    const jsonSchema = zodToJsonSchema(tool.schema, {
      name: tool.name
    }) as Record<string, unknown>;
    this.toolDefs.push({
      name: tool.name,
      description: tool.description,
      parameters: jsonSchema
    });
  }

  registerRaw(def: ToolDefinition, handler: (args: unknown, ctx: ToolContext) => Promise<string>) {
    const schema = z.any();
    const spec: ToolSpec<z.ZodTypeAny> = {
      name: def.name,
      description: def.description,
      schema,
      run: async (args, ctx) => handler(args, ctx)
    };
    this.tools.set(def.name, spec);
    this.toolDefs.push(def);
  }

  listDefinitions(): ToolDefinition[] {
    return this.toolDefs;
  }

  async execute(name: string, args: unknown, ctx: ToolContext): Promise<string> {
    const startedAt = Date.now();
    const tool = this.tools.get(name);
    if (!tool) {
      this.telemetry?.recordToolExecution(name, Date.now() - startedAt, false);
      throw new Error(`Tool not found: ${name}`);
    }
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      this.telemetry?.recordToolExecution(name, Date.now() - startedAt, false);
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
        throw new Error(`Policy denied ${name}: ${decision.reason ?? "access denied"}`);
      }
    }
    try {
      const result = await tool.run(parsed.data, ctx);
      this.telemetry?.recordToolExecution(name, Date.now() - startedAt, true);
      if (result.length > ctx.config.maxToolOutputChars) {
        return result.slice(0, ctx.config.maxToolOutputChars) + "\n...truncated";
      }
      return result;
    } catch (error) {
      this.telemetry?.recordToolExecution(name, Date.now() - startedAt, false);
      throw error;
    }
  }
}
