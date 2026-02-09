type ToolMetric = {
  calls: number;
  failures: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
};

type SchedulerMetric = {
  dispatches: number;
  tasks: number;
  totalDelayMs: number;
  maxDelayMs: number;
};

type McpReloadMetric = {
  calls: number;
  reloaded: number;
  failures: number;
  skipped: number;
  totalDurationMs: number;
  maxDurationMs: number;
};

const createMcpReloadMetric = (): McpReloadMetric => ({
  calls: 0,
  reloaded: 0,
  failures: 0,
  skipped: 0,
  totalDurationMs: 0,
  maxDurationMs: 0
});

const sanitizeReasonLabel = (reason: string) => {
  const raw = reason.trim().slice(0, 80);
  if (!raw) {
    return "unspecified";
  }
  return raw.replace(/[^a-zA-Z0-9_.:-]/g, "_");
};

export class RuntimeTelemetry {
  private toolMetrics = new Map<string, ToolMetric>();
  private schedulerMetric: SchedulerMetric = {
    dispatches: 0,
    tasks: 0,
    totalDelayMs: 0,
    maxDelayMs: 0
  };
  private mcpReloadTotals: McpReloadMetric = createMcpReloadMetric();
  private mcpReloadByReason = new Map<string, McpReloadMetric>();

  recordToolExecution(name: string, durationMs: number, success: boolean) {
    const metric = this.toolMetrics.get(name) ?? {
      calls: 0,
      failures: 0,
      totalLatencyMs: 0,
      maxLatencyMs: 0
    };

    metric.calls += 1;
    if (!success) {
      metric.failures += 1;
    }
    metric.totalLatencyMs += durationMs;
    metric.maxLatencyMs = Math.max(metric.maxLatencyMs, durationMs);
    this.toolMetrics.set(name, metric);
  }

  recordSchedulerDispatch(delaysMs: number[]) {
    this.schedulerMetric.dispatches += 1;
    this.schedulerMetric.tasks += delaysMs.length;
    for (const delay of delaysMs) {
      this.schedulerMetric.totalDelayMs += delay;
      this.schedulerMetric.maxDelayMs = Math.max(this.schedulerMetric.maxDelayMs, delay);
    }
  }

  recordMcpReload(params: {
    reason: string;
    durationMs: number;
    outcome: "reloaded" | "failed" | "skipped";
  }) {
    const reasonLabel = sanitizeReasonLabel(params.reason);
    const total = this.mcpReloadTotals;
    const byReason = this.mcpReloadByReason.get(reasonLabel) ?? createMcpReloadMetric();

    const applyOutcome = (metric: McpReloadMetric) => {
      metric.calls += 1;
      if (params.outcome === "reloaded") {
        metric.reloaded += 1;
      } else if (params.outcome === "failed") {
        metric.failures += 1;
      } else {
        metric.skipped += 1;
      }
      metric.totalDurationMs += params.durationMs;
      metric.maxDurationMs = Math.max(metric.maxDurationMs, params.durationMs);
    };

    applyOutcome(total);
    applyOutcome(byReason);
    this.mcpReloadByReason.set(reasonLabel, byReason);
  }

  snapshot() {
    const toolEntries = [...this.toolMetrics.entries()].map(([name, metric]) => ({
      name,
      calls: metric.calls,
      failures: metric.failures,
      failureRate: metric.calls > 0 ? metric.failures / metric.calls : 0,
      avgLatencyMs: metric.calls > 0 ? metric.totalLatencyMs / metric.calls : 0,
      maxLatencyMs: metric.maxLatencyMs
    }));

    const toolTotals = toolEntries.reduce(
      (acc, entry) => {
        acc.calls += entry.calls;
        acc.failures += entry.failures;
        return acc;
      },
      { calls: 0, failures: 0 }
    );

    return {
      tools: {
        totals: {
          calls: toolTotals.calls,
          failures: toolTotals.failures,
          failureRate:
            toolTotals.calls > 0 ? toolTotals.failures / toolTotals.calls : 0
        },
        byName: toolEntries.sort((a, b) => b.calls - a.calls)
      },
      scheduler: {
        dispatches: this.schedulerMetric.dispatches,
        tasks: this.schedulerMetric.tasks,
        avgDelayMs:
          this.schedulerMetric.tasks > 0
            ? this.schedulerMetric.totalDelayMs / this.schedulerMetric.tasks
            : 0,
        maxDelayMs: this.schedulerMetric.maxDelayMs
      },
      mcpReload: {
        totals: {
          calls: this.mcpReloadTotals.calls,
          reloaded: this.mcpReloadTotals.reloaded,
          failures: this.mcpReloadTotals.failures,
          skipped: this.mcpReloadTotals.skipped,
          successRate:
            this.mcpReloadTotals.calls > 0
              ? this.mcpReloadTotals.reloaded / this.mcpReloadTotals.calls
              : 0,
          failureRate:
            this.mcpReloadTotals.calls > 0
              ? this.mcpReloadTotals.failures / this.mcpReloadTotals.calls
              : 0,
          avgDurationMs:
            this.mcpReloadTotals.calls > 0
              ? this.mcpReloadTotals.totalDurationMs / this.mcpReloadTotals.calls
              : 0,
          maxDurationMs: this.mcpReloadTotals.maxDurationMs
        },
        byReason: [...this.mcpReloadByReason.entries()]
          .map(([reason, metric]) => ({
            reason,
            calls: metric.calls,
            reloaded: metric.reloaded,
            failures: metric.failures,
            skipped: metric.skipped,
            successRate: metric.calls > 0 ? metric.reloaded / metric.calls : 0,
            failureRate: metric.calls > 0 ? metric.failures / metric.calls : 0,
            avgDurationMs: metric.calls > 0 ? metric.totalDurationMs / metric.calls : 0,
            maxDurationMs: metric.maxDurationMs
          }))
          .sort((a, b) => b.calls - a.calls)
      }
    };
  }
}
