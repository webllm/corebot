import test from "node:test";
import assert from "node:assert/strict";
import { webTools } from "../src/tools/builtins/web.js";
import { createStorageFixture, createToolContext } from "./test-utils.js";

const getTool = (name: string) => {
  const tool = webTools().find((item) => item.name === name);
  if (!tool) {
    throw new Error(`${name} tool missing`);
  }
  return tool;
};

test("web.fetch blocks localhost and private-network targets", async () => {
  const fixture = createStorageFixture();
  try {
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    const { context } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: chat.id
    });

    const fetchTool = getTool("web.fetch");
    await assert.rejects(
      fetchTool.run({ url: "http://127.0.0.1:8080" }, context),
      /Private network access is blocked/
    );
    await assert.rejects(
      fetchTool.run({ url: "http://localhost:3000" }, context),
      /Localhost access is blocked/
    );
  } finally {
    fixture.cleanup();
  }
});

test("web.search is default-deny for env keys and works when explicitly allowed", async () => {
  const fixture = createStorageFixture();
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.BRAVE_API_KEY;
  try {
    process.env.BRAVE_API_KEY = "test-brave-key";
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    const searchTool = getTool("web.search");

    const denied = createToolContext({
      config: { ...fixture.config, allowedEnv: [] },
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: chat.id
    }).context;

    await assert.rejects(searchTool.run({ query: "hello" }, denied), /not available/);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as typeof fetch;

    const allowed = createToolContext({
      config: { ...fixture.config, allowedEnv: ["BRAVE_API_KEY"] },
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: chat.id
    }).context;

    const result = await searchTool.run({ query: "hello" }, allowed);
    assert.match(result, /"ok": true/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.BRAVE_API_KEY;
    } else {
      process.env.BRAVE_API_KEY = originalKey;
    }
    fixture.cleanup();
  }
});
