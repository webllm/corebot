import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeTelemetry } from "../src/observability/telemetry.js";
import { ObservabilityServer } from "../src/observability/server.js";
import { SloMonitor } from "../src/observability/slo.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { McpManager } from "../src/mcp/manager.js";
import { createStorageFixture } from "./test-utils.js";

const getFreePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });

test("RuntimeTelemetry aggregates tool and scheduler metrics", () => {
  const telemetry = new RuntimeTelemetry();
  telemetry.recordToolExecution("fs.read", 20, true);
  telemetry.recordToolExecution("fs.read", 40, false);
  telemetry.recordToolExecution("web.fetch", 100, true);
  telemetry.recordSchedulerDispatch([50, 100, 25]);
  telemetry.recordMcpReload({
    reason: "startup",
    durationMs: 12,
    outcome: "reloaded"
  });
  telemetry.recordMcpReload({
    reason: "inbound:auto-sync",
    durationMs: 4,
    outcome: "skipped"
  });
  telemetry.recordMcpReload({
    reason: "manual:tool",
    durationMs: 9,
    outcome: "failed"
  });

  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.tools.totals.calls, 3);
  assert.equal(snapshot.tools.totals.failures, 1);
  assert.equal(snapshot.tools.totals.failureRate, 1 / 3);
  assert.equal(snapshot.scheduler.tasks, 3);
  assert.equal(snapshot.scheduler.maxDelayMs, 100);
  assert.equal(snapshot.mcpReload.totals.calls, 3);
  assert.equal(snapshot.mcpReload.totals.reloaded, 1);
  assert.equal(snapshot.mcpReload.totals.failures, 1);
  assert.equal(snapshot.mcpReload.totals.skipped, 1);
  assert.equal(snapshot.mcpReload.byReason.length, 3);
  assert.equal(snapshot.heartbeat.totals.calls, 0);
});

test("Scheduler reports task delay telemetry", async () => {
  const fixture = createStorageFixture({
    scheduler: { tickMs: 20 }
  });
  try {
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    fixture.storage.createTask({
      chatFk: chat.id,
      prompt: "delay-test",
      scheduleType: "interval",
      scheduleValue: "60000",
      contextMode: "group",
      nextRunAt: new Date(Date.now() - 500).toISOString()
    });

    const telemetry = new RuntimeTelemetry();
    const bus = {
      publishInbound: () => undefined
    } as any;
    const logger = {
      info: () => undefined,
      warn: () => undefined
    } as any;

    const scheduler = new Scheduler(
      fixture.storage,
      bus,
      logger,
      fixture.config,
      telemetry
    );
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    scheduler.stop();

    const snapshot = telemetry.snapshot();
    assert.ok(snapshot.scheduler.tasks >= 1);
    assert.ok(snapshot.scheduler.maxDelayMs >= 500);
  } finally {
    fixture.cleanup();
  }
});

