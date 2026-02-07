import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { SqliteStorage } from "../src/storage/sqlite.js";
import { createConfig } from "./test-utils.js";

test("db backup and restore scripts create snapshot and restore database", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corebot-dbops-"));
  const workspaceDir = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, "memory"), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, "skills"), { recursive: true });

  const config = createConfig(workspaceDir, dataDir);
  const dbPath = config.sqlitePath;
  const backupPath = path.join(dataDir, "backups", "manual-test.sqlite");

  try {
    const storage = new SqliteStorage(config);
    storage.init();
    const chat = storage.upsertChat({ channel: "cli", chatId: "dbops" });
    storage.setChatRegistered(chat.id, true);
    storage.close();

    execFileSync(
      "pnpm",
      ["exec", "tsx", "scripts/db-backup.ts", "--db", dbPath, "--out", backupPath],
      { cwd: process.cwd(), stdio: "pipe" }
    );
    assert.equal(fs.existsSync(backupPath), true);

    fs.writeFileSync(dbPath, "corrupted", "utf-8");
    execFileSync(
      "pnpm",
      ["exec", "tsx", "scripts/db-restore.ts", "--db", dbPath, "--from", backupPath, "--force"],
      { cwd: process.cwd(), stdio: "pipe" }
    );

    const restored = new SqliteStorage(config);
    restored.init();
    const recovered = restored.getChat("cli", "dbops");
    assert.ok(recovered);
    restored.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
