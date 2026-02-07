import test from "node:test";
import assert from "node:assert/strict";
import { MessageBus } from "../src/bus/bus.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { DefaultToolPolicyEngine } from "../src/tools/policy.js";
import { busTools } from "../src/tools/builtins/bus.js";
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

test("bus.dead_letter.list returns dead-letter records", async () => {
  const fixture = createStorageFixture();
  const bus = new MessageBus(fixture.storage, fixture.config);
  try {
    const queued = fixture.storage.enqueueBusMessage({
      direction: "inbound",
      payload: {
        id: "in-1",
        channel: "cli",
        chatId: "local",
        senderId: "user",
        content: "test",
        createdAt: new Date().toISOString()
      },
      maxAttempts: 3
    });
    fixture.storage.markBusMessageDeadLetter({
      id: queued.queueId,
      attempts: 3,
      error: "manual dead-letter",
      deadLetteredAt: new Date().toISOString()
    });

    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    fixture.storage.setChatRole(chat.id, "admin");
    const registry = new ToolRegistry(new DefaultToolPolicyEngine());
    for (const tool of busTools()) {
      registry.register(tool);
    }
    const { context } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: chat.id,
      chatRole: "admin"
    });
    context.bus = bus as any;

    const result = await registry.execute(
      "bus.dead_letter.list",
      { direction: "inbound" },
      context
    );
    const parsed = JSON.parse(result) as Array<{ id: string; lastError: string | null }>;
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.id, queued.queueId);
    assert.match(parsed[0]?.lastError ?? "", /manual dead-letter/);
  } finally {
    bus.stop();
    fixture.cleanup();
  }
});

test("bus.dead_letter.replay requeues dead-lettered inbound and processes it", async () => {
  const fixture = createStorageFixture({
    bus: {
      pollMs: 20,
      batchSize: 10,
      maxAttempts: 3,
      retryBackoffMs: 10,
      maxRetryBackoffMs: 100,
      processingTimeoutMs: 500
    }
  });
  const bus = new MessageBus(fixture.storage, fixture.config);
  try {
    const queued = fixture.storage.enqueueBusMessage({
      direction: "inbound",
      payload: {
        id: "in-2",
        channel: "cli",
        chatId: "local",
        senderId: "user",
        content: "replay me",
        createdAt: new Date().toISOString()
      },
      maxAttempts: 3
    });
    fixture.storage.markBusMessageDeadLetter({
      id: queued.queueId,
      attempts: 3,
      error: "always fails",
      deadLetteredAt: new Date().toISOString()
    });

    let handled = 0;
    bus.onInbound(async () => {
      handled += 1;
    });
    bus.start();

    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    fixture.storage.setChatRole(chat.id, "admin");
    const registry = new ToolRegistry(new DefaultToolPolicyEngine());
    for (const tool of busTools()) {
      registry.register(tool);
    }
    const { context } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: chat.id,
      chatRole: "admin"
    });
    context.bus = bus as any;

    const result = await registry.execute(
      "bus.dead_letter.replay",
      { queueId: queued.queueId },
      context
    );
    const parsed = JSON.parse(result) as { replayed: number; ids: string[] };
    assert.equal(parsed.replayed, 1);
    assert.deepEqual(parsed.ids, [queued.queueId]);

    await waitUntil(() => handled >= 1);

    const counts = fixture.storage.countBusMessagesByStatus("inbound");
    assert.equal(counts.dead_letter, 0);
    assert.equal(counts.processed, 1);

    const replayAgain = await registry.execute(
      "bus.dead_letter.replay",
      { queueId: queued.queueId },
      context
    );
    const parsedAgain = JSON.parse(replayAgain) as { replayed: number; ids: string[] };
    assert.equal(parsedAgain.replayed, 0);
    assert.deepEqual(parsedAgain.ids, []);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(handled, 1);
  } finally {
    bus.stop();
    fixture.cleanup();
  }
});
