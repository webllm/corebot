import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config/load.js";
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
import { Scheduler } from "./scheduler/scheduler.js";
import { IsolatedToolRuntime } from "./isolation/runtime.js";
import type { ToolContext } from "./tools/registry.js";

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

const ensureDir = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
};

const main = async () => {
  const config = loadConfig();
  ensureDir(config.dataDir);
  ensureDir(path.dirname(config.sqlitePath));
  ensureDir(config.workspaceDir);

  const logger = createLogger(config);
  const telemetry = new RuntimeTelemetry();

  const storage = new SqliteStorage(config);
  storage.init();

  const skillLoader = new SkillLoader(config.skillsDir);
  const skills = skillLoader.listSkills();

  const mcpManager = new McpManager({ logger });
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

  const channels = [] as Array<CliChannel>;
  if (config.cli.enabled) {
    const cli = new CliChannel();
    channels.push(cli);
    await cli.start(bus, logger);
  }

  bus.onOutbound(async (message) => {
    for (const channel of channels) {
      if (channel.name === message.channel) {
        await channel.send({ chatId: message.chatId, content: message.content });
      }
    }
  });

  bus.start();

  const scheduler = new Scheduler(storage, bus, logger, config, telemetry);
  scheduler.start();

  const getQueueSnapshot = () => ({
    inbound: storage.countBusMessagesByStatus("inbound"),
    outbound: storage.countBusMessagesByStatus("outbound")
  });
  const getTelemetrySnapshot = () => telemetry.snapshot();
  const getMcpSnapshot = () => mcpManager.getHealthSnapshot();

  let startupComplete = false;
  let shuttingDown = false;
  const readiness = () => !shuttingDown && bus.isRunning() && scheduler.isRunning();

  const observabilityServer = new ObservabilityServer(config, logger, {
    startedAtMs: Date.now(),
    getQueue: getQueueSnapshot,
    getTelemetry: getTelemetrySnapshot,
    getMcp: getMcpSnapshot,
    isReady: readiness,
    isStartupComplete: () => startupComplete
  });
  await observabilityServer.start();
  startupComplete = true;

  const sloMonitor = new SloMonitor(config, logger);
  const observabilityTimer = config.observability.enabled
    ? setInterval(() => {
        const queue = getQueueSnapshot();
        const telemetrySnapshot = getTelemetrySnapshot();
        const mcpSnapshot = getMcpSnapshot();
        logger.info(
          {
            observability: {
              queue,
              ...telemetrySnapshot,
              mcp: mcpSnapshot
            }
          },
          "runtime observability snapshot"
        );
        void sloMonitor.evaluate({
          queue,
          telemetry: telemetrySnapshot,
          mcp: mcpSnapshot
        });
      }, config.observability.reportIntervalMs)
    : null;

  process.on("SIGINT", async () => {
    logger.info("Shutting down...");
    shuttingDown = true;
    scheduler.stop();
    bus.stop();
    if (observabilityTimer) {
      clearInterval(observabilityTimer);
    }
    await observabilityServer.stop();
    await isolatedRuntime.shutdown();
    await mcpManager.shutdown();
    storage.close();
    process.exit(0);
  });
};

void main();
