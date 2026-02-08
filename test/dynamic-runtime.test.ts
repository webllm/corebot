import test from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage, ToolCall } from "../src/types.js";
import { MessageBus } from "../src/bus/bus.js";
import { ConversationRouter } from "../src/bus/router.js";
import { ContextBuilder } from "../src/agent/context.js";
import { AgentRuntime, type LlmProvider } from "../src/agent/runtime.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { McpManager } from "../src/mcp/manager.js";
import { RuntimeTelemetry } from "../src/observability/telemetry.js";
import { IsolatedToolRuntime } from "../src/isolation/runtime.js";
import { createStorageFixture, createToolContext } from "./test-utils.js";

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

test("AgentRuntime refreshes tool definitions between tool iterations", async () => {
  const fixture = createStorageFixture();
  try {
    const seenToolSets: string[][] = [];
    const registry = new ToolRegistry();
    let reloadCalls = 0;

    registry.registerRaw(
      {
        name: "mcp.reload",
        description: "reload",
        parameters: { type: "object", properties: {} }
      },
      async () => {
        reloadCalls += 1;
        registry.registerRaw(
          {
            name: "mcp__demo__echo",
            description: "echo",
            parameters: { type: "object", properties: {} }
          },
          async () => "echo-ok"
        );
        return "reload-ok";
      }
    );

    let turn = 0;
    const provider = new MockProvider(async (req) => {
      seenToolSets.push((req.tools ?? []).map((tool) => tool.name).sort());
      if (turn === 0) {
        turn += 1;
        return {
          toolCalls: [{ id: "call-1", name: "mcp.reload", args: {} }]
        };
      }
      if (turn === 1) {
        turn += 1;
        return {
          toolCalls: [{ id: "call-2", name: "mcp__demo__echo", args: {} }]
        };
      }
      return { content: "done" };
    });

    const runtime = new AgentRuntime(provider, registry, fixture.config, createNoopLogger());
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    const { context } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: chat.id,
      chatRole: "admin"
    });

    const result = await runtime.run({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "run tools" }
      ],
      toolContext: context
    });

    assert.equal(result.content, "done");
    assert.equal(reloadCalls, 1);
    assert.equal(result.toolMessages.length, 2);
    assert.equal(result.toolMessages[0]?.content, "reload-ok");
    assert.equal(result.toolMessages[1]?.content, "echo-ok");
    assert.deepEqual(seenToolSets[0], ["mcp.reload"]);
    assert.deepEqual(seenToolSets[1], ["mcp.reload", "mcp__demo__echo"]);
  } finally {
    fixture.cleanup();
  }
});

test("ConversationRouter auto-syncs MCP tools before each inbound", async () => {
  const fixture = createStorageFixture({
    bus: {
      pollMs: 10,
      batchSize: 20,
      maxAttempts: 3,
      retryBackoffMs: 10,
      maxRetryBackoffMs: 100,
      processingTimeoutMs: 500,
      maxPendingInbound: 5_000,
      maxPendingOutbound: 5_000,
      overloadPendingThreshold: 2_000,
      overloadBackoffMs: 500,
      perChatRateLimitWindowMs: 60_000,
      perChatRateLimitMax: 120
    }
  });

  let mcpEnabled = false;
  let syncCalls = 0;
  const telemetry = new RuntimeTelemetry();
  const logger = createNoopLogger();
  const mcp = new McpManager({ logger });
  const isolatedRuntime = new IsolatedToolRuntime(fixture.config, logger);
  const registry = new ToolRegistry(undefined, telemetry);
  const provider = new MockProvider(async (req) => {
    const names = (req.tools ?? []).map((tool) => tool.name).sort();
    return { content: names.length > 0 ? names.join(",") : "(none)" };
  });
  const runtime = new AgentRuntime(provider, registry, fixture.config, logger);
  const contextBuilder = new ContextBuilder(fixture.storage, fixture.config, fixture.workspaceDir);
  const bus = new MessageBus(fixture.storage, fixture.config, logger);

  const mcpReloader = async () => {
    syncCalls += 1;
    registry.removeByPrefix("mcp__");
    if (mcpEnabled) {
      registry.registerRaw(
        {
          name: "mcp__demo__echo",
          description: "echo",
          parameters: { type: "object", properties: {} }
        },
        async () => "ok"
      );
    }
    return {
      reloaded: true,
      reason: "test",
      toolCount: mcpEnabled ? 1 : 0,
      configSignature: mcpEnabled ? "enabled" : "disabled"
    };
  };

  const router = new ConversationRouter(
    fixture.storage,
    contextBuilder,
    runtime,
    mcp,
    bus,
    logger,
    fixture.config,
    [],
    isolatedRuntime,
    mcpReloader
  );
  bus.onInbound(router.handleInbound);
  const outbound: string[] = [];
  bus.onOutbound(async (message) => {
    outbound.push(message.content);
  });

  try {
    bus.start();

    bus.publishInbound({
      id: "mcp-sync-1",
      channel: "cli",
      chatId: "local",
      senderId: "user",
      content: "first",
      createdAt: new Date().toISOString()
    });
    await waitUntil(() => outbound.length >= 1);
    assert.equal(outbound[0], "(none)");

    mcpEnabled = true;
    bus.publishInbound({
      id: "mcp-sync-2",
      channel: "cli",
      chatId: "local",
      senderId: "user",
      content: "second",
      createdAt: new Date().toISOString()
    });
    await waitUntil(() => outbound.length >= 2);
    assert.match(outbound[1] ?? "", /mcp__demo__echo/);
    assert.equal(syncCalls, 2);
  } finally {
    bus.stop();
    await isolatedRuntime.shutdown();
    await mcp.shutdown();
    fixture.cleanup();
  }
});

test("ConversationRouter continues when MCP auto-sync fails", async () => {
  const fixture = createStorageFixture({
    bus: {
      pollMs: 10,
      batchSize: 20,
      maxAttempts: 3,
      retryBackoffMs: 10,
      maxRetryBackoffMs: 100,
      processingTimeoutMs: 500,
      maxPendingInbound: 5_000,
      maxPendingOutbound: 5_000,
      overloadPendingThreshold: 2_000,
      overloadBackoffMs: 500,
      perChatRateLimitWindowMs: 60_000,
      perChatRateLimitMax: 120
    }
  });

  let syncCalls = 0;
  const logger = createNoopLogger();
  const mcp = new McpManager({ logger });
  const isolatedRuntime = new IsolatedToolRuntime(fixture.config, logger);
  const registry = new ToolRegistry();
  const provider = new MockProvider(async () => ({ content: "ok-after-sync-error" }));
  const runtime = new AgentRuntime(provider, registry, fixture.config, logger);
  const contextBuilder = new ContextBuilder(fixture.storage, fixture.config, fixture.workspaceDir);
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
    isolatedRuntime,
    async () => {
      syncCalls += 1;
      throw new Error("sync failed");
    }
  );
  bus.onInbound(router.handleInbound);
  const outbound: string[] = [];
  bus.onOutbound(async (message) => {
    outbound.push(message.content);
  });

  try {
    bus.start();
    bus.publishInbound({
      id: "mcp-sync-fail-1",
      channel: "cli",
      chatId: "local",
      senderId: "user",
      content: "hello",
      createdAt: new Date().toISOString()
    });
    await waitUntil(() => outbound.length >= 1);
    assert.equal(syncCalls, 1);
    assert.equal(outbound[0], "ok-after-sync-error");
  } finally {
    bus.stop();
    await isolatedRuntime.shutdown();
    await mcp.shutdown();
    fixture.cleanup();
  }
});
