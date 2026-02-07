import test from "node:test";
import assert from "node:assert/strict";
import { shellTools } from "../src/tools/builtins/shell.js";
import { IsolatedToolRuntime } from "../src/isolation/runtime.js";
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
    allowedShellCommands: ["echo"],
    isolation: {
      enabled: false,
      toolNames: ["shell.exec"],
      workerTimeoutMs: 30_000,
      maxWorkerOutputChars: 250_000
    }
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

test("shell.exec isolated runtime only exposes allowlisted env keys", async () => {
  const previousAllowed = process.env.COREBOT_TEST_ALLOWED_ENV;
  const previousBlocked = process.env.COREBOT_TEST_BLOCKED_ENV;
  process.env.COREBOT_TEST_ALLOWED_ENV = "allowed";
  process.env.COREBOT_TEST_BLOCKED_ENV = "blocked";

  const fixture = createStorageFixture({
    allowShell: true,
    allowedShellCommands: ["node"],
    allowedEnv: ["COREBOT_TEST_ALLOWED_ENV"],
    isolation: {
      enabled: true,
      toolNames: ["shell.exec"],
      workerTimeoutMs: 30_000,
      maxWorkerOutputChars: 250_000
    }
  });

  const logger = {
    fatal: () => undefined,
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => logger
  } as any;
  const isolatedRuntime = new IsolatedToolRuntime(fixture.config, logger);

  try {
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    const { context } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: chat.id,
      isolatedRuntime
    });
    const tool = getShellTool();

    const output = await tool.run(
      {
        command:
          "node -e \"process.stdout.write((process.env.COREBOT_TEST_ALLOWED_ENV||'none') + ':' + (process.env.COREBOT_TEST_BLOCKED_ENV||'none'))\""
      },
      context
    );
    assert.equal(output, "allowed:none");
  } finally {
    if (previousAllowed === undefined) {
      delete process.env.COREBOT_TEST_ALLOWED_ENV;
    } else {
      process.env.COREBOT_TEST_ALLOWED_ENV = previousAllowed;
    }
    if (previousBlocked === undefined) {
      delete process.env.COREBOT_TEST_BLOCKED_ENV;
    } else {
      process.env.COREBOT_TEST_BLOCKED_ENV = previousBlocked;
    }
    await isolatedRuntime.shutdown();
    fixture.cleanup();
  }
});

test("shell.exec isolated runtime still blocks when shell is disabled", async () => {
  const fixture = createStorageFixture({
    allowShell: false,
    allowedShellCommands: ["echo"],
    isolation: {
      enabled: true,
      toolNames: ["shell.exec"],
      workerTimeoutMs: 30_000,
      maxWorkerOutputChars: 250_000
    }
  });

  const logger = {
    fatal: () => undefined,
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => logger
  } as any;
  const isolatedRuntime = new IsolatedToolRuntime(fixture.config, logger);

  try {
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    const { context } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: chat.id,
      isolatedRuntime
    });
    const tool = getShellTool();

    await assert.rejects(tool.run({ command: "echo hello" }, context), /Shell execution is disabled/);
  } finally {
    await isolatedRuntime.shutdown();
    fixture.cleanup();
  }
});
