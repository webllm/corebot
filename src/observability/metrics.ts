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
  mcpReload: {
    totals: {
      calls: number;
      reloaded: number;
      failures: number;
      skipped: number;
      successRate: number;
      failureRate: number;
      avgDurationMs: number;
      maxDurationMs: number;
    };
    byReason: Array<{
      reason: string;
      calls: number;
      reloaded: number;
      failures: number;
      skipped: number;
      successRate: number;
      failureRate: number;
      avgDurationMs: number;
      maxDurationMs: number;
    }>;
  };
  heartbeat: {
    totals: {
      calls: number;
      queued: number;
      sent: number;
      skipped: number;
      failed: number;
    };
    byScope: Array<{
      scope: string;
      calls: number;
      queued: number;
      sent: number;
      skipped: number;
      failed: number;
    }>;
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

  lines.push(line("corebot_mcp_reload_calls_total", params.telemetry.mcpReload.totals.calls));
  lines.push(line("corebot_mcp_reload_reloaded_total", params.telemetry.mcpReload.totals.reloaded));
  lines.push(line("corebot_mcp_reload_failures_total", params.telemetry.mcpReload.totals.failures));
  lines.push(line("corebot_mcp_reload_skipped_total", params.telemetry.mcpReload.totals.skipped));
  lines.push(line("corebot_mcp_reload_success_rate", params.telemetry.mcpReload.totals.successRate));
  lines.push(line("corebot_mcp_reload_failure_rate", params.telemetry.mcpReload.totals.failureRate));
  lines.push(
    line("corebot_mcp_reload_avg_duration_ms", params.telemetry.mcpReload.totals.avgDurationMs)
  );
  lines.push(
    line("corebot_mcp_reload_max_duration_ms", params.telemetry.mcpReload.totals.maxDurationMs)
  );
  for (const metric of params.telemetry.mcpReload.byReason) {
    lines.push(line("corebot_mcp_reload_reason_calls_total", metric.calls, { reason: metric.reason }));
    lines.push(
      line("corebot_mcp_reload_reason_reloaded_total", metric.reloaded, { reason: metric.reason })
    );
    lines.push(
      line("corebot_mcp_reload_reason_failures_total", metric.failures, { reason: metric.reason })
    );
    lines.push(
      line("corebot_mcp_reload_reason_skipped_total", metric.skipped, { reason: metric.reason })
    );
    lines.push(
      line("corebot_mcp_reload_reason_success_rate", metric.successRate, {
        reason: metric.reason
      })
    );
    lines.push(
      line("corebot_mcp_reload_reason_failure_rate", metric.failureRate, {
        reason: metric.reason
      })
    );
    lines.push(
      line("corebot_mcp_reload_reason_avg_duration_ms", metric.avgDurationMs, {
        reason: metric.reason
      })
    );
    lines.push(
      line("corebot_mcp_reload_reason_max_duration_ms", metric.maxDurationMs, {
        reason: metric.reason
      })
    );
  }

  lines.push(line("corebot_heartbeat_calls_total", params.telemetry.heartbeat.totals.calls));
  lines.push(line("corebot_heartbeat_queued_total", params.telemetry.heartbeat.totals.queued));
  lines.push(line("corebot_heartbeat_sent_total", params.telemetry.heartbeat.totals.sent));
  lines.push(line("corebot_heartbeat_skipped_total", params.telemetry.heartbeat.totals.skipped));
  lines.push(line("corebot_heartbeat_failed_total", params.telemetry.heartbeat.totals.failed));
  for (const metric of params.telemetry.heartbeat.byScope) {
    lines.push(line("corebot_heartbeat_scope_calls_total", metric.calls, { scope: metric.scope }));
    lines.push(
      line("corebot_heartbeat_scope_queued_total", metric.queued, { scope: metric.scope })
    );
    lines.push(line("corebot_heartbeat_scope_sent_total", metric.sent, { scope: metric.scope }));
    lines.push(
      line("corebot_heartbeat_scope_skipped_total", metric.skipped, { scope: metric.scope })
    );
    lines.push(
      line("corebot_heartbeat_scope_failed_total", metric.failed, { scope: metric.scope })
    );
  }

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
