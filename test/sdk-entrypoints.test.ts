import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createCorebotApp, main } from "../src/index.js";
import { createStorageFixture } from "./test-utils.js";

const logger = {
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  child: () => logger
} as any;

test("SDK entrypoint exports callable main function", () => {
  assert.equal(typeof main, "function");
});

test("createCorebotApp supports lifecycle start/stop for embedded usage", async () => {
  const fixture = createStorageFixture({
    cli: { enabled: false },
    webhook: { enabled: false },
    observability: {
      enabled: false,
      http: { enabled: false }
    }
  });

  const app = await createCorebotApp({
    config: fixture.config,
    logger
  });

  try {
    assert.equal(app.isRunning(), false);
    await app.start();
    assert.equal(app.isRunning(), true);
    assert.equal(app.bus.isRunning(), true);
    assert.equal(app.scheduler.isRunning(), true);
    await app.stop();
    assert.equal(app.isRunning(), false);
  } finally {
    if (app.isRunning()) {
      await app.stop();
    }
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});