test("McpManager exposes health snapshot with call stats", async () => {
  let failLoad = false;
  let failCall = false;

  const manager = new McpManager({
    factory: {
      async createClient(server) {
        if (server.name === "bad" || failLoad) {
          throw new Error("load failure");
        }
        return {
          client: {
            async listTools() {
              return [{ name: "echo", description: "echo", inputSchema: { type: "object" } }];
            },
            async callTool() {
              if (failCall) {
                throw new Error("call failure");
              }
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
    logger: { warn: () => undefined } as any
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corebot-mcp-health-"));
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

    await manager.loadFromConfig(configPath);
    let health = manager.getHealthSnapshot();
    assert.equal(health.good?.status, "healthy");
    assert.equal(health.bad?.status, "down");

    await manager.callTool("mcp__good__echo", {});
    health = manager.getHealthSnapshot();
    assert.equal(health.good?.calls, 1);
    assert.equal(health.good?.failures, 0);

    failCall = true;
    await assert.rejects(manager.callTool("mcp__good__echo", {}), /call failure/);
    health = manager.getHealthSnapshot();
    assert.equal(health.good?.status, "degraded");
    assert.equal(health.good?.calls, 2);
    assert.equal(health.good?.failures, 1);
  } finally {
    await manager.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ObservabilityServer exposes health and metrics endpoints", async () => {
  const fixture = createStorageFixture({
    observability: {
      enabled: true,
      reportIntervalMs: 5_000,
      http: {
        enabled: true,
        host: "127.0.0.1",
        port: await getFreePort()
      }
    }
  });
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  } as any;

  const server = new ObservabilityServer(fixture.config, logger, {
    startedAtMs: Date.now() - 1_000,
    getQueue: () => ({
      inbound: { pending: 1, processing: 0, processed: 2, dead_letter: 0 },
      outbound: { pending: 0, processing: 0, processed: 1, dead_letter: 0 }
    }),
    getTelemetry: () => ({
      tools: {
        totals: { calls: 3, failures: 1, failureRate: 1 / 3 },
        byName: [
          {
            name: "memory.write",
            calls: 1,
            failures: 0,
            failureRate: 0,
            avgLatencyMs: 12,
            maxLatencyMs: 12
          }
        ]
      },
      scheduler: {
        dispatches: 1,
        tasks: 2,
        avgDelayMs: 25,
        maxDelayMs: 40
      },
      mcpReload: {
        totals: {
          calls: 4,
          reloaded: 2,
          failures: 1,
          skipped: 1,
          successRate: 0.5,
          failureRate: 0.25,
          avgDurationMs: 14,
          maxDurationMs: 20
        },
        byReason: [
          {
            reason: "startup",
            calls: 1,
            reloaded: 1,
            failures: 0,
            skipped: 0,
            successRate: 1,
            failureRate: 0,
            avgDurationMs: 20,
            maxDurationMs: 20
          },
          {
            reason: "inbound:auto-sync",
            calls: 3,
            reloaded: 1,
            failures: 1,
            skipped: 1,
            successRate: 1 / 3,
            failureRate: 1 / 3,
            avgDurationMs: 12,
            maxDurationMs: 16
          }
        ]
      },
      heartbeat: {
        totals: {
          calls: 3,
          queued: 1,
          sent: 1,
          skipped: 1,
          failed: 0
        },
        byScope: [
          {
            scope: "run",
            calls: 1,
            queued: 1,
            sent: 0,
            skipped: 0,
            failed: 0
          },
          {
            scope: "delivery",
            calls: 2,
            queued: 0,
            sent: 1,
            skipped: 1,
            failed: 0
          }
        ]
      }
    }),
    getMcp: () => ({
      remote: {
        status: "healthy",
        tools: 2,
        calls: 5,
        failures: 1,
        lastCheckedAt: new Date().toISOString()
      }
    }),
    isReady: () => true,
    isStartupComplete: () => true
  });

  try {
    await server.start();
    const base = `http://${fixture.config.observability.http.host}:${fixture.config.observability.http.port}`;

    const live = await fetch(`${base}/health/live`);
    assert.equal(live.status, 200);

    const ready = await fetch(`${base}/health/ready`);
    assert.equal(ready.status, 200);

    const metrics = await fetch(`${base}/metrics`);
    assert.equal(metrics.status, 200);
    const text = await metrics.text();
    assert.match(text, /corebot_health_ready 1/);
    assert.match(text, /corebot_queue_pending\{direction="inbound"\} 1/);
    assert.match(text, /corebot_mcp_calls_total\{server="remote"\} 5/);
    assert.match(text, /corebot_mcp_reload_calls_total 4/);
    assert.match(text, /corebot_mcp_reload_reason_calls_total\{reason="startup"\} 1/);
    assert.match(text, /corebot_heartbeat_calls_total 3/);
    assert.match(text, /corebot_heartbeat_scope_sent_total\{scope="delivery"\} 1/);

    const status = await fetch(`${base}/status`);
    assert.equal(status.status, 200);
    const body = (await status.json()) as { health?: { ready?: boolean } };
    assert.equal(body.health?.ready, true);
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("SloMonitor emits alert once per cooldown and supports webhook publish", async () => {
  const alerts: unknown[] = [];
  const port = await getFreePort();
  const webhook = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/alerts") {
      alerts.push({ at: Date.now() });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    webhook.once("error", reject);
    webhook.listen(port, "127.0.0.1", () => resolve());
  });

  const fixture = createStorageFixture({
    slo: {
      enabled: true,
      alertCooldownMs: 60_000,
      maxPendingQueue: 1,
      maxDeadLetterQueue: 0,
      maxToolFailureRate: 0.01,
      maxSchedulerDelayMs: 1,
      maxMcpFailureRate: 0.01,
      alertWebhookUrl: `http://127.0.0.1:${port}/alerts`
    }
  });

  let warnCount = 0;
  const monitor = new SloMonitor(fixture.config, {
    warn: () => {
      warnCount += 1;
    }
  } as any);

  try {
    const sample = {
      queue: {
        inbound: { pending: 2, processing: 0, processed: 0, dead_letter: 1 },
        outbound: { pending: 1, processing: 0, processed: 0, dead_letter: 1 }
      },
      telemetry: {
        tools: { totals: { calls: 10, failures: 5, failureRate: 0.5 } },
        scheduler: { maxDelayMs: 10_000 }
      },
      mcp: {
        remote: {
          status: "degraded" as const,
          tools: 1,
          calls: 10,
          failures: 9,
          lastCheckedAt: new Date().toISOString()
        }
      }
    };

    await monitor.evaluate(sample);
    await monitor.evaluate(sample);

    assert.ok(warnCount >= 5);
    assert.ok(warnCount <= 6);
    assert.ok(alerts.length >= 1);
  } finally {
    fixture.cleanup();
    await new Promise<void>((resolve) => webhook.close(() => resolve()));
  }
});
