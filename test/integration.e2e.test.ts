import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage, ToolCall } from "../src/types.js";
import { MessageBus } from "../src/bus/bus.js";
import { ConversationRouter } from "../src/bus/router.js";
import { ContextBuilder } from "../src/agent/context.js";
import { AgentRuntime, type LlmProvider } from "../src/agent/runtime.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { DefaultToolPolicyEngine } from "../src/tools/policy.js";
import { builtInTools } from "../src/tools/builtins/index.js";
import { McpManager } from "../src/mcp/manager.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { RuntimeTelemetry } from "../src/observability/telemetry.js";
import type { Config } from "../src/config/schema.js";
import { IsolatedToolRuntime } from "../src/isolation/runtime.js";
import { createStorageFixture } from "./test-utils.js";

type HarnessOverrides = Partial<
  Omit<Config, "provider" | "scheduler" | "bus" | "observability" | "isolation" | "cli">
> & {
  provider?: Partial<Config["provider"]>;
  scheduler?: Partial<Config["scheduler"]>;
  bus?: Partial<Config["bus"]>;
  observability?: Partial<Config["observability"]>;
  isolation?: Partial<Config["isolation"]>;
  cli?: Partial<Config["cli"]>;
};

const waitUntil = async (
  predicate: () => boolean,
  timeoutMs = 3_000,
  intervalMs = 25
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
};

class MockProvider implements LlmProvider {
  constructor(
    private responder: (req: {
      model: string;
      messages: ChatMessage[];
      tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
      temperature?: number;
    }) => Promise<{ content?: string; toolCalls?: ToolCall[] }>
  ) {}

  async chat(req: {
    model: string;
    messages: ChatMessage[];
    tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    temperature?: number;
  }): Promise<{ content?: string; toolCalls?: ToolCall[] }> {
    return this.responder(req);
  }
}

const createNoopLogger = () =>
  ({
    fatal: () => undefined,
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => createNoopLogger()
  }) as any;

const createHarness = (provider: LlmProvider, overrides: HarnessOverrides = {}) => {
  const schedulerDefaults = { tickMs: 20 };
  const busDefaults = {
    pollMs: 10,
    batchSize: 20,
    maxAttempts: 3,
    retryBackoffMs: 10,
    maxRetryBackoffMs: 100,
    processingTimeoutMs: 200
  };
  const fixture = createStorageFixture({
    ...overrides,
    scheduler: {
      ...schedulerDefaults,
      ...(overrides.scheduler ?? {})
    },
    bus: {
      ...busDefaults,
      ...(overrides.bus ?? {})
    }
  });

  const logger = createNoopLogger();
  const telemetry = new RuntimeTelemetry();
  const mcp = new McpManager({ logger });
  const isolatedRuntime = new IsolatedToolRuntime(fixture.config, logger);
  const registry = new ToolRegistry(new DefaultToolPolicyEngine(), telemetry);
  for (const tool of builtInTools()) {
    registry.register(tool);
  }

  const runtime = new AgentRuntime(provider, registry, fixture.config, logger);
  const contextBuilder = new ContextBuilder(
    fixture.storage,
    fixture.config,
    fixture.workspaceDir
  );
  const bus = new MessageBus(fixture.storage, fixture.config, logger);
  const router = new ConversationRouter(
    fixture.storage,
    contextBuilder,
    runtime,
    mcp,
    bus,
    logger,
    fixture.config,
    [],
    isolatedRuntime
  );
  bus.onInbound(router.handleInbound);

  const outbound: Array<{ channel: string; chatId: string; content: string }> = [];
  bus.onOutbound(async (message) => {
    outbound.push({
      channel: message.channel,
      chatId: message.chatId,
      content: message.content
    });
  });

  bus.start();

  const cleanup = async () => {
    bus.stop();
    await isolatedRuntime.shutdown();
    await mcp.shutdown();
    fixture.cleanup();
  };

  return {
    ...fixture,
    logger,
    telemetry,
    mcp,
    bus,
    router,
    outbound,
    cleanup
  };
};

test("E2E: inbound message routes through router and persists assistant reply", async () => {
  const provider = new MockProvider(async (req) => {
    const last = req.messages[req.messages.length - 1];
    const content = "content" in last ? last.content : "";
    return { content: `echo:${content}` };
  });
  const harness = createHarness(provider);

  try {
    const chat = harness.storage.upsertChat({ channel: "cli", chatId: "local" });
    harness.storage.setChatRegistered(chat.id, true);

    harness.bus.publishInbound({
      id: "in-1",
      channel: "cli",
      chatId: "local",
      senderId: "user",
      content: "hello corebot",
      createdAt: new Date().toISOString()
    });

    await waitUntil(() => harness.outbound.length >= 1);
    assert.equal(harness.outbound[0]?.content, "echo:hello corebot");

    const history = harness.storage.listRecentMessages(chat.id, 10);
    assert.ok(history.some((item) => item.role === "assistant" && item.content === "echo:hello corebot"));
  } finally {
    await harness.cleanup();
  }
});

