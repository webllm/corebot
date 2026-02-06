import cronParser from "cron-parser";
import type { TaskRecord } from "../types.js";

export const computeNextRun = (
  task: Pick<TaskRecord, "scheduleType" | "scheduleValue" | "nextRunAt" | "status">,
  fromDate: Date
): string | null => {
  if (task.status !== "active") {
    return null;
  }
  if (task.scheduleType === "interval") {
    const ms = Number(task.scheduleValue);
    if (!Number.isFinite(ms) || ms <= 0) {
      return null;
    }
    return new Date(fromDate.getTime() + ms).toISOString();
  }
  if (task.scheduleType === "once") {
    const target = new Date(task.scheduleValue);
    if (Number.isNaN(target.getTime())) {
      return null;
    }
    if (target.getTime() <= fromDate.getTime()) {
      return null;
    }
    return target.toISOString();
  }
  try {
    const interval = cronParser.parseExpression(task.scheduleValue, { currentDate: fromDate });
    const next = interval.next();
    return next.toDate().toISOString();
  } catch {
    return null;
  }
};
