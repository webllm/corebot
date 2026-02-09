import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createCorebotApp, main } from "../src/index.js";
import { createStorageFixture } from "./test-utils.js";

const logger = {
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  child: () => logger
} as any;

test("SDK entrypoint exports callable main function", () => {
  assert.equal(typeof main, "function");
});

test("createCorebotApp supports lifecycle start/stop for embedded usage", async () => {
  const fixture = createStorageFixture({
    cli: { enabled: false },
    webhook: { enabled: false },
    observability: {
      enabled: false,
      http: { enabled: false }
    }
  });

  const app = await createCorebotApp({
    config: fixture.config,
    logger
  });

  try {
    assert.equal(app.isRunning(), false);
    await app.start();
    assert.equal(app.isRunning(), true);
    assert.equal(app.bus.isRunning(), true);
    assert.equal(app.scheduler.isRunning(), true);
    await app.stop();
    assert.equal(app.isRunning(), false);
  } finally {
    if (app.isRunning()) {
      await app.stop();
    }
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("mcp.reload records telemetry and audit metadata with reason", async () => {
  const fixture = createStorageFixture({
    cli: { enabled: false },
    webhook: { enabled: false },
    observability: {
      enabled: false,
      http: { enabled: false }
    }
  });
  fs.writeFileSync(fixture.config.mcpConfigPath, JSON.stringify({ servers: {} }), "utf-8");

  const app = await createCorebotApp({
    config: fixture.config,
    logger
  });

  try {
    await app.start();
    const chat = app.storage.upsertChat({ channel: "cli", chatId: "admin" });
    app.storage.setChatRole(chat.id, "admin");

    const output = await app.toolRegistry.execute(
      "mcp.reload",
      { reason: "manual:test-audit" },
      {
        workspaceDir: fixture.workspaceDir,
        chat: {
          channel: "cli",
          chatId: "admin",
          role: "admin",
          id: chat.id
        },
        storage: app.storage,
        mcp: app.mcpManager,
        logger,
        bus: app.bus,
        config: app.config,
        skills: []
      }
    );
    const result = JSON.parse(output) as {
      reloaded: boolean;
      reason: string;
      toolCount: number;
      configSignature: string;
    };
    assert.equal(result.reloaded, true);
    assert.equal(result.reason, "manual:test-audit");

    const telemetry = app.telemetry.snapshot();
    const reloadMetric = telemetry.mcpReload.byReason.find(
      (metric) => metric.reason === "manual:test-audit"
    );
    assert.ok(reloadMetric);
    assert.equal(reloadMetric?.reloaded, 1);
    assert.ok(reloadMetric?.avgDurationMs !== undefined);

    const events = app.storage.listAuditEvents(20, "mcp.reload");
    assert.ok(events.some((event) => event.outcome === "reloaded"));
    assert.ok(
      events.some((event) => {
        if (!event.argsJson) {
          return false;
        }
        const parsed = JSON.parse(event.argsJson) as { reason?: string };
        return parsed.reason === "manual:test-audit";
      })
    );
  } finally {
    if (app.isRunning()) {
      await app.stop();
    }
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("mcp.reload non-force applies backoff and circuit after repeated failures", async () => {
  const fixture = createStorageFixture({
    cli: { enabled: false },
    webhook: { enabled: false },
    observability: {
      enabled: false,
      http: { enabled: false }
    },
    mcpSync: {
      failureBackoffBaseMs: 50,
      failureBackoffMaxMs: 50,
      openCircuitAfterFailures: 2,
      circuitResetMs: 300
    }
  });
  fs.writeFileSync(fixture.config.mcpConfigPath, "{ bad json", "utf-8");

  const app = await createCorebotApp({
    config: fixture.config,
    logger
  });

  const chat = app.storage.upsertChat({ channel: "cli", chatId: "admin" });
  app.storage.setChatRole(chat.id, "admin");
  const context = {
    workspaceDir: fixture.workspaceDir,
    chat: {
      channel: "cli" as const,
      chatId: "admin",
      role: "admin" as const,
      id: chat.id
    },
    storage: app.storage,
    mcp: app.mcpManager,
    logger,
    bus: app.bus,
    config: app.config,
    skills: []
  };

  try {
    const firstOutput = await app.toolRegistry.execute(
      "mcp.reload",
      { reason: "manual:test-throttle", force: false },
      context
    );
    const firstResult = JSON.parse(firstOutput) as {
      reloaded: boolean;
      skipCause?: string;
      retryAt?: string;
    };
    assert.equal(firstResult.reloaded, false);
    assert.equal(firstResult.skipCause, "backoff");
    assert.ok(firstResult.retryAt);

    await new Promise((resolve) => setTimeout(resolve, 80));
    await assert.rejects(
      app.toolRegistry.execute(
        "mcp.reload",
        { reason: "manual:test-throttle", force: false },
        context
      ),
      /Invalid MCP config JSON/
    );

    const thirdOutput = await app.toolRegistry.execute(
      "mcp.reload",
      { reason: "manual:test-throttle", force: false },
      context
    );
    const thirdResult = JSON.parse(thirdOutput) as {
      reloaded: boolean;
      skipCause?: string;
      retryAt?: string;
    };
    assert.equal(thirdResult.reloaded, false);
    assert.equal(thirdResult.skipCause, "circuit_open");
    assert.ok(thirdResult.retryAt);

    const telemetry = app.telemetry.snapshot();
    const backoffMetric = telemetry.mcpReload.byReason.find(
      (entry) => entry.reason === "manual:test-throttle:backoff"
    );
    const circuitMetric = telemetry.mcpReload.byReason.find(
      (entry) => entry.reason === "manual:test-throttle:circuit-open"
    );
    assert.ok(backoffMetric);
    assert.ok(circuitMetric);
  } finally {
    if (app.isRunning()) {
      await app.stop();
    } else {
      await app.mcpManager.shutdown();
      await app.isolatedRuntime.shutdown();
      app.storage.close();
    }
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});
