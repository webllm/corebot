import fs from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { loadConfig } from "./config/load.js";
import type { Config } from "./config/schema.js";
import { createLogger } from "./observability/logger.js";
import { RuntimeTelemetry } from "./observability/telemetry.js";
import { ObservabilityServer } from "./observability/server.js";
import { SloMonitor } from "./observability/slo.js";
import { SqliteStorage } from "./storage/sqlite.js";
import { MessageBus } from "./bus/bus.js";
import { ConversationRouter } from "./bus/router.js";
import { ContextBuilder } from "./agent/context.js";
import { AgentRuntime, OpenAICompatibleProvider } from "./agent/runtime.js";
import { ToolRegistry } from "./tools/registry.js";
import { DefaultToolPolicyEngine } from "./tools/policy.js";
import { builtInTools } from "./tools/builtins/index.js";
import { McpManager } from "./mcp/manager.js";
import { SkillLoader } from "./skills/loader.js";
import { CliChannel } from "./channels/cli.js";
import { WebhookChannel } from "./channels/webhook.js";
import type { Channel } from "./channels/base.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { IsolatedToolRuntime } from "./isolation/runtime.js";
import type {
  ToolContext,
  McpReloadRequest,
  McpReloadResult
} from "./tools/registry.js";

const ensureDir = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
};

const formatMcpResult = (result: unknown): string => {
  if (typeof result === "string") {
    return result;
  }
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content?: Array<{ text?: string }> }).content;
    if (Array.isArray(content)) {
      return content.map((item) => item.text ?? JSON.stringify(item)).join("\n");
    }
  }
  return JSON.stringify(result, null, 2);
};

export type CreateCorebotAppOptions = {
  config?: Config;
  logger?: Logger;
};

export class CorebotApp {
  private channels: Channel[] = [];
  private observabilityTimer: NodeJS.Timeout | null = null;
  private startupComplete = false;
  private shuttingDown = false;
  private started = false;
  private observabilityServer: ObservabilityServer;
  private readonly sloMonitor: SloMonitor;

  constructor(
    readonly config: Config,
    readonly logger: Logger,
    readonly telemetry: RuntimeTelemetry,
    readonly storage: SqliteStorage,
    readonly mcpManager: McpManager,
    readonly isolatedRuntime: IsolatedToolRuntime,
    readonly toolRegistry: ToolRegistry,
    readonly runtime: AgentRuntime,
    readonly bus: MessageBus,
    readonly scheduler: Scheduler
  ) {
    const getQueueSnapshot = () => ({
      inbound: this.storage.countBusMessagesByStatus("inbound"),
      outbound: this.storage.countBusMessagesByStatus("outbound")
    });
    const getTelemetrySnapshot = () => this.telemetry.snapshot();
    const getMcpSnapshot = () => this.mcpManager.getHealthSnapshot();
    const readiness = () => !this.shuttingDown && this.bus.isRunning() && this.scheduler.isRunning();

    this.observabilityServer = new ObservabilityServer(this.config, this.logger, {
      startedAtMs: Date.now(),
      getQueue: getQueueSnapshot,
      getTelemetry: getTelemetrySnapshot,
      getMcp: getMcpSnapshot,
      isReady: readiness,
      isStartupComplete: () => this.startupComplete
    });
    this.sloMonitor = new SloMonitor(this.config, this.logger);

    this.bus.onOutbound(async (message) => {
      for (const channel of this.channels) {
        if (channel.name === message.channel) {
          await channel.send({ chatId: message.chatId, content: message.content });
        }
      }
    });
  }

  isRunning() {
    return this.started;
  }

