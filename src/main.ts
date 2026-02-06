import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config/load.js";
import { createLogger } from "./observability/logger.js";
import { SqliteStorage } from "./storage/sqlite.js";
import { MessageBus } from "./bus/bus.js";
import { ConversationRouter } from "./bus/router.js";
import { ContextBuilder } from "./agent/context.js";
import { AgentRuntime, OpenAICompatibleProvider } from "./agent/runtime.js";
import { ToolRegistry } from "./tools/registry.js";
import { builtInTools } from "./tools/builtins/index.js";
import { McpManager } from "./mcp/manager.js";
import { SkillLoader } from "./skills/loader.js";
import { CliChannel } from "./channels/cli.js";
import { Scheduler } from "./scheduler/scheduler.js";
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

  const storage = new SqliteStorage(config);
  storage.init();

  const skillLoader = new SkillLoader(config.skillsDir);
  const skills = skillLoader.listSkills();

  const mcpManager = new McpManager();
  const toolRegistry = new ToolRegistry();

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

  const bus = new MessageBus(logger);
  const contextBuilder = new ContextBuilder(storage, config, config.workspaceDir);
  const router = new ConversationRouter(
    storage,
    contextBuilder,
    runtime,
    mcpManager,
    bus,
    logger,
    config,
    skills
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

  const scheduler = new Scheduler(storage, bus, logger, config);
  scheduler.start();

  process.on("SIGINT", async () => {
    logger.info("Shutting down...");
    scheduler.stop();
    await mcpManager.shutdown();
    storage.close();
    process.exit(0);
  });
};

void main();
