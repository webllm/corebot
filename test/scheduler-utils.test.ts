import test from "node:test";
import assert from "node:assert/strict";
import { computeNextRun } from "../src/scheduler/utils.js";

test("computeNextRun handles interval tasks", () => {
  const now = new Date("2026-02-06T00:00:00.000Z");
  const next = computeNextRun(
    {
      scheduleType: "interval",
      scheduleValue: "1500",
      nextRunAt: null,
      status: "active"
    },
    now
  );
  assert.equal(next, "2026-02-06T00:00:01.500Z");
});

test("computeNextRun handles once tasks", () => {
  const now = new Date("2026-02-06T00:00:00.000Z");
  const next = computeNextRun(
    {
      scheduleType: "once",
      scheduleValue: "2026-02-06T00:02:00.000Z",
      nextRunAt: null,
      status: "active"
    },
    now
  );
  assert.equal(next, "2026-02-06T00:02:00.000Z");
});

test("computeNextRun handles cron tasks", () => {
  const now = new Date("2026-02-06T00:00:00.000Z");
  const next = computeNextRun(
    {
      scheduleType: "cron",
      scheduleValue: "*/5 * * * *",
      nextRunAt: null,
      status: "active"
    },
    now
  );
  assert.equal(next, "2026-02-06T00:05:00.000Z");
});
