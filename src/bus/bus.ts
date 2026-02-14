import type { InboundMessage, OutboundMessage, BusMessageDirection, BusQueueRecord } from "../types.js";
import { AsyncQueue } from "./queue.js";
import type { Logger } from "pino";
import type { SqliteStorage } from "../storage/sqlite.js";
import type { Config } from "../config/schema.js";
import { nowIso, sleep } from "../util/time.js";

export type InboundHandler = (message: InboundMessage) => Promise<void>;
export type OutboundHandler = (message: OutboundMessage) => Promise<void>;
type BusLogger = Pick<Logger, "error" | "warn" | "info" | "debug">;

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> => {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

export class MessageBus {
  private inboundSignal = new AsyncQueue<number>();
  private outboundSignal = new AsyncQueue<number>();
  private inboundHandlers: InboundHandler[] = [];
  private outboundHandlers: OutboundHandler[] = [];
  private running = false;
  private logger: BusLogger | null = null;
  private chatRateBuckets = new Map<
    string,
    {
      windowStartMs: number;
      count: number;
    }
  >();

  constructor(
    private storage: SqliteStorage,
    private config: Config,
    logger?: BusLogger
  ) {
    this.logger = logger ?? null;
  }

  publishInbound(message: InboundMessage) {
    this.publishMessage("inbound", message);
  }

  publishOutbound(message: OutboundMessage) {
    this.publishMessage("outbound", message);
  }

  private publishMessage(
    direction: BusMessageDirection,
    message: InboundMessage | OutboundMessage
  ) {
    const now = nowIso();
    const flow = this.computeFlowControl(direction, message, now);
    const idempotencyKey = `${message.channel}:${message.chatId}:${message.id}`;
    const queued = this.storage.enqueueBusMessage({
      direction,
      payload: message,
      maxAttempts: this.config.bus.maxAttempts,
      availableAt: flow.availableAt,
      idempotencyKey
    });

    if (flow.dropReason && queued.inserted) {
      this.storage.markBusMessageDeadLetter({
        id: queued.queueId,
        attempts: this.config.bus.maxAttempts,
        error: flow.dropReason,
        deadLetteredAt: now
      });
      this.logger?.warn(
        {
          direction,
          queueId: queued.queueId,
          chatId: message.chatId,
          reason: flow.dropReason
        },
        "bus message dropped by flow control"
      );
      return;
    }

    if (queued.inserted || queued.status === "pending") {
      this.signalDirection(direction);
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

  wakeInbound() {
    this.signalDirection("inbound");
  }

  wakeOutbound() {
    this.signalDirection("outbound");
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
          await withTimeout(
            this.dispatchInbound(message as InboundMessage),
            this.config.bus.processingTimeoutMs,
            `Inbound handler timed out after ${this.config.bus.processingTimeoutMs}ms`
          );
        } else {
          await withTimeout(
            this.dispatchOutbound(message as OutboundMessage),
            this.config.bus.processingTimeoutMs,
            `Outbound handler timed out after ${this.config.bus.processingTimeoutMs}ms`
          );
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

  private computeFlowControl(
    direction: BusMessageDirection,
    message: InboundMessage | OutboundMessage,
    now: string
  ): { availableAt?: string; dropReason?: string } {
    const counts = this.storage.countBusMessagesByStatus(direction);
    const queuedTotal = counts.pending + counts.processing;
    const maxPending =
      direction === "inbound"
        ? this.config.bus.maxPendingInbound
        : this.config.bus.maxPendingOutbound;

    if (queuedTotal >= maxPending) {
      return {
        dropReason: `Queue overflow for ${direction}: ${queuedTotal}/${maxPending}`
      };
    }

    const rateLimited = this.consumeRateBucket(
      direction,
      `${message.channel}:${message.chatId}`
    );
    if (rateLimited) {
      return {
        dropReason: rateLimited
      };
    }

    if (queuedTotal >= this.config.bus.overloadPendingThreshold) {
      return {
        availableAt: new Date(Date.now() + this.config.bus.overloadBackoffMs).toISOString()
      };
    }

    this.pruneRateBuckets(now);
    return {};
  }

  private consumeRateBucket(
    direction: BusMessageDirection,
    chatKey: string
  ): string | null {
    const key = `${direction}:${chatKey}`;
    const windowMs = this.config.bus.perChatRateLimitWindowMs;
    const max = this.config.bus.perChatRateLimitMax;
    const nowMs = Date.now();
    const current = this.chatRateBuckets.get(key);

    if (!current || nowMs - current.windowStartMs >= windowMs) {
      this.chatRateBuckets.set(key, {
        windowStartMs: nowMs,
        count: 1
      });
      return null;
    }

    if (current.count >= max) {
      const retryAfterMs = Math.max(0, windowMs - (nowMs - current.windowStartMs));
      return `Rate limit exceeded for ${direction}:${chatKey}; retry after ${retryAfterMs}ms`;
    }

    current.count += 1;
    this.chatRateBuckets.set(key, current);
    return null;
  }

  private pruneRateBuckets(now: string) {
    if (this.chatRateBuckets.size < 512) {
      return;
    }
    const nowMs = new Date(now).getTime();
    const ttlMs = this.config.bus.perChatRateLimitWindowMs * 2;
    for (const [key, bucket] of this.chatRateBuckets.entries()) {
      if (nowMs - bucket.windowStartMs > ttlMs) {
        this.chatRateBuckets.delete(key);
      }
    }
  }
}