  async start() {
    if (this.started) {
      return;
    }

    if (this.config.cli.enabled) {
      const cli = new CliChannel();
      this.channels.push(cli);
      await cli.start(this.bus, this.logger);
    }
    if (this.config.webhook.enabled) {
      const webhook = new WebhookChannel(this.config);
      this.channels.push(webhook);
      await webhook.start(this.bus, this.logger);
    }

    this.bus.start();
    this.scheduler.start();
    await this.observabilityServer.start();

    this.startupComplete = true;
    this.started = true;

    if (this.config.observability.enabled) {
      this.observabilityTimer = setInterval(() => {
        const queue = {
          inbound: this.storage.countBusMessagesByStatus("inbound"),
          outbound: this.storage.countBusMessagesByStatus("outbound")
        };
        const telemetrySnapshot = this.telemetry.snapshot();
        const mcpSnapshot = this.mcpManager.getHealthSnapshot();
        this.logger.info(
          {
            observability: {
              queue,
              ...telemetrySnapshot,
              mcp: mcpSnapshot
            }
          },
          "runtime observability snapshot"
        );
        void this.sloMonitor.evaluate({
          queue,
          telemetry: telemetrySnapshot,
          mcp: mcpSnapshot
        });
      }, this.config.observability.reportIntervalMs);
    }
  }

  async stop() {
    if (!this.started) {
      return;
    }
    this.shuttingDown = true;
    this.scheduler.stop();
    this.bus.stop();

    if (this.observabilityTimer) {
      clearInterval(this.observabilityTimer);
      this.observabilityTimer = null;
    }
    await this.observabilityServer.stop();
    for (const channel of this.channels) {
      if (channel.stop) {
        await channel.stop();
      }
    }
    this.channels = [];
    await this.isolatedRuntime.shutdown();
    await this.mcpManager.shutdown();
    this.storage.close();
    this.started = false;
  }
}

