import type { InboundMessage, OutboundMessage, BusMessageDirection, BusQueueRecord } from "../types.js";
import { AsyncQueue } from "./queue.js";
import type { Logger } from "pino";
import type { SqliteStorage } from "../storage/sqlite.js";
import type { Config } from "../config/schema.js";
import { nowIso, sleep } from "../util/time.js";

export type InboundHandler = (message: InboundMessage) => Promise<void>;
export type OutboundHandler = (message: OutboundMessage) => Promise<void>;
type BusLogger = Pick<Logger, "error" | "warn" | "info" | "debug">;

export class MessageBus {
  private inboundSignal = new AsyncQueue<number>();
  private outboundSignal = new AsyncQueue<number>();
  private inboundHandlers: InboundHandler[] = [];
  private outboundHandlers: OutboundHandler[] = [];
  private running = false;
  private logger: BusLogger | null = null;

  constructor(
    private storage: SqliteStorage,
    private config: Config,
    logger?: BusLogger
  ) {
    this.logger = logger ?? null;
  }

  publishInbound(message: InboundMessage) {
    const idempotencyKey = `${message.channel}:${message.chatId}:${message.id}`;
    const queued = this.storage.enqueueBusMessage({
      direction: "inbound",
      payload: message,
      maxAttempts: this.config.bus.maxAttempts,
      idempotencyKey
    });
    if (queued.inserted || queued.status === "pending") {
      this.inboundSignal.push(Date.now());
    }
  }

  publishOutbound(message: OutboundMessage) {
    const idempotencyKey = `${message.channel}:${message.chatId}:${message.id}`;
    const queued = this.storage.enqueueBusMessage({
      direction: "outbound",
      payload: message,
      maxAttempts: this.config.bus.maxAttempts,
      idempotencyKey
    });
    if (queued.inserted || queued.status === "pending") {
      this.outboundSignal.push(Date.now());
    }
  }

  listDeadLetterMessages(direction?: BusMessageDirection, limit = 100): BusQueueRecord[] {
    return this.storage.listDeadLetterBusMessages(direction, limit);
  }

  replayDeadLetterMessages(params: {
    queueId?: string;
    direction?: BusMessageDirection;
    limit?: number;
  }): { replayed: number; ids: string[] } {
    const now = nowIso();

    if (params.queueId) {
      const replayed = this.storage.replayDeadLetterBusMessage({
        id: params.queueId,
        now
      });
      if (!replayed) {
        return { replayed: 0, ids: [] };
      }
      this.signalDirection(replayed.direction);
      return { replayed: 1, ids: [replayed.id] };
    }

    const replayed = this.storage.replayDeadLetterBusMessages({
      direction: params.direction,
      limit: params.limit ?? 10,
      now
    });

    let inboundSignaled = false;
    let outboundSignaled = false;
    for (const item of replayed) {
      if (item.direction === "inbound" && !inboundSignaled) {
        this.inboundSignal.push(Date.now());
        inboundSignaled = true;
      }
      if (item.direction === "outbound" && !outboundSignaled) {
        this.outboundSignal.push(Date.now());
        outboundSignaled = true;
      }
    }

    return {
      replayed: replayed.length,
      ids: replayed.map((item) => item.id)
    };
  }

  onInbound(handler: InboundHandler) {
    this.inboundHandlers.push(handler);
  }

  onOutbound(handler: OutboundHandler) {
    this.outboundHandlers.push(handler);
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.recoverStaleProcessingMessages();
    void this.runInboundLoop();
    void this.runOutboundLoop();
  }

  stop() {
    this.running = false;
    this.inboundSignal.push(Date.now());
    this.outboundSignal.push(Date.now());
  }

  isRunning() {
    return this.running;
  }