test("E2E: runtime tool loop executes built-in tool and returns final response", async () => {
  const provider = new MockProvider(async (req) => {
    const hasToolResult = req.messages.some((message) => message.role === "tool");
    if (!hasToolResult) {
      return {
        toolCalls: [
          {
            id: "call-1",
            name: "memory.write",
            args: {
              scope: "chat",
              mode: "replace",
              content: "persisted note"
            }
          }
        ]
      };
    }
    return { content: "memory saved" };
  });
  const harness = createHarness(provider);

  try {
    harness.bus.publishInbound({
      id: "in-2",
      channel: "cli",
      chatId: "local",
      senderId: "user",
      content: "save note",
      createdAt: new Date().toISOString()
    });

    await waitUntil(() => harness.outbound.length >= 1);
    assert.equal(harness.outbound[0]?.content, "memory saved");

    const memoryPath = path.join(harness.workspaceDir, "memory/cli_local.md");
    assert.equal(fs.readFileSync(memoryPath, "utf-8"), "persisted note");
  } finally {
    await harness.cleanup();
  }
});

test("E2E: scheduler emits synthetic inbound, router handles it, and task run is logged", async () => {
  const provider = new MockProvider(async () => ({ content: "scheduled ok" }));
  const harness = createHarness(provider);
  const scheduler = new Scheduler(
    harness.storage,
    harness.bus,
    harness.logger,
    harness.config,
    harness.telemetry
  );

  try {
    const chat = harness.storage.upsertChat({ channel: "cli", chatId: "local" });
    harness.storage.setChatRegistered(chat.id, true);
    const task = harness.storage.createTask({
      chatFk: chat.id,
      prompt: "run scheduled task",
      scheduleType: "interval",
      scheduleValue: "60000",
      contextMode: "group",
      nextRunAt: new Date(Date.now() - 1_000).toISOString()
    });

    scheduler.start();
    await waitUntil(() => harness.outbound.length >= 1);
    scheduler.stop();

    assert.equal(harness.outbound[0]?.content, "scheduled ok");
    const runs = harness.storage.listTaskRuns(task.id, 10);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, "success");
    assert.equal(runs[0]?.resultPreview, "scheduled ok");
  } finally {
    scheduler.stop();
    await harness.cleanup();
  }
});

test("E2E: isolated fs.write executes through runtime tool loop", async () => {
  const provider = new MockProvider(async (req) => {
    const hasToolResult = req.messages.some((message) => message.role === "tool");
    if (!hasToolResult) {
      return {
        toolCalls: [
          {
            id: "call-iso-fs",
            name: "fs.write",
            args: {
              path: "isolated/e2e.txt",
              content: "isolation works"
            }
          }
        ]
      };
    }
    return { content: "isolated write complete" };
  });

  const harness = createHarness(provider, {
    isolation: {
      enabled: true,
      toolNames: ["fs.write"],
      workerTimeoutMs: 30_000,
      maxWorkerOutputChars: 250_000,
      maxConcurrentWorkers: 2,
      openCircuitAfterFailures: 5,
      circuitResetMs: 30_000
    }
  });

  try {
    harness.bus.publishInbound({
      id: "in-iso-1",
      channel: "cli",
      chatId: "local",
      senderId: "user",
      content: "write file in isolation",
      createdAt: new Date().toISOString()
    });

    await waitUntil(() => harness.outbound.length >= 1);
    assert.equal(harness.outbound[0]?.content, "isolated write complete");

    const targetPath = path.join(harness.workspaceDir, "isolated/e2e.txt");
    assert.equal(fs.readFileSync(targetPath, "utf-8"), "isolation works");
  } finally {
    await harness.cleanup();
  }
});

test("E2E: inbound execution ledger prevents duplicate runtime on re-queued inbound", async () => {
  let providerCalls = 0;
  const provider = new MockProvider(async (req) => {
    providerCalls += 1;
    const last = req.messages[req.messages.length - 1];
    const content = "content" in last ? last.content : "";
    return { content: `echo:${content}` };
  });
  const harness = createHarness(provider, {
    bus: {
      pollMs: 10,
      batchSize: 20,
      maxAttempts: 3,
      retryBackoffMs: 10,
      maxRetryBackoffMs: 100,
      processingTimeoutMs: 200
    }
  });

  try {
    const seededChat = harness.storage.upsertChat({ channel: "cli", chatId: "local" });
    harness.storage.setChatRegistered(seededChat.id, true);

    const duplicatedInbound = {
      id: "in-dup-exec-1",
      channel: "cli",
      chatId: "local",
      senderId: "user",
      content: "hello duplicated queue",
      createdAt: new Date().toISOString()
    };

    harness.storage.enqueueBusMessage({
      direction: "inbound",
      payload: duplicatedInbound,
      maxAttempts: harness.config.bus.maxAttempts
    });
    harness.storage.enqueueBusMessage({
      direction: "inbound",
      payload: duplicatedInbound,
      maxAttempts: harness.config.bus.maxAttempts
    });

    await waitUntil(() => harness.storage.countBusMessagesByStatus("inbound").processed >= 2);
    await waitUntil(() => harness.outbound.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(providerCalls, 1);
    assert.equal(harness.outbound.length, 1);
    assert.equal(harness.outbound[0]?.content, "echo:hello duplicated queue");

    const chat = harness.storage.getChat("cli", "local");
    assert.ok(chat);
    const history = harness.storage.listRecentMessages(chat!.id, 20);
    assert.equal(
      history.filter((item) => item.role === "user" && item.content === "hello duplicated queue").length,
      1
    );
    assert.equal(
      history.filter((item) => item.role === "assistant" && item.content === "echo:hello duplicated queue")
        .length,
      1
    );
  } finally {
    await harness.cleanup();
  }
});
