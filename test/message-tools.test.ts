import test from "node:test";
import assert from "node:assert/strict";
import { messageTools } from "../src/tools/builtins/message.js";
import { createStorageFixture, createToolContext } from "./test-utils.js";

const getRegisterTool = () => {
  const tool = messageTools().find((item) => item.name === "chat.register");
  if (!tool) {
    throw new Error("chat.register tool missing");
  }
  return tool;
};

test("chat.register blocks admin escalation without valid bootstrap", async () => {
  const fixture = createStorageFixture({ adminBootstrapKey: "secret" });
  try {
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    const tool = getRegisterTool();
    const { context } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: chat.id,
      chatRole: "normal",
      chatId: "local",
      channel: "cli"
    });

    await assert.rejects(
      tool.run({ role: "admin", bootstrapKey: "wrong" }, context),
      /Invalid admin bootstrap key/
    );

    await tool.run({ role: "admin", bootstrapKey: "secret" }, context);
    assert.equal(fixture.storage.countAdminChats(), 1);
    fixture.storage.setChatRole(chat.id, "normal");
    assert.equal(fixture.storage.countAdminChats(), 0);

    const other = fixture.storage.upsertChat({ channel: "cli", chatId: "other" });
    const { context: otherContext } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: other.id,
      chatRole: "normal",
      chatId: "other",
      channel: "cli"
    });

    await assert.rejects(
      tool.run({ role: "admin", bootstrapKey: "secret" }, otherContext),
      /already been used/
    );
  } finally {
    fixture.cleanup();
  }
});

test("chat.register can reuse bootstrap key when single-use is disabled", async () => {
  const fixture = createStorageFixture({
    adminBootstrapKey: "secret",
    adminBootstrapSingleUse: false
  });
  try {
    const first = fixture.storage.upsertChat({ channel: "cli", chatId: "first" });
    const second = fixture.storage.upsertChat({ channel: "cli", chatId: "second" });
    const tool = getRegisterTool();

    const firstContext = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: first.id,
      chatRole: "normal",
      chatId: "first",
      channel: "cli"
    }).context;
    await tool.run({ role: "admin", bootstrapKey: "secret" }, firstContext);
    fixture.storage.setChatRole(first.id, "normal");

    const secondContext = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: second.id,
      chatRole: "normal",
      chatId: "second",
      channel: "cli"
    }).context;
    await tool.run({ role: "admin", bootstrapKey: "secret" }, secondContext);
    assert.equal(fixture.storage.countAdminChats(), 1);
  } finally {
    fixture.cleanup();
  }
});
