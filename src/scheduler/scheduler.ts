import type { MessageBus } from "../bus/bus.js";
import type { SqliteStorage } from "../storage/sqlite.js";
import type { Config } from "../config/schema.js";
import type { Logger } from "pino";
import { newId } from "../util/ids.js";
import { computeNextRun } from "./utils.js";
import type { RuntimeTelemetry } from "../observability/telemetry.js";

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private tickInFlight = false;

  constructor(
    private storage: SqliteStorage,
    private bus: MessageBus,
    private logger: Logger,
    private config: Config,
    private telemetry?: RuntimeTelemetry,
    private wakeHeartbeat?: (reason: string) => void
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
    if (this.tickInFlight) {
      this.logger.debug("scheduler tick skipped; previous tick still running");
      return;
    }

    this.tickInFlight = true;
    try {
      const now = new Date();
      const dueBefore = now.toISOString();
      const due = this.storage.dueTasks(dueBefore);
      if (due.length === 0) {
        return;
      }

      const delayByTask = new Map<string, number>();
      const plans: Array<{
        taskId: string;
        nextRunAt: string | null;
        status: "active" | "paused" | "done";
        inbound: {
          id: string;
          channel: string;
          chatId: string;
          senderId: string;
          content: string;
          createdAt: string;
          metadata: Record<string, unknown>;
        };
      }> = [];

      for (const task of due) {
        const chat = this.storage.getChatById(task.chatFk);
        if (!chat) {
          this.logger.warn({ taskId: task.id }, "task chat missing");
          continue;
        }

        if (task.nextRunAt) {
          const delay = Math.max(0, now.getTime() - new Date(task.nextRunAt).getTime());
          delayByTask.set(task.id, delay);
        }

        const nextRunAt = computeNextRun(task, now);
        const status = task.scheduleType === "once" ? "done" : task.status;

        plans.push({
          taskId: task.id,
          nextRunAt: status === "done" ? null : nextRunAt,
          status,
          inbound: {
            id: newId(),
            channel: chat.channel,
            chatId: chat.chatId,
            senderId: "scheduler",
            content: task.prompt,
            createdAt: dueBefore,
            metadata: {
              isScheduledTask: true,
              taskId: task.id,
              contextMode: task.contextMode,
              chatFk: task.chatFk
            }
          }
        });
      }

      if (plans.length === 0) {
        return;
      }

      const dispatched = this.storage.dispatchScheduledTasks({
        dueBefore,
        maxAttempts: this.config.bus.maxAttempts,
        items: plans
      });
      if (dispatched.dispatched === 0) {
        return;
      }

      const delaysMs = dispatched.taskIds
        .map((taskId) => delayByTask.get(taskId))
        .filter((delay): delay is number => typeof delay === "number");
      this.telemetry?.recordSchedulerDispatch(delaysMs);

      this.bus.wakeInbound();
      this.wakeHeartbeat?.("scheduler:dispatch");
      this.logger.info(
        {
          dueCount: due.length,
          plannedCount: plans.length,
          dispatchedCount: dispatched.dispatched
        },
        "scheduler tick dispatched"
      );
    } finally {
      this.tickInFlight = false;
    }
  }
}
