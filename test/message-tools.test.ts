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
      /Admin already exists/
    );
  } finally {
    fixture.cleanup();
  }
});
