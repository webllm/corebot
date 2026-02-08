import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { McpManager } from "../src/mcp/manager.js";
import { DefaultToolPolicyEngine } from "../src/tools/policy.js";
import { createStorageFixture, createToolContext } from "./test-utils.js";

test("McpManager enforces server and tool allowlists", async () => {
  const manager = new McpManager({
    allowedServers: ["good"],
    allowedTools: ["good.echo"],
    factory: {
      async createClient() {
        return {
          client: {
            async listTools() {
              return [
                { name: "echo", description: "echo", inputSchema: { type: "object" } },
                { name: "secret", description: "secret", inputSchema: { type: "object" } }
              ];
            },
            async callTool() {
              return { ok: true };
            },
            async connect() {
              return;
            },
            async close() {
              return;
            }
          }
        };
      }
    },
    logger: {
      info: () => undefined,
      warn: () => undefined
    } as any
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corebot-mcp-allow-"));
  try {
    const configPath = path.join(root, "mcp.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          good: { command: "noop" },
          bad: { command: "noop" }
        }
      }),
      "utf-8"
    );

    const defs = await manager.loadFromConfig(configPath);
    assert.equal(defs.length, 1);
    assert.equal(defs[0]?.name, "mcp__good__echo");
    await assert.rejects(manager.callTool("mcp__good__secret", {}), /Unknown MCP tool/);
    await assert.rejects(manager.callTool("mcp__bad__echo", {}), /Unknown MCP tool/);
  } finally {
    await manager.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("McpManager reloadFromConfig replaces previously loaded tools", async () => {
  const manager = new McpManager({
    factory: {
      async createClient(server) {
        return {
          client: {
            async listTools() {
              return [
                { name: "echo", description: `${server.name}-echo`, inputSchema: { type: "object" } }
              ];
            },
            async callTool() {
              return { server: server.name };
            },
            async connect() {
              return;
            },
            async close() {
              return;
            }
          }
        };
      }
    },
    logger: {
      info: () => undefined,
      warn: () => undefined
    } as any
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corebot-mcp-reload-"));
  try {
    const configPath = path.join(root, "mcp.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          alpha: { command: "noop" }
        }
      }),
      "utf-8"
    );

    let defs = await manager.reloadFromConfig(configPath);
    assert.equal(defs.length, 1);
    assert.equal(defs[0]?.name, "mcp__alpha__echo");
    assert.deepEqual(await manager.callTool("mcp__alpha__echo", {}), { server: "alpha" });

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          beta: { command: "noop" }
        }
      }),
      "utf-8"
    );

    defs = await manager.reloadFromConfig(configPath);
    assert.equal(defs.length, 1);
    assert.equal(defs[0]?.name, "mcp__beta__echo");
    await assert.rejects(manager.callTool("mcp__alpha__echo", {}), /Unknown MCP tool/);
    assert.deepEqual(await manager.callTool("mcp__beta__echo", {}), { server: "beta" });
  } finally {
    await manager.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Policy engine enforces MCP allowlists for admin calls", async () => {
  const fixture = createStorageFixture({
    allowedMcpServers: ["good"],
    allowedMcpTools: ["mcp__good__echo"]
  });

  try {
    const policy = new DefaultToolPolicyEngine();
    const { context } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatRole: "admin"
    });

    const blockedServer = await policy.authorize({
      toolName: "mcp__bad__echo",
      args: {},
      ctx: context
    });
    assert.equal(blockedServer.allowed, false);
    assert.match(blockedServer.reason ?? "", /not allowed/i);

    const blockedTool = await policy.authorize({
      toolName: "mcp__good__secret",
      args: {},
      ctx: context
    });
    assert.equal(blockedTool.allowed, false);
    assert.match(blockedTool.reason ?? "", /not allowed/i);

    const allowed = await policy.authorize({
      toolName: "mcp__good__echo",
      args: {},
      ctx: context
    });
    assert.equal(allowed.allowed, true);
  } finally {
    fixture.cleanup();
  }
});
