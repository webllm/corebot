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
import type { ToolContext } from "./tools/registry.js";

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
  const skills = skillLoader.listSkills();

  const mcpManager = new McpManager({
    logger,
    allowedServers: config.allowedMcpServers,
    allowedTools: config.allowedMcpTools
  });
  const isolatedRuntime = new IsolatedToolRuntime(config, logger);
  const toolRegistry = new ToolRegistry(new DefaultToolPolicyEngine(), telemetry);
  for (const tool of builtInTools()) {
    toolRegistry.register(tool);
  }

  const mcpConfigPath = path.resolve(config.mcpConfigPath);
  try {
    const mcpToolDefs = await mcpManager.loadFromConfig(mcpConfigPath);
    for (const def of mcpToolDefs) {
      toolRegistry.registerRaw(def, async (args: unknown, ctx: ToolContext) => {
        const result = await ctx.mcp.callTool(def.name, args);
        return formatMcpResult(result);
      });
    }
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
    skills,
    isolatedRuntime
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
