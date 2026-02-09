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
import { heartbeatTools } from "../src/tools/builtins/heartbeat.js";
import { McpManager } from "../src/mcp/manager.js";
import { IsolatedToolRuntime } from "../src/isolation/runtime.js";
import { RuntimeTelemetry } from "../src/observability/telemetry.js";
import { HeartbeatService } from "../src/heartbeat/service.js";
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

const listPendingInbound = (storage: ReturnType<typeof createStorageFixture>["storage"]) =>
  storage.listDueBusMessages("inbound", new Date(Date.now() + 60_000).toISOString(), 100);

test("HeartbeatService skips without prompt and dispatches force run when prompt exists", async () => {
  const fixture = createStorageFixture({
    heartbeat: {
      enabled: true,
      intervalMs: 1_000,
      wakeDebounceMs: 50,
      wakeRetryMs: 100,
      promptPath: "HEARTBEAT.md",
      maxDispatchPerRun: 10
    }
  });
  const logger = createNoopLogger();
  const telemetry = new RuntimeTelemetry();
  const bus = new MessageBus(fixture.storage, fixture.config, logger);
  const heartbeat = new HeartbeatService(fixture.storage, bus, fixture.config, logger, telemetry);

  try {
    fixture.storage.upsertChat({ channel: "cli", chatId: "alpha" });
    fixture.storage.upsertChat({ channel: "cli", chatId: "beta" });

    heartbeat.start();
    await waitUntil(() =>
      fixture.storage
        .listAuditEvents(10, "heartbeat.run")
        .some((entry) => entry.reason === "prompt_missing_or_empty")
    );
    assert.equal(listPendingInbound(fixture.storage).length, 0);

    fs.writeFileSync(path.join(fixture.workspaceDir, "HEARTBEAT.md"), "hb prompt");
    heartbeat.requestNow({ reason: "test:force", force: true });
    await waitUntil(() => listPendingInbound(fixture.storage).length >= 2);

    const payloads = listPendingInbound(fixture.storage).map((row) => {
      return JSON.parse(row.payload) as {
        content: string;
        metadata?: Record<string, unknown>;
      };
    });
    assert.equal(payloads.length, 2);
    for (const payload of payloads) {
      assert.equal(payload.content, "hb prompt");
      assert.equal(payload.metadata?.isHeartbeat, true);
    }
  } finally {
    heartbeat.stop();
    fixture.cleanup();
  }
});

test("HeartbeatService runtime enable switch gates dispatch", async () => {
  const fixture = createStorageFixture({
    heartbeat: {
      enabled: false,
      intervalMs: 1_000,
      wakeDebounceMs: 50,
      promptPath: "HEARTBEAT.md"
    }
  });
  const logger = createNoopLogger();
  const bus = new MessageBus(fixture.storage, fixture.config, logger);
  const heartbeat = new HeartbeatService(fixture.storage, bus, fixture.config, logger);

  try {
    fixture.storage.upsertChat({ channel: "cli", chatId: "alpha" });
    fs.writeFileSync(path.join(fixture.workspaceDir, "HEARTBEAT.md"), "hb prompt");

    heartbeat.start();
    heartbeat.requestNow({ reason: "disabled-force", force: true });
    await waitUntil(() =>
      fixture.storage
        .listAuditEvents(20, "heartbeat.run")
        .some((entry) => entry.reason === "disabled")
    );
    assert.equal(listPendingInbound(fixture.storage).length, 0);

    heartbeat.setEnabled(true, "test-enable");
    await waitUntil(() => listPendingInbound(fixture.storage).length >= 1);
  } finally {
    heartbeat.stop();
    fixture.cleanup();
  }
});

const createRouterHarness = (
  responder: (req: {
    model: string;
    messages: ChatMessage[];
    tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    temperature?: number;
  }) => Promise<{ content?: string; toolCalls?: ToolCall[] }>
) => {
  const fixture = createStorageFixture({
    bus: {
      pollMs: 10,
      batchSize: 20,
      maxAttempts: 3,
      retryBackoffMs: 10,
      maxRetryBackoffMs: 100,
      processingTimeoutMs: 500
    }
  });
  const logger = createNoopLogger();
  const provider = new MockProvider(responder);
  const registry = new ToolRegistry();
  const runtime = new AgentRuntime(provider, registry, fixture.config, logger);
  const contextBuilder = new ContextBuilder(fixture.storage, fixture.config, fixture.workspaceDir);
  const bus = new MessageBus(fixture.storage, fixture.config, logger);
  const mcp = new McpManager({ logger });
  const isolatedRuntime = new IsolatedToolRuntime(fixture.config, logger);
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
  const outbound: Array<{ content: string }> = [];
  bus.onOutbound(async (message) => {
    outbound.push({ content: message.content });
  });
  bus.start();

  const cleanup = async () => {
    bus.stop();
    await isolatedRuntime.shutdown();
    await mcp.shutdown();
    fixture.cleanup();
  };

  return { fixture, bus, outbound, cleanup };
};

