import http from "node:http";
import type { Logger } from "pino";
import type { Config } from "../config/schema.js";
import type { McpServerHealth } from "../mcp/manager.js";
import { renderPrometheusMetrics } from "./metrics.js";

type QueueCounts = {
  pending: number;
  processing: number;
  processed: number;
  dead_letter: number;
};

type TelemetrySnapshot = {
  tools: {
    totals: {
      calls: number;
      failures: number;
      failureRate: number;
    };
    byName: Array<{
      name: string;
      calls: number;
      failures: number;
      failureRate: number;
      avgLatencyMs: number;
      maxLatencyMs: number;
    }>;
  };
  scheduler: {
    dispatches: number;
    tasks: number;
    avgDelayMs: number;
    maxDelayMs: number;
  };
};

export class ObservabilityServer {
  private server: http.Server | null = null;

  constructor(
    private config: Config,
    private logger: Pick<Logger, "info" | "warn" | "error">,
    private deps: {
      startedAtMs: number;
      getQueue: () => { inbound: QueueCounts; outbound: QueueCounts };
      getTelemetry: () => TelemetrySnapshot;
      getMcp: () => Record<string, McpServerHealth>;
      isReady: () => boolean;
      isStartupComplete: () => boolean;
    }
  ) {}

  async start() {
    if (!this.config.observability.http.enabled || this.server) {
      return;
    }

    this.server = http.createServer((req, res) => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      const live = true;
      const ready = this.deps.isReady();
      const startup = this.deps.isStartupComplete();

      if (method === "GET" && path === "/health/live") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "live", at: new Date().toISOString() }));
        return;
      }

      if (method === "GET" && path === "/health/ready") {
        res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            status: ready ? "ready" : "not_ready",
            at: new Date().toISOString()
          })
        );
        return;
      }

      if (method === "GET" && path === "/health/startup") {
        res.writeHead(startup ? 200 : 503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            status: startup ? "started" : "starting",
            at: new Date().toISOString()
          })
        );
        return;
      }

      if (method === "GET" && path === "/metrics") {
        const body = renderPrometheusMetrics({
          startedAtMs: this.deps.startedAtMs,
          queue: this.deps.getQueue(),
          telemetry: this.deps.getTelemetry(),
          mcp: this.deps.getMcp(),
          readiness: {
            live,
            ready,
            startup
          }
        });
        res.writeHead(200, {
          "content-type": "text/plain; version=0.0.4; charset=utf-8"
        });
        res.end(body);
        return;
      }

      if (method === "GET" && path === "/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            {
              health: {
                live,
                ready,
                startup
              },
              queue: this.deps.getQueue(),
              telemetry: this.deps.getTelemetry(),
              mcp: this.deps.getMcp()
            },
            null,
            2
          )
        );
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(
        this.config.observability.http.port,
        this.config.observability.http.host,
        () => resolve()
      );
    });
    this.logger.info(
      {
        host: this.config.observability.http.host,
        port: this.config.observability.http.port
      },
      "observability server listening"
    );
  }

  async stop() {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}
