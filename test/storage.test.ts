import test from "node:test";
import assert from "node:assert/strict";
import { createStorageFixture } from "./test-utils.js";

test("listTasks supports global listing without chat filter", () => {
  const fixture = createStorageFixture();
  try {
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    fixture.storage.createTask({
      chatFk: chat.id,
      prompt: "Ping me",
      scheduleType: "interval",
      scheduleValue: "60000",
      contextMode: "group",
      nextRunAt: new Date(Date.now() + 60_000).toISOString()
    });

    const allTasks = fixture.storage.listTasks();
    assert.equal(allTasks.length, 1);
    assert.equal(allTasks[0]?.chatFk, chat.id);
  } finally {
    fixture.cleanup();
  }
});

test("countAdminChats reflects admin role assignments", () => {
  const fixture = createStorageFixture();
  try {
    const first = fixture.storage.upsertChat({ channel: "cli", chatId: "a" });
    const second = fixture.storage.upsertChat({ channel: "cli", chatId: "b" });
    fixture.storage.setChatRole(first.id, "admin");
    fixture.storage.setChatRole(second.id, "normal");

    assert.equal(fixture.storage.countAdminChats(), 1);
  } finally {
    fixture.cleanup();
  }
});
