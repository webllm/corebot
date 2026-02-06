import type { InboundMessage, OutboundMessage } from "../types.js";
import { AsyncQueue } from "./queue.js";
import type { Logger } from "pino";

export type InboundHandler = (message: InboundMessage) => Promise<void>;
export type OutboundHandler = (message: OutboundMessage) => Promise<void>;
type BusLogger = Pick<Logger, "error">;

export class MessageBus {
  private inboundQueue = new AsyncQueue<InboundMessage>();
  private outboundQueue = new AsyncQueue<OutboundMessage>();
  private inboundHandlers: InboundHandler[] = [];
  private outboundHandlers: OutboundHandler[] = [];
  private running = false;
  private logger: BusLogger | null = null;

  constructor(logger?: BusLogger) {
    this.logger = logger ?? null;
  }

  publishInbound(message: InboundMessage) {
    this.inboundQueue.push(message);
  }

  publishOutbound(message: OutboundMessage) {
    this.outboundQueue.push(message);
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
    void this.runInboundLoop();
    void this.runOutboundLoop();
  }

  private async runInboundLoop() {
    while (this.running) {
      const message = await this.inboundQueue.next();
      for (const handler of this.inboundHandlers) {
        try {
          await handler(message);
        } catch (error) {
          if (this.logger) {
            this.logger.error({ error }, "Inbound handler error");
          } else {
            console.error("Inbound handler error:", error);
          }
        }
      }
    }
  }

  private async runOutboundLoop() {
    while (this.running) {
      const message = await this.outboundQueue.next();
      for (const handler of this.outboundHandlers) {
        try {
          await handler(message);
        } catch (error) {
          if (this.logger) {
            this.logger.error({ error }, "Outbound handler error");
          } else {
            console.error("Outbound handler error:", error);
          }
        }
      }
    }
  }
}
