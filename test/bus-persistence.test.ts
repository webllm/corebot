import test from "node:test";
import assert from "node:assert/strict";
import { MessageBus } from "../src/bus/bus.js";
import { createStorageFixture } from "./test-utils.js";

const waitUntil = async (
  predicate: () => boolean,
  timeoutMs = 2_500,
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

test("MessageBus retries failed inbound messages and eventually processes them", async () => {
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
    let calls = 0;
    bus.onInbound(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("fail once");
      }
    });

    bus.publishInbound({
      id: "msg-1",
      channel: "cli",
      chatId: "local",
      senderId: "user",
      content: "hello",
      createdAt: new Date().toISOString()
    });

    bus.start();
    await waitUntil(() => calls >= 2);

    const counts = fixture.storage.countBusMessagesByStatus("inbound");
    assert.equal(counts.processed, 1);
    assert.equal(counts.dead_letter, 0);
  } finally {
    bus.stop();
    fixture.cleanup();
  }
});

test("MessageBus moves repeatedly failing messages to dead-letter", async () => {
  const fixture = createStorageFixture({
    bus: {
      pollMs: 20,
      batchSize: 10,
      maxAttempts: 2,
      retryBackoffMs: 10,
      maxRetryBackoffMs: 100,
      processingTimeoutMs: 500
    }
  });

  const bus = new MessageBus(fixture.storage, fixture.config);
  try {
    bus.onInbound(async () => {
      throw new Error("always fails");
    });

    bus.publishInbound({
      id: "msg-2",
      channel: "cli",
      chatId: "local",
      senderId: "user",
      content: "dead",
      createdAt: new Date().toISOString()
    });

    bus.start();
    await waitUntil(() => fixture.storage.countBusMessagesByStatus("inbound").dead_letter >= 1);

    const dead = fixture.storage.listDeadLetterBusMessages("inbound", 10);
    assert.equal(dead.length, 1);
    assert.match(dead[0]?.lastError ?? "", /always fails/);
  } finally {
    bus.stop();
    fixture.cleanup();
  }
});

test("MessageBus recovers stale processing messages on startup", async () => {
  const fixture = createStorageFixture({
    bus: {
      pollMs: 20,
      batchSize: 10,
      maxAttempts: 3,
      retryBackoffMs: 10,
      maxRetryBackoffMs: 100,
      processingTimeoutMs: 20
    }
  });

  const bus = new MessageBus(fixture.storage, fixture.config);
  try {
    const queueId = fixture.storage.enqueueBusMessage({
      direction: "inbound",
      payload: {
        id: "msg-3",
        channel: "cli",
        chatId: "local",
        senderId: "user",
        content: "recover",
        createdAt: new Date().toISOString()
      },
      maxAttempts: 3
    });
    fixture.storage.claimBusMessage(
      queueId,
      new Date(Date.now() - 2_000).toISOString()
    );

    let calls = 0;
    bus.onInbound(async () => {
      calls += 1;
    });

    bus.start();
    await waitUntil(() => calls >= 1);
    assert.equal(fixture.storage.countBusMessagesByStatus("inbound").processed, 1);
  } finally {
    bus.stop();
    fixture.cleanup();
  }
});
