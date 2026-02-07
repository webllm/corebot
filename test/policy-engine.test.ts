import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tools/registry.js";
import { DefaultToolPolicyEngine } from "../src/tools/policy.js";
import { fsTools } from "../src/tools/builtins/fs.js";
import { shellTools } from "../src/tools/builtins/shell.js";
import { messageTools } from "../src/tools/builtins/message.js";
import { taskTools } from "../src/tools/builtins/tasks.js";
import { webTools } from "../src/tools/builtins/web.js";
import { createStorageFixture, createToolContext } from "./test-utils.js";

test("policy engine denies shell.exec for normal role", async () => {
  const fixture = createStorageFixture({
    allowShell: true,
    allowedShellCommands: ["echo"]
  });
  try {
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    const registry = new ToolRegistry(new DefaultToolPolicyEngine());
    for (const tool of shellTools()) {
      registry.register(tool);
    }
    const { context } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: chat.id,
      chatRole: "normal"
    });

    await assert.rejects(
      registry.execute("shell.exec", { command: "echo hello" }, context),
      /Policy denied shell.exec/
    );
  } finally {
    fixture.cleanup();
  }
});

test("policy engine allows shell.exec for admin", async () => {
  const fixture = createStorageFixture({
    allowShell: true,
    allowedShellCommands: ["echo"]
  });
  try {
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    fixture.storage.setChatRole(chat.id, "admin");
    const registry = new ToolRegistry(new DefaultToolPolicyEngine());
    for (const tool of shellTools()) {
      registry.register(tool);
    }
    const { context } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: chat.id,
      chatRole: "admin"
    });

    const output = await registry.execute(
      "shell.exec",
      { command: "echo hello" },
      context
    );
    assert.equal(output, "hello");
  } finally {
    fixture.cleanup();
  }
});

test("policy engine blocks non-admin fs.write on protected workspace paths", async () => {
  const fixture = createStorageFixture();
  try {
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    const registry = new ToolRegistry(new DefaultToolPolicyEngine());
    for (const tool of fsTools()) {
      registry.register(tool);
    }
    const { context } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: chat.id,
      chatRole: "normal"
    });

    await assert.rejects(
      registry.execute("fs.write", { path: "skills/new-skill/SKILL.md", content: "body" }, context),
      /Policy denied fs.write/
    );
  } finally {
    fixture.cleanup();
  }
});

test("policy engine allows admin fs.write on protected workspace paths", async () => {
  const fixture = createStorageFixture();
  try {
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    fixture.storage.setChatRole(chat.id, "admin");
    const registry = new ToolRegistry(new DefaultToolPolicyEngine());
    for (const tool of fsTools()) {
      registry.register(tool);
    }
    const { context } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: chat.id,
      chatRole: "admin"
    });

    const result = await registry.execute(
      "fs.write",
      { path: "skills/new-skill/SKILL.md", content: "# Skill\nBody" },
      context
    );
    assert.equal(result, "ok");
  } finally {
    fixture.cleanup();
  }
});

test("policy engine blocks normal user cross-chat message.send", async () => {
  const fixture = createStorageFixture();
  try {
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    const registry = new ToolRegistry(new DefaultToolPolicyEngine());
    for (const tool of messageTools()) {
      registry.register(tool);
    }
    const { context } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: chat.id,
      chatRole: "normal"
    });

    await assert.rejects(
      registry.execute(
        "message.send",
        { channel: "cli", chatId: "other", content: "x" },
        context
      ),
      /Policy denied message.send/
    );
  } finally {
    fixture.cleanup();
  }
});

test("policy engine allows bootstrap self-registration path", async () => {
  const fixture = createStorageFixture({
    adminBootstrapKey: "secret"
  });
  try {
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    const registry = new ToolRegistry(new DefaultToolPolicyEngine());
    for (const tool of messageTools()) {
      registry.register(tool);
    }
    const { context } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: chat.id,
      chatRole: "normal",
      chatId: "local"
    });

    const result = await registry.execute(
      "chat.register",
      { role: "admin", bootstrapKey: "secret" },
      context
    );
    assert.equal(result, "ok");
    assert.equal(fixture.storage.countAdminChats(), 1);
  } finally {
    fixture.cleanup();
  }
});

test("policy engine blocks normal user tasks.update on foreign task", async () => {
  const fixture = createStorageFixture();
  try {
    const own = fixture.storage.upsertChat({ channel: "cli", chatId: "own" });
    const other = fixture.storage.upsertChat({ channel: "cli", chatId: "other" });
    const task = fixture.storage.createTask({
      chatFk: other.id,
      prompt: "task",
      scheduleType: "interval",
      scheduleValue: "60000",
      contextMode: "group",
      nextRunAt: new Date(Date.now() + 60_000).toISOString()
    });

    const registry = new ToolRegistry(new DefaultToolPolicyEngine());
    for (const tool of taskTools()) {
      registry.register(tool);
    }
    const { context } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: own.id,
      chatId: "own",
      chatRole: "normal"
    });

    await assert.rejects(
      registry.execute("tasks.update", { taskId: task.id, status: "paused" }, context),
      /Policy denied tasks.update/
    );
  } finally {
    fixture.cleanup();
  }
});

test("policy engine enforces web.fetch host policy before execution", async () => {
  const fixture = createStorageFixture({
    allowedWebDomains: ["allowed.example.com"]
  });
  try {
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    const registry = new ToolRegistry(new DefaultToolPolicyEngine());
    for (const tool of webTools()) {
      registry.register(tool);
    }
    const { context } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: chat.id
    });

    await assert.rejects(
      registry.execute("web.fetch", { url: "https://example.com" }, context),
      /Policy denied web.fetch/
    );
  } finally {
    fixture.cleanup();
  }
});

test("policy engine blocks MCP tools for normal role", async () => {
  const fixture = createStorageFixture();
  try {
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    const registry = new ToolRegistry(new DefaultToolPolicyEngine());
    registry.registerRaw(
      {
        name: "mcp__demo__echo",
        description: "echo",
        parameters: { type: "object", properties: {} }
      },
      async () => "ok"
    );

    const { context } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: chat.id,
      chatRole: "normal"
    });

    await assert.rejects(
      registry.execute("mcp__demo__echo", {}, context),
      /Policy denied mcp__demo__echo/
    );
  } finally {
    fixture.cleanup();
  }
});
