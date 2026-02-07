import type { McpServerHealth } from "../mcp/manager.js";

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

const line = (name: string, value: number, labels?: Record<string, string>) => {
  if (!labels || Object.keys(labels).length === 0) {
    return `${name} ${Number.isFinite(value) ? value : 0}`;
  }
  const labelText = Object.entries(labels)
    .map(([key, raw]) => `${key}="${String(raw).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",");
  return `${name}{${labelText}} ${Number.isFinite(value) ? value : 0}`;
};

export const renderPrometheusMetrics = (params: {
  startedAtMs: number;
  queue: {
    inbound: QueueCounts;
    outbound: QueueCounts;
  };
  telemetry: TelemetrySnapshot;
  mcp: Record<string, McpServerHealth>;
  readiness: {
    live: boolean;
    ready: boolean;
    startup: boolean;
  };
}) => {
  const lines: string[] = [];
  const uptimeSeconds = Math.max(0, (Date.now() - params.startedAtMs) / 1_000);

  lines.push(line("corebot_uptime_seconds", uptimeSeconds));
  lines.push(line("corebot_health_live", params.readiness.live ? 1 : 0));
  lines.push(line("corebot_health_ready", params.readiness.ready ? 1 : 0));
  lines.push(line("corebot_health_startup", params.readiness.startup ? 1 : 0));

  for (const [direction, counts] of Object.entries(params.queue)) {
    lines.push(line("corebot_queue_pending", counts.pending, { direction }));
    lines.push(line("corebot_queue_processing", counts.processing, { direction }));
    lines.push(line("corebot_queue_processed", counts.processed, { direction }));
    lines.push(line("corebot_queue_dead_letter", counts.dead_letter, { direction }));
  }

  lines.push(line("corebot_tools_calls_total", params.telemetry.tools.totals.calls));
  lines.push(line("corebot_tools_failures_total", params.telemetry.tools.totals.failures));
  lines.push(line("corebot_tools_failure_rate", params.telemetry.tools.totals.failureRate));
  for (const metric of params.telemetry.tools.byName) {
    lines.push(line("corebot_tool_calls_total", metric.calls, { tool: metric.name }));
    lines.push(line("corebot_tool_failures_total", metric.failures, { tool: metric.name }));
    lines.push(line("corebot_tool_failure_rate", metric.failureRate, { tool: metric.name }));
    lines.push(line("corebot_tool_avg_latency_ms", metric.avgLatencyMs, { tool: metric.name }));
    lines.push(line("corebot_tool_max_latency_ms", metric.maxLatencyMs, { tool: metric.name }));
  }

  lines.push(line("corebot_scheduler_dispatches_total", params.telemetry.scheduler.dispatches));
  lines.push(line("corebot_scheduler_tasks_total", params.telemetry.scheduler.tasks));
  lines.push(line("corebot_scheduler_avg_delay_ms", params.telemetry.scheduler.avgDelayMs));
  lines.push(line("corebot_scheduler_max_delay_ms", params.telemetry.scheduler.maxDelayMs));

  for (const [server, health] of Object.entries(params.mcp)) {
    const statusValue = health.status === "healthy" ? 2 : health.status === "degraded" ? 1 : 0;
    const failureRate = health.calls > 0 ? health.failures / health.calls : 0;
    lines.push(line("corebot_mcp_status", statusValue, { server }));
    lines.push(line("corebot_mcp_tools", health.tools, { server }));
    lines.push(line("corebot_mcp_calls_total", health.calls, { server }));
    lines.push(line("corebot_mcp_failures_total", health.failures, { server }));
    lines.push(line("corebot_mcp_failure_rate", failureRate, { server }));
  }

  return lines.join("\n") + "\n";
};