export const createCorebotApp = async (
  options: CreateCorebotAppOptions = {}
): Promise<CorebotApp> => {
  const config = options.config ?? loadConfig();
  ensureDir(config.dataDir);
  ensureDir(path.dirname(config.sqlitePath));
  ensureDir(config.workspaceDir);

  const logger = options.logger ?? createLogger(config);
  const telemetry = new RuntimeTelemetry();
  const storage = new SqliteStorage(config);
  storage.init();

  const skillLoader = new SkillLoader(config.skillsDir);

  const mcpManager = new McpManager({
    logger,
    allowedServers: config.allowedMcpServers,
    allowedTools: config.allowedMcpTools
  });
  const isolatedRuntime = new IsolatedToolRuntime(config, logger);
  const toolRegistry = new ToolRegistry(new DefaultToolPolicyEngine(), telemetry);
  const mcpConfigPath = path.resolve(config.mcpConfigPath);
  let mcpConfigSignature: string | null = null;
  let mcpSyncInFlight: Promise<McpReloadResult> | null = null;

  const readMcpConfigSignature = () => {
    try {
      const stat = fs.statSync(mcpConfigPath);
      return `present:${stat.mtimeMs}:${stat.size}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "missing";
      }
      throw error;
    }
  };

  const countRegisteredMcpTools = () =>
    toolRegistry.listDefinitions().filter((def) => def.name.startsWith("mcp__")).length;

  const writeMcpReloadAudit = (params: {
    request: McpReloadRequest & { reason: string };
    outcome: "reloaded" | "failed";
    durationMs: number;
    result?: McpReloadResult;
    error?: string;
  }) => {
    try {
      const metadata: Record<string, unknown> = {
        reason: params.request.reason,
        force: Boolean(params.request.force),
        durationMs: params.durationMs,
        configSignature:
          params.result?.configSignature ??
          mcpConfigSignature ??
          readMcpConfigSignature(),
        toolCount: params.result?.toolCount ?? countRegisteredMcpTools()
      };
      if (params.error) {
        metadata.error = params.error;
      }
      storage.insertAuditEvent({
        at: new Date().toISOString(),
        eventType: "mcp.reload",
        toolName: "mcp.reload",
        chatFk: params.request.audit?.chatFk,
        channel: params.request.audit?.channel,
        chatId: params.request.audit?.chatId,
        actorRole: params.request.audit?.actorRole ?? "system",
        outcome: params.outcome,
        reason: params.error ?? params.request.reason,
        argsJson: JSON.stringify({
          force: Boolean(params.request.force),
          reason: params.request.reason
        }),
        metadataJson: JSON.stringify(metadata)
      });
    } catch {
      // MCP reload audit is best-effort and should never break runtime flow.
    }
  };

  const syncMcpTools = async (
    request: McpReloadRequest & { reason: string }
  ): Promise<McpReloadResult> => {
    if (mcpSyncInFlight) {
      return mcpSyncInFlight;
    }

    const startedAtMs = Date.now();
    const force = Boolean(request.force);
    const currentSignature = readMcpConfigSignature();
    if (!force && mcpConfigSignature !== null && currentSignature === mcpConfigSignature) {
      const result: McpReloadResult = {
        reloaded: false,
        reason: request.reason,
        toolCount: countRegisteredMcpTools(),
        configSignature: currentSignature
      };
      telemetry.recordMcpReload({
        reason: request.reason,
        durationMs: Date.now() - startedAtMs,
        outcome: "skipped"
      });
      return result;
    }

    mcpSyncInFlight = (async () => {
      try {
        const defs = await mcpManager.reloadFromConfig(mcpConfigPath);
        toolRegistry.replaceRawByPrefix(
          "mcp__",
          defs,
          (def) => async (args: unknown, ctx: ToolContext) => {
            const result = await ctx.mcp.callTool(def.name, args);
            return formatMcpResult(result);
          }
        );

        const updatedSignature = readMcpConfigSignature();
        mcpConfigSignature = updatedSignature;
        const durationMs = Date.now() - startedAtMs;
        const result: McpReloadResult = {
          reloaded: true,
          reason: request.reason,
          toolCount: defs.length,
          configSignature: updatedSignature
        };

        telemetry.recordMcpReload({
          reason: request.reason,
          durationMs,
          outcome: "reloaded"
        });
        writeMcpReloadAudit({
          request,
          outcome: "reloaded",
          durationMs,
          result
        });
        logger.info(
          {
            reason: request.reason,
            toolCount: defs.length,
            configSignature: updatedSignature,
            durationMs
          },
          "MCP tools synchronized"
        );
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const durationMs = Date.now() - startedAtMs;
        telemetry.recordMcpReload({
          reason: request.reason,
          durationMs,
          outcome: "failed"
        });
        writeMcpReloadAudit({
          request,
          outcome: "failed",
          durationMs,
          error: message
        });
        logger.warn(
          {
            error: message,
            reason: request.reason,
            durationMs
          },
          "failed to sync MCP tools"
        );
        throw error;
      }
    })().finally(() => {
        mcpSyncInFlight = null;
      });

    return mcpSyncInFlight;
  };

  const mcpReloader: ToolContext["mcpReloader"] = (params = {}) =>
    syncMcpTools({
      force: params.force,
      reason: params.reason ?? "manual:unspecified",
      audit: params.audit
    });

  for (const tool of builtInTools({ mcpReloader })) {
    toolRegistry.register(tool);
  }

  try {
    await syncMcpTools({ force: true, reason: "startup" });
  } catch (error) {
    logger.warn({ error }, "failed to load MCP tools");
  }

  const provider = new OpenAICompatibleProvider(config);
  const runtime = new AgentRuntime(provider, toolRegistry, config, logger);
  const bus = new MessageBus(storage, config, logger);
  const contextBuilder = new ContextBuilder(storage, config, config.workspaceDir);
  const router = new ConversationRouter(
    storage,
    contextBuilder,
    runtime,
    mcpManager,
    bus,
    logger,
    config,
    () => skillLoader.listSkills(),
    isolatedRuntime,
    mcpReloader
  );
  bus.onInbound(router.handleInbound);
  const scheduler = new Scheduler(storage, bus, logger, config, telemetry);

  return new CorebotApp(
    config,
    logger,
    telemetry,
    storage,
    mcpManager,
    isolatedRuntime,
    toolRegistry,
    runtime,
    bus,
    scheduler
  );
};
