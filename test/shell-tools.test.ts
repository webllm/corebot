import test from "node:test";
import assert from "node:assert/strict";
import { shellTools } from "../src/tools/builtins/shell.js";
import { createStorageFixture, createToolContext } from "./test-utils.js";

const getShellTool = () => {
  const tool = shellTools().find((item) => item.name === "shell.exec");
  if (!tool) {
    throw new Error("shell.exec tool missing");
  }
  return tool;
};

test("shell.exec enforces executable allowlist and avoids shell injection", async () => {
  const fixture = createStorageFixture({
    allowShell: true,
    allowedShellCommands: ["echo"]
  });
  try {
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    const { context } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: chat.id
    });
    const tool = getShellTool();

    const plain = await tool.run({ command: "echo hello" }, context);
    assert.equal(plain, "hello");

    const injected = await tool.run({ command: "echo hello && echo world" }, context);
    assert.match(injected, /&&/);

    await assert.rejects(
      tool.run({ command: "node -e \"console.log('x')\"" }, context),
      /Executable not in allowlist/
    );
  } finally {
    fixture.cleanup();
  }
});