  private async runInboundLoop() {
    while (this.running) {
      let processed = 0;
      try {
        processed = await this.processDirection("inbound");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.error({ error: message }, "inbound bus loop error");
      }
      if (processed === 0) {
        await Promise.race([
          sleep(this.config.bus.pollMs),
          this.inboundSignal.next().then(() => undefined)
        ]);
      }
    }
  }

  private async runOutboundLoop() {
    while (this.running) {
      let processed = 0;
      try {
        processed = await this.processDirection("outbound");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.error({ error: message }, "outbound bus loop error");
      }
      if (processed === 0) {
        await Promise.race([
          sleep(this.config.bus.pollMs),
          this.outboundSignal.next().then(() => undefined)
        ]);
      }
    }
  }

  private async processDirection(direction: BusMessageDirection): Promise<number> {
    const due = this.storage.listDueBusMessages(
      direction,
      nowIso(),
      this.config.bus.batchSize
    );
    if (due.length === 0) {
      return 0;
    }

    let processed = 0;
    for (const record of due) {
      if (!this.running) {
        break;
      }

      const claimedAt = nowIso();
      const claimed = this.storage.claimBusMessage(record.id, claimedAt);
      if (!claimed) {
        continue;
      }

      try {
        const message = JSON.parse(record.payload) as InboundMessage | OutboundMessage;
        if (direction === "inbound") {
          await this.dispatchInbound(message as InboundMessage);
        } else {
          await this.dispatchOutbound(message as OutboundMessage);
        }
        this.storage.markBusMessageProcessed(record.id, nowIso());
        processed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.handleProcessingError(record, message);
      }
    }

    return processed;
  }

  private async dispatchInbound(message: InboundMessage) {
    for (const handler of this.inboundHandlers) {
      await handler(message);
    }
  }

  private async dispatchOutbound(message: OutboundMessage) {
    for (const handler of this.outboundHandlers) {
      await handler(message);
    }
  }

  private handleProcessingError(record: BusQueueRecord, error: string) {
    const nextAttempts = record.attempts + 1;
    const now = nowIso();
    if (nextAttempts >= record.maxAttempts) {
      this.storage.markBusMessageDeadLetter({
        id: record.id,
        attempts: nextAttempts,
        error,
        deadLetteredAt: now
      });
      this.logger?.error(
        {
          queueId: record.id,
          direction: record.direction,
          attempts: nextAttempts,
          maxAttempts: record.maxAttempts,
          error
        },
        "bus message dead-lettered"
      );
      return;
    }

    const delay = this.computeRetryDelayMs(nextAttempts);
    const availableAt = new Date(new Date(now).getTime() + delay).toISOString();
    this.storage.markBusMessageRetry({
      id: record.id,
      attempts: nextAttempts,
      availableAt,
      error,
      updatedAt: now
    });
    this.logger?.warn(
      {
        queueId: record.id,
        direction: record.direction,
        attempts: nextAttempts,
        maxAttempts: record.maxAttempts,
        retryAt: availableAt,
        error
      },
      "bus message scheduled for retry"
    );
  }

  private computeRetryDelayMs(attempts: number) {
    const base = this.config.bus.retryBackoffMs;
    const max = this.config.bus.maxRetryBackoffMs;
    const exponent = Math.max(0, attempts - 1);
    return Math.min(base * 2 ** exponent, max);
  }

  private recoverStaleProcessingMessages() {
    const staleBefore = new Date(
      Date.now() - this.config.bus.processingTimeoutMs
    ).toISOString();
    const recovered = this.storage.recoverStaleProcessingBusMessages({
      staleBefore,
      now: nowIso(),
      retryBackoffMs: this.config.bus.retryBackoffMs
    });

    if (recovered.requeued > 0 || recovered.deadLettered > 0) {
      this.logger?.warn(
        recovered,
        "recovered stale processing bus messages"
      );
    }
  }

  private signalDirection(direction: BusMessageDirection) {
    if (direction === "inbound") {
      this.inboundSignal.push(Date.now());
    } else {
      this.outboundSignal.push(Date.now());
    }
  }
}
