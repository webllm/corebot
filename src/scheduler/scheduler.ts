import type { MessageBus } from "../bus/bus.js";
import type { SqliteStorage } from "../storage/sqlite.js";
import type { Config } from "../config/schema.js";
import type { Logger } from "pino";
import { nowIso } from "../util/time.js";
import { newId } from "../util/ids.js";
import { computeNextRun } from "./utils.js";
import type { RuntimeTelemetry } from "../observability/telemetry.js";

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private storage: SqliteStorage,
    private bus: MessageBus,
    private logger: Logger,
    private config: Config,
    private telemetry?: RuntimeTelemetry
  ) {}

  start() {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.scheduler.tickMs);
    void this.tick();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning() {
    return this.timer !== null;
  }

  private async tick() {
    const now = new Date();
    const due = this.storage.dueTasks(now.toISOString());
    if (due.length === 0) {
      return;
    }
    const delaysMs: number[] = [];
    for (const task of due) {
      const chat = this.storage.getChatById(task.chatFk);
      if (!chat) {
        this.logger.warn({ taskId: task.id }, "task chat missing");
        continue;
      }
      if (task.nextRunAt) {
        const delay = Math.max(0, now.getTime() - new Date(task.nextRunAt).getTime());
        delaysMs.push(delay);
      }
      const nextRunAt = computeNextRun(task, now);
      const status = task.scheduleType === "once" ? "done" : task.status;
      this.storage.updateTask(task.id, {
        nextRunAt: status === "done" ? null : nextRunAt,
        status
      });
      this.bus.publishInbound({
        id: newId(),
        channel: chat.channel,
        chatId: chat.chatId,
        senderId: "scheduler",
        content: task.prompt,
        createdAt: nowIso(),
        metadata: {
          isScheduledTask: true,
          taskId: task.id,
          contextMode: task.contextMode,
          chatFk: task.chatFk
        }
      });
    }
    this.telemetry?.recordSchedulerDispatch(delaysMs);
    this.logger.info({ count: due.length }, "scheduler tick dispatched");
  }
}
