import type { Logger } from "pino";
import type { Config } from "../config/schema.js";
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
  };
  scheduler: {
    maxDelayMs: number;
  };
};

export class SloMonitor {
  private readonly alertLastTs = new Map<string, number>();

  constructor(
    private config: Config,
    private logger: Pick<Logger, "warn">
  ) {}

  async evaluate(params: {
    queue: {
      inbound: QueueCounts;
      outbound: QueueCounts;
    };
    telemetry: TelemetrySnapshot;
    mcp: Record<string, McpServerHealth>;
  }) {
    if (!this.config.slo.enabled) {
      return;
    }

    const pendingTotal =
      params.queue.inbound.pending +
      params.queue.inbound.processing +
      params.queue.outbound.pending +
      params.queue.outbound.processing;
    const deadLetterTotal =
      params.queue.inbound.dead_letter + params.queue.outbound.dead_letter;
    const toolFailureRate = params.telemetry.tools.totals.failureRate;
    const schedulerDelay = params.telemetry.scheduler.maxDelayMs;
    const mcpTotals = Object.values(params.mcp).reduce(
      (acc, health) => {
        acc.calls += health.calls;
        acc.failures += health.failures;
        return acc;
      },
      { calls: 0, failures: 0 }
    );
    const mcpFailureRate =
      mcpTotals.calls > 0 ? mcpTotals.failures / mcpTotals.calls : 0;

    await this.maybeAlert(
      "pending_queue",
      pendingTotal > this.config.slo.maxPendingQueue,
      "SLO breach: pending queue exceeds threshold",
      {
        pendingTotal,
        threshold: this.config.slo.maxPendingQueue
      }
    );

    await this.maybeAlert(
      "dead_letter_queue",
      deadLetterTotal > this.config.slo.maxDeadLetterQueue,
      "SLO breach: dead-letter queue exceeds threshold",
      {
        deadLetterTotal,
        threshold: this.config.slo.maxDeadLetterQueue
      }
    );

    await this.maybeAlert(
      "tool_failure_rate",
      toolFailureRate > this.config.slo.maxToolFailureRate,
      "SLO breach: tool failure rate exceeds threshold",
      {
        toolFailureRate,
        threshold: this.config.slo.maxToolFailureRate
      }
    );

    await this.maybeAlert(
      "scheduler_delay",
      schedulerDelay > this.config.slo.maxSchedulerDelayMs,
      "SLO breach: scheduler delay exceeds threshold",
      {
        schedulerDelay,
        threshold: this.config.slo.maxSchedulerDelayMs
      }
    );

    await this.maybeAlert(
      "mcp_failure_rate",
      mcpFailureRate > this.config.slo.maxMcpFailureRate,
      "SLO breach: MCP failure rate exceeds threshold",
      {
        mcpFailureRate,
        threshold: this.config.slo.maxMcpFailureRate
      }
    );
  }

  private async maybeAlert(
    key: string,
    breached: boolean,
    message: string,
    details: Record<string, unknown>
  ) {
    if (!breached) {
      return;
    }

    const now = Date.now();
    const last = this.alertLastTs.get(key) ?? 0;
    if (now - last < this.config.slo.alertCooldownMs) {
      return;
    }
    this.alertLastTs.set(key, now);

    this.logger.warn(
      {
        alertKey: key,
        details
      },
      message
    );

    if (!this.config.slo.alertWebhookUrl) {
      return;
    }

    try {
      await fetch(this.config.slo.alertWebhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          alertKey: key,
          message,
          details,
          at: new Date(now).toISOString()
        })
      });
    } catch {
      this.logger.warn(
        {
          alertKey: key
        },
        "failed to publish SLO alert webhook"
      );
    }
  }
}