test("ConversationRouter suppresses heartbeat ack token output", async () => {
  const harness = createRouterHarness(async () => ({ content: "HEARTBEAT_OK" }));
  try {
    harness.bus.publishInbound({
      id: "hb-ack-1",
      channel: "cli",
      chatId: "local",
      senderId: "heartbeat",
      content: "heartbeat ping",
      createdAt: new Date().toISOString(),
      metadata: { isHeartbeat: true, heartbeatReason: "test" }
    });
    await waitUntil(() =>
      harness.fixture.storage.listAuditEvents(10, "heartbeat.delivery").length >= 1
    );
    assert.equal(harness.outbound.length, 0);
    const latest = harness.fixture.storage.listAuditEvents(1, "heartbeat.delivery")[0];
    assert.equal(latest?.outcome, "skipped");
    assert.equal(latest?.reason, "ok_token");
  } finally {
    await harness.cleanup();
  }
});

test("ConversationRouter deduplicates heartbeat delivery by recent content", async () => {
  const harness = createRouterHarness(async () => ({ content: "service degraded: disk high" }));
  try {
    harness.bus.publishInbound({
      id: "hb-dup-1",
      channel: "cli",
      chatId: "local",
      senderId: "heartbeat",
      content: "heartbeat ping",
      createdAt: new Date().toISOString(),
      metadata: { isHeartbeat: true, heartbeatReason: "test" }
    });
    await waitUntil(() => harness.outbound.length === 1);

    harness.bus.publishInbound({
      id: "hb-dup-2",
      channel: "cli",
      chatId: "local",
      senderId: "heartbeat",
      content: "heartbeat ping",
      createdAt: new Date().toISOString(),
      metadata: { isHeartbeat: true, heartbeatReason: "test" }
    });
    await waitUntil(() =>
      harness.fixture.storage.listAuditEvents(10, "heartbeat.delivery").length >= 2
    );

    assert.equal(harness.outbound.length, 1);
    const entries = harness.fixture.storage.listAuditEvents(10, "heartbeat.delivery");
    assert.ok(entries.some((entry) => entry.outcome === "sent"));
    assert.ok(entries.some((entry) => entry.outcome === "skipped" && entry.reason === "duplicate"));
  } finally {
    await harness.cleanup();
  }
});

test("heartbeat tools are admin-only and can control runtime state", async () => {
  const fixture = createStorageFixture();
  const heartbeatStatus = {
    running: true,
    enabled: true,
    config: {
      enabled: true,
      intervalMs: 1_000,
      wakeDebounceMs: 100,
      wakeRetryMs: 100,
      promptPath: "HEARTBEAT.md",
      activeHours: "",
      skipWhenInboundBusy: true,
      ackToken: "HEARTBEAT_OK",
      suppressAck: true,
      dedupeWindowMs: 60_000,
      maxDispatchPerRun: 20
    },
    nextDueCount: 0,
    nextDuePreview: []
  };
  const calls: Array<{ kind: "enable" | "trigger"; payload: unknown }> = [];
  const heartbeatController = {
    requestNow: (params?: unknown) => {
      calls.push({ kind: "trigger", payload: params ?? null });
    },
    setEnabled: (enabled: boolean, reason?: string) => {
      calls.push({ kind: "enable", payload: { enabled, reason: reason ?? null } });
    },
    getStatus: () => heartbeatStatus
  };

  try {
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    fixture.storage.setChatRole(chat.id, "admin");
    const registry = new ToolRegistry(new DefaultToolPolicyEngine());
    for (const tool of heartbeatTools()) {
      registry.register(tool);
    }
    const { context } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: chat.id,
      chatRole: "admin",
      heartbeat: heartbeatController
    });

    const statusRaw = await registry.execute("heartbeat.status", {}, context);
    const parsedStatus = JSON.parse(statusRaw) as typeof heartbeatStatus;
    assert.equal(parsedStatus.enabled, true);

    await registry.execute(
      "heartbeat.trigger",
      {
        reason: "manual-test",
        force: true,
        channel: "cli",
        chatId: "local"
      },
      context
    );
    await registry.execute(
      "heartbeat.enable",
      {
        enabled: false,
        reason: "manual-disable"
      },
      context
    );

    assert.deepEqual(calls[0], {
      kind: "trigger",
      payload: {
        reason: "manual-test",
        force: true,
        channel: "cli",
        chatId: "local"
      }
    });
    assert.deepEqual(calls[1], {
      kind: "enable",
      payload: {
        enabled: false,
        reason: "manual-disable"
      }
    });

    const { context: normalContext } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: chat.id,
      chatRole: "normal",
      heartbeat: heartbeatController
    });
    await assert.rejects(
      registry.execute("heartbeat.status", {}, normalContext),
      /Policy denied heartbeat\.status/
    );
  } finally {
    fixture.cleanup();
  }
});
