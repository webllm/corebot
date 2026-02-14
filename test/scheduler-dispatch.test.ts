import test from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { computeNextRun } from "../src/scheduler/utils.js";
import { MessageBus } from "../src/bus/bus.js";
import { createStorageFixture } from "./test-utils.js";

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

test("Scheduler tick atomically updates task state and enqueues inbound message", async () => {
  const fixture = createStorageFixture();
  try {
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    const task = fixture.storage.createTask({
      chatFk: chat.id,
      prompt: "run once",
      scheduleType: "once",
      scheduleValue: new Date(Date.now() - 1_000).toISOString(),
      contextMode: "group",
      nextRunAt: new Date(Date.now() - 1_000).toISOString()
    });

    const bus = new MessageBus(fixture.storage, fixture.config, createNoopLogger());
    const scheduler = new Scheduler(
      fixture.storage,
      bus,
      createNoopLogger(),
      fixture.config
    );

    await (scheduler as any).tick();

    const updated = fixture.storage.getTask(task.id);
    assert.equal(updated?.status, "done");
    assert.equal(updated?.nextRunAt, null);

    const counts = fixture.storage.countBusMessagesByStatus("inbound");
    assert.equal(counts.pending, 1);

    const dueQueued = fixture.storage.listDueBusMessages(
      "inbound",
      new Date(Date.now() + 60_000).toISOString(),
      10
    );
    assert.equal(dueQueued.length, 1);
    const payload = JSON.parse(dueQueued[0]?.payload ?? "{}") as {
      senderId?: string;
      metadata?: Record<string, unknown>;
    };
    assert.equal(payload.senderId, "scheduler");
    assert.equal(payload.metadata?.taskId, task.id);
    assert.equal(payload.metadata?.isScheduledTask, true);
  } finally {
    fixture.cleanup();
  }
});

test("dispatchScheduledTasks prevents duplicate enqueue for the same due run", () => {
  const fixture = createStorageFixture();
  try {
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    const task = fixture.storage.createTask({
      chatFk: chat.id,
      prompt: "repeat",
      scheduleType: "interval",
      scheduleValue: "60000",
      contextMode: "group",
      nextRunAt: new Date(Date.now() - 500).toISOString()
    });

    const dueBefore = new Date().toISOString();
    const due = fixture.storage.dueTasks(dueBefore);
    assert.equal(due.length, 1);

    const plans = due.map((entry) => {
      const nextRunAt = computeNextRun(entry, new Date(dueBefore));
      return {
        taskId: entry.id,
        nextRunAt,
        status: entry.status,
        inbound: {
          id: `scheduled-${entry.id}`,
          channel: chat.channel,
          chatId: chat.chatId,
          senderId: "scheduler",
          content: entry.prompt,
          createdAt: dueBefore,
          metadata: {
            isScheduledTask: true,
            taskId: entry.id,
            contextMode: entry.contextMode,
            chatFk: entry.chatFk
          }
        }
      };
    });

    const first = fixture.storage.dispatchScheduledTasks({
      dueBefore,
      maxAttempts: fixture.config.bus.maxAttempts,
      items: plans
    });
    const second = fixture.storage.dispatchScheduledTasks({
      dueBefore,
      maxAttempts: fixture.config.bus.maxAttempts,
      items: plans
    });

    assert.equal(first.dispatched, 1);
    assert.equal(second.dispatched, 0);

    const counts = fixture.storage.countBusMessagesByStatus("inbound");
    assert.equal(counts.pending, 1);

    const updated = fixture.storage.getTask(task.id);
    assert.ok(updated?.nextRunAt);
    assert.notEqual(updated?.nextRunAt, task.nextRunAt);
  } finally {
    fixture.cleanup();
  }
});
