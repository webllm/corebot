import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Config } from "../config/schema.js";
import { migrations } from "./migrations.js";
import type {
  BusMessageDirection,
  BusQueueRecord,
  ChatRecord,
  ConversationState,
  InboundMessage,
  TaskRunRecord,
  TaskRecord
} from "../types.js";
import { nowIso } from "../util/time.js";
import { newId } from "../util/ids.js";

export class SqliteStorage {
  private db: Database.Database;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.db = new Database(config.sqlitePath);
    this.db.pragma("journal_mode = WAL");
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS migration_history (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        error TEXT,
        backup_path TEXT
      );
    `);

    const currentVersion =
      Number(
        (this.db
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value?: string } | undefined)?.value ?? "0"
      ) || 0;

    const pending = migrations
      .slice()
      .sort((a, b) => a.id - b.id)
      .filter((migration) => migration.id > currentVersion);

    if (pending.length === 0) {
      const latest = migrations[migrations.length - 1]?.id ?? 0;
      this.setMeta("schema_version", String(Math.max(currentVersion, latest)));
      return;
    }

    const backupPath = this.createPreMigrationBackup(currentVersion);

    for (const migration of pending) {
      const applyMigration = this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .prepare(
            "INSERT INTO migration_history(id, status, applied_at, error, backup_path) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, applied_at=excluded.applied_at, error=excluded.error, backup_path=excluded.backup_path"
          )
          .run(migration.id, "applied", nowIso(), null, backupPath);
        this.setMeta("schema_version", String(migration.id));
      });
      try {
        applyMigration();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.db
          .prepare(
            "INSERT INTO migration_history(id, status, applied_at, error, backup_path) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, applied_at=excluded.applied_at, error=excluded.error, backup_path=excluded.backup_path"
          )
          .run(migration.id, "failed", nowIso(), message, backupPath);
        this.setMeta("schema_last_failed_migration", String(migration.id));
        this.setMeta("schema_last_failure_at", nowIso());
        throw new Error(
          backupPath
            ? `Migration ${migration.id} failed: ${message}. Restore backup: ${backupPath}`
            : `Migration ${migration.id} failed: ${message}.`
        );
      }
    }

    const latest = migrations[migrations.length - 1]?.id ?? 0;
    this.setMeta("schema_version", String(latest));
    this.setMeta("schema_last_migrated_at", nowIso());
    this.db
      .prepare("DELETE FROM meta WHERE key IN ('schema_last_failed_migration', 'schema_last_failure_at')")
      .run();
  }

  private getMeta(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string) {
    this.db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)")
      .run(key, value);
  }

  private createPreMigrationBackup(currentVersion: number): string | null {
    const sqlitePath = path.resolve(this.config.sqlitePath);
    if (!fs.existsSync(sqlitePath)) {
      return null;
    }

    const backupDir = path.resolve(this.config.dataDir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = nowIso().replace(/[:.]/g, "-");
    const backupPath = path.join(backupDir, `pre-migration-v${currentVersion}-${stamp}.sqlite`);
    const escaped = backupPath.replace(/'/g, "''");

    this.db.exec(`VACUUM main INTO '${escaped}'`);
    return backupPath;
  }

  isAdminBootstrapUsed(): boolean {
    return this.getMeta("admin_bootstrap_used") === "1";
  }

  setAdminBootstrapUsed(used: boolean) {
    this.setMeta("admin_bootstrap_used", used ? "1" : "0");
  }

  getAdminBootstrapSecurityState(): {
    failedAttempts: number;
    lockUntil: string | null;
  } {
    const failedRaw = this.getMeta("admin_bootstrap_failed_attempts");
    const failedAttempts = failedRaw ? Number(failedRaw) : 0;
    const lockUntilRaw = this.getMeta("admin_bootstrap_lock_until");
    const lockUntil =
      lockUntilRaw && !Number.isNaN(new Date(lockUntilRaw).getTime()) ? lockUntilRaw : null;
    return {
      failedAttempts: Number.isFinite(failedAttempts) && failedAttempts > 0 ? failedAttempts : 0,
      lockUntil
    };
  }

  setAdminBootstrapSecurityState(state: { failedAttempts: number; lockUntil: string | null }) {
    this.setMeta(
      "admin_bootstrap_failed_attempts",
      String(Math.max(0, Math.trunc(state.failedAttempts)))
    );
    if (state.lockUntil) {
      this.setMeta("admin_bootstrap_lock_until", state.lockUntil);
      return;
    }
    this.db.prepare("DELETE FROM meta WHERE key = ?").run("admin_bootstrap_lock_until");
  }

  enqueueBusMessage(params: {
    direction: BusMessageDirection;
    payload: unknown;
    maxAttempts: number;
    availableAt?: string;
    idempotencyKey?: string;
  }): { queueId: string; inserted: boolean; status: BusQueueRecord["status"] } {
    const now = nowIso();
    const idempotencyKey = params.idempotencyKey?.trim() || undefined;

    const insertQueueRecord = (queueId: string) => {
      this.db
        .prepare(
          "INSERT INTO message_queue(id, direction, payload, status, attempts, max_attempts, available_at, created_at, updated_at, claimed_at, processed_at, dead_lettered_at, last_error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"
        )
        .run(
          queueId,
          params.direction,
          JSON.stringify(params.payload),
          "pending",
          0,
          params.maxAttempts,
          params.availableAt ?? now,
          now,
          now,
          null,
          null,
          null,
          null
        );
    };

    if (!idempotencyKey) {
      const queueId = newId();
      insertQueueRecord(queueId);
      return {
        queueId,
        inserted: true,
        status: "pending"
      };
    }

    const loadExisting = () =>
      this.db
        .prepare(
          "SELECT mq.id, mq.status FROM message_dedupe md JOIN message_queue mq ON mq.id = md.queue_id WHERE md.direction = ? AND md.idempotency_key = ?"
        )
        .get(params.direction, idempotencyKey) as
        | { id: string; status: string }
        | undefined;

    const existing = loadExisting();
    if (existing) {
      return {
        queueId: existing.id,
        inserted: false,
        status: existing.status as BusQueueRecord["status"]
      };
    }

    const insertWithDedupe = this.db.transaction(() => {
      const queueId = newId();
      insertQueueRecord(queueId);
      this.db
        .prepare(
          "INSERT INTO message_dedupe(direction, idempotency_key, queue_id, created_at) VALUES(?,?,?,?)"
        )
        .run(params.direction, idempotencyKey, queueId, now);
      return queueId;
    });

    try {
      const queueId = insertWithDedupe();
      return {
        queueId,
        inserted: true,
        status: "pending"
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("UNIQUE constraint failed")) {
        throw error;
      }
      const conflict = loadExisting();
      if (!conflict) {
        throw error;
      }
      return {
        queueId: conflict.id,
        inserted: false,
        status: conflict.status as BusQueueRecord["status"]
      };
    }
  }

  startInboundExecution(params: {
    channel: string;
    chatId: string;
    inboundId: string;
    now: string;
    staleBefore: string;
  }):
    | { state: "started" }
    | { state: "running" }
    | { state: "completed"; responseContent: string; toolMessagesJson: string } {
    const inserted = this.db
      .prepare(
        "INSERT INTO inbound_executions(channel, chat_id, inbound_id, status, response_content, tool_messages_json, started_at, updated_at, completed_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(channel, chat_id, inbound_id) DO NOTHING"
      )
      .run(
        params.channel,
        params.chatId,
        params.inboundId,
        "running",
        null,
        null,
        params.now,
        params.now,
        null
      );
    if (inserted.changes > 0) {
      return { state: "started" };
    }

    const row = this.db
      .prepare(
        "SELECT status, response_content, tool_messages_json, updated_at FROM inbound_executions WHERE channel = ? AND chat_id = ? AND inbound_id = ?"
      )
      .get(params.channel, params.chatId, params.inboundId) as
      | {
          status: string;
          response_content: string | null;
          tool_messages_json: string | null;
          updated_at: string;
        }
      | undefined;
    if (!row) {
      return { state: "started" };
    }

    if (row.status === "completed") {
      return {
        state: "completed",
        responseContent: row.response_content ?? "",
        toolMessagesJson: row.tool_messages_json ?? "[]"
      };
    }

    if (row.status === "running" && row.updated_at <= params.staleBefore) {
      const claimed = this.db
        .prepare(
          "UPDATE inbound_executions SET status = 'running', response_content = NULL, tool_messages_json = NULL, started_at = ?, updated_at = ?, completed_at = NULL WHERE channel = ? AND chat_id = ? AND inbound_id = ? AND status = 'running' AND updated_at <= ?"
        )
        .run(
          params.now,
          params.now,
          params.channel,
          params.chatId,
          params.inboundId,
          params.staleBefore
        );
      if (claimed.changes > 0) {
        return { state: "started" };
      }
    }

    return { state: "running" };
  }

  completeInboundExecution(params: {
    channel: string;
    chatId: string;
    inboundId: string;
    responseContent: string;
    toolMessagesJson: string;
    completedAt: string;
  }) {
    this.db
      .prepare(
        "UPDATE inbound_executions SET status = 'completed', response_content = ?, tool_messages_json = ?, completed_at = ?, updated_at = ? WHERE channel = ? AND chat_id = ? AND inbound_id = ?"
      )
      .run(
        params.responseContent,
        params.toolMessagesJson,
        params.completedAt,
        params.completedAt,
        params.channel,
        params.chatId,
        params.inboundId
      );
  }

  listDueBusMessages(
    direction: BusMessageDirection,
    now: string,
    limit: number
  ): BusQueueRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM message_queue WHERE direction = ? AND status = 'pending' AND available_at <= ? ORDER BY created_at ASC LIMIT ?"
      )
      .all(direction, now, limit) as Array<{
      id: string;
      direction: string;
      payload: string;
      status: string;
      attempts: number;
      max_attempts: number;
      available_at: string;
      created_at: string;
      updated_at: string;
      claimed_at: string | null;
      processed_at: string | null;
      dead_lettered_at: string | null;
      last_error: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      direction: row.direction as BusQueueRecord["direction"],
      payload: row.payload,
      status: row.status as BusQueueRecord["status"],
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      availableAt: row.available_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      claimedAt: row.claimed_at,
      processedAt: row.processed_at,
      deadLetteredAt: row.dead_lettered_at,
      lastError: row.last_error
    }));
  }

  claimBusMessage(id: string, claimedAt: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE message_queue SET status = 'processing', claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'"
      )
      .run(claimedAt, claimedAt, id);
    return result.changes > 0;
  }

  markBusMessageProcessed(id: string, processedAt: string) {
    this.db
      .prepare(
        "UPDATE message_queue SET status = 'processed', processed_at = ?, updated_at = ?, claimed_at = NULL WHERE id = ?"
      )
      .run(processedAt, processedAt, id);
  }

  markBusMessageRetry(params: {
    id: string;
    attempts: number;
    availableAt: string;
    error: string;
    updatedAt: string;
  }) {
    this.db
      .prepare(
        "UPDATE message_queue SET status = 'pending', attempts = ?, available_at = ?, last_error = ?, updated_at = ?, claimed_at = NULL WHERE id = ?"
      )
      .run(params.attempts, params.availableAt, params.error, params.updatedAt, params.id);
  }

  markBusMessageDeadLetter(params: {
    id: string;
    attempts: number;
    error: string;
    deadLetteredAt: string;
  }) {
    this.db
      .prepare(
        "UPDATE message_queue SET status = 'dead_letter', attempts = ?, last_error = ?, dead_lettered_at = ?, updated_at = ?, claimed_at = NULL WHERE id = ?"
      )
      .run(
        params.attempts,
        params.error,
        params.deadLetteredAt,
        params.deadLetteredAt,
        params.id
      );
  }

  recoverStaleProcessingBusMessages(params: {
    staleBefore: string;
    now: string;
    retryBackoffMs: number;
  }): { requeued: number; deadLettered: number } {
    const staleRows = this.db
      .prepare(
        "SELECT id, attempts, max_attempts FROM message_queue WHERE status = 'processing' AND claimed_at IS NOT NULL AND claimed_at <= ?"
      )
      .all(params.staleBefore) as Array<{
      id: string;
      attempts: number;
      max_attempts: number;
    }>;

    let requeued = 0;
    let deadLettered = 0;

    for (const row of staleRows) {
      const nextAttempts = row.attempts + 1;
      if (nextAttempts >= row.max_attempts) {
        this.markBusMessageDeadLetter({
          id: row.id,
          attempts: nextAttempts,
          error: "Recovered stale processing message exceeded max attempts.",
          deadLetteredAt: params.now
        });
        deadLettered += 1;
      } else {
        const availableAt = new Date(
          new Date(params.now).getTime() + params.retryBackoffMs
        ).toISOString();
        this.markBusMessageRetry({
          id: row.id,
          attempts: nextAttempts,
          availableAt,
          error: "Recovered stale processing message; requeued.",
          updatedAt: params.now
        });
        requeued += 1;
      }
    }

    return { requeued, deadLettered };
  }

  countBusMessagesByStatus(direction?: BusMessageDirection) {
    const rows = (direction
      ? this.db
          .prepare(
            "SELECT status, COUNT(*) as count FROM message_queue WHERE direction = ? GROUP BY status"
          )
          .all(direction)
      : this.db
          .prepare("SELECT status, COUNT(*) as count FROM message_queue GROUP BY status")
          .all()) as Array<{ status: string; count: number }>;
    const counts = {
      pending: 0,
      processing: 0,
      processed: 0,
      dead_letter: 0
    };
    for (const row of rows) {
      if (row.status in counts) {
        counts[row.status as keyof typeof counts] = row.count;
      }
    }
    return counts;
  }

  listDeadLetterBusMessages(direction?: BusMessageDirection, limit = 100): BusQueueRecord[] {
    const rows = (direction
      ? this.db
          .prepare(
            "SELECT * FROM message_queue WHERE status = 'dead_letter' AND direction = ? ORDER BY dead_lettered_at DESC LIMIT ?"
          )
          .all(direction, limit)
      : this.db
          .prepare(
            "SELECT * FROM message_queue WHERE status = 'dead_letter' ORDER BY dead_lettered_at DESC LIMIT ?"
          )
          .all(limit)) as Array<{
      id: string;
      direction: string;
      payload: string;
      status: string;
      attempts: number;
      max_attempts: number;
      available_at: string;
      created_at: string;
      updated_at: string;
      claimed_at: string | null;
      processed_at: string | null;
      dead_lettered_at: string | null;
      last_error: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      direction: row.direction as BusQueueRecord["direction"],
      payload: row.payload,
      status: row.status as BusQueueRecord["status"],
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      availableAt: row.available_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      claimedAt: row.claimed_at,
      processedAt: row.processed_at,
      deadLetteredAt: row.dead_lettered_at,
      lastError: row.last_error
    }));
  }

  listMigrationHistory(limit = 50): Array<{
    id: number;
    status: string;
    appliedAt: string;
    error: string | null;
    backupPath: string | null;
  }> {
    const rows = this.db
      .prepare(
        "SELECT id, status, applied_at, error, backup_path FROM migration_history ORDER BY id DESC LIMIT ?"
      )
      .all(limit) as Array<{
      id: number;
      status: string;
      applied_at: string;
      error: string | null;
      backup_path: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      appliedAt: row.applied_at,
      error: row.error,
      backupPath: row.backup_path
    }));
  }

  insertAuditEvent(params: {
    at: string;
    eventType: string;
    toolName?: string;
    chatFk?: string;
    channel?: string;
    chatId?: string;
    actorRole?: string;
    outcome: string;
    reason?: string;
    argsJson?: string;
    metadataJson?: string;
  }) {
    this.db
      .prepare(
        "INSERT INTO audit_events(at, event_type, tool_name, chat_fk, channel, chat_id, actor_role, outcome, reason, args_json, metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        params.at,
        params.eventType,
        params.toolName ?? null,
        params.chatFk ?? null,
        params.channel ?? null,
        params.chatId ?? null,
        params.actorRole ?? null,
        params.outcome,
        params.reason ?? null,
        params.argsJson ?? null,
        params.metadataJson ?? null
      );
  }

  listAuditEvents(limit = 100, eventType?: string): Array<{
    id: number;
    at: string;
    eventType: string;
    toolName: string | null;
    chatFk: string | null;
    channel: string | null;
    chatId: string | null;
    actorRole: string | null;
    outcome: string;
    reason: string | null;
    argsJson: string | null;
    metadataJson: string | null;
  }> {
    const rows = (eventType
      ? this.db
          .prepare(
            "SELECT * FROM audit_events WHERE event_type = ? ORDER BY at DESC, id DESC LIMIT ?"
          )
          .all(eventType, limit)
      : this.db
          .prepare("SELECT * FROM audit_events ORDER BY at DESC, id DESC LIMIT ?")
          .all(limit)) as Array<{
      id: number;
      at: string;
      event_type: string;
      tool_name: string | null;
      chat_fk: string | null;
      channel: string | null;
      chat_id: string | null;
      actor_role: string | null;
      outcome: string;
      reason: string | null;
      args_json: string | null;
      metadata_json: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      eventType: row.event_type,
      toolName: row.tool_name,
      chatFk: row.chat_fk,
      channel: row.channel,
      chatId: row.chat_id,
      actorRole: row.actor_role,
      outcome: row.outcome,
      reason: row.reason,
      argsJson: row.args_json,
      metadataJson: row.metadata_json
    }));
  }

  hasRecentHeartbeatDelivery(params: {
    chatFk: string;
    contentHash: string;
    since: string;
  }): boolean {
    const row = this.db
      .prepare(
        "SELECT id FROM audit_events WHERE event_type = 'heartbeat.delivery' AND chat_fk = ? AND reason = ? AND outcome = 'sent' AND at >= ? ORDER BY at DESC LIMIT 1"
      )
      .get(params.chatFk, params.contentHash, params.since) as { id: number } | undefined;
    return Boolean(row?.id);
  }

  replayDeadLetterBusMessage(params: {
    id: string;
    now: string;
    reason?: string;
  }): { id: string; direction: BusMessageDirection } | null {
    const row = this.db
      .prepare(
        "SELECT id, direction FROM message_queue WHERE id = ? AND status = 'dead_letter'"
      )
      .get(params.id) as { id: string; direction: string } | undefined;
    if (!row) {
      return null;
    }

    const result = this.db
      .prepare(
        "UPDATE message_queue SET status = 'pending', attempts = 0, available_at = ?, updated_at = ?, claimed_at = NULL, processed_at = NULL, dead_lettered_at = NULL, last_error = ? WHERE id = ? AND status = 'dead_letter'"
      )
      .run(
        params.now,
        params.now,
        params.reason ?? "Replayed from dead-letter queue.",
        params.id
      );
    if (result.changes <= 0) {
      return null;
    }
    return {
      id: row.id,
      direction: row.direction as BusMessageDirection
    };
  }

  replayDeadLetterBusMessages(params: {
    direction?: BusMessageDirection;
    limit: number;
    now: string;
    reason?: string;
  }): Array<{ id: string; direction: BusMessageDirection }> {
    const rows = (params.direction
      ? this.db
          .prepare(
            "SELECT id, direction FROM message_queue WHERE status = 'dead_letter' AND direction = ? ORDER BY dead_lettered_at DESC LIMIT ?"
          )
          .all(params.direction, params.limit)
      : this.db
          .prepare(
            "SELECT id, direction FROM message_queue WHERE status = 'dead_letter' ORDER BY dead_lettered_at DESC LIMIT ?"
          )
          .all(params.limit)) as Array<{ id: string; direction: string }>;

    if (rows.length === 0) {
      return [];
    }

    const replayed: Array<{ id: string; direction: BusMessageDirection }> = [];
    for (const row of rows) {
      const result = this.db
        .prepare(
          "UPDATE message_queue SET status = 'pending', attempts = 0, available_at = ?, updated_at = ?, claimed_at = NULL, processed_at = NULL, dead_lettered_at = NULL, last_error = ? WHERE id = ? AND status = 'dead_letter'"
        )
        .run(
          params.now,
          params.now,
          params.reason ?? "Replayed from dead-letter queue.",
          row.id
        );
      if (result.changes > 0) {
        replayed.push({
          id: row.id,
          direction: row.direction as BusMessageDirection
        });
      }
    }

    return replayed;
  }

  upsertChat(params: {
    channel: string;
    chatId: string;
    displayName?: string | null;
  }): ChatRecord {
    const existing = this.getChat(params.channel, params.chatId);
    if (existing) {
      if (params.displayName && params.displayName !== existing.displayName) {
        this.db
          .prepare("UPDATE chats SET display_name = ? WHERE id = ?")
          .run(params.displayName, existing.id);
      }
      return existing;
    }
    const id = newId();
    this.db
      .prepare(
        "INSERT INTO chats(id, channel, chat_id, display_name, last_message_at, role, registered) VALUES(?,?,?,?,?,?,?)"
      )
      .run(
        id,
        params.channel,
        params.chatId,
        params.displayName ?? null,
        nowIso(),
        "normal",
        0
      );
    return this.getChatById(id)!;
  }

  getChat(channel: string, chatId: string): ChatRecord | null {
    const row = this.db
      .prepare("SELECT * FROM chats WHERE channel = ? AND chat_id = ?")
      .get(channel, chatId) as
      | {
          id: string;
          channel: string;
          chat_id: string;
          display_name: string | null;
          last_message_at: string | null;
          role: "admin" | "normal";
          registered: number;
        }
      | undefined;
    return row ? this.mapChatRow(row) : null;
  }

  getChatById(id: string): ChatRecord | null {
    const row = this.db
      .prepare("SELECT * FROM chats WHERE id = ?")
      .get(id) as
      | {
          id: string;
          channel: string;
          chat_id: string;
          display_name: string | null;
          last_message_at: string | null;
          role: "admin" | "normal";
          registered: number;
        }
      | undefined;
    return row ? this.mapChatRow(row) : null;
  }

  listChats(limit = 500): ChatRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM chats ORDER BY COALESCE(last_message_at, id) DESC LIMIT ?")
      .all(limit) as Array<{
      id: string;
      channel: string;
      chat_id: string;
      display_name: string | null;
      last_message_at: string | null;
      role: "admin" | "normal";
      registered: number;
    }>;
    return rows.map((row) => this.mapChatRow(row));
  }

  setChatRole(chatFk: string, role: "admin" | "normal") {
    this.db.prepare("UPDATE chats SET role = ? WHERE id = ?").run(role, chatFk);
  }

  setChatRegistered(chatFk: string, registered: boolean) {
    this.db
      .prepare("UPDATE chats SET registered = ? WHERE id = ?")
      .run(registered ? 1 : 0, chatFk);
  }

  insertMessage(params: {
    id?: string;
    chatFk: string;
    senderId: string;
    role: string;
    content: string;
    stored: boolean;
    createdAt?: string;
  }) {
    const messageId = params.id ?? newId();
    const createdAt = params.createdAt ?? nowIso();
    const inserted = this.db
      .prepare(
        "INSERT OR IGNORE INTO messages(id, chat_fk, sender_id, role, content, created_at, stored) VALUES(?,?,?,?,?,?,?)"
      )
      .run(
        messageId,
        params.chatFk,
        params.senderId,
        params.role,
        params.stored ? params.content : "",
        createdAt,
        params.stored ? 1 : 0
      );
    if (inserted.changes > 0) {
      this.db
        .prepare("UPDATE chats SET last_message_at = ? WHERE id = ?")
        .run(createdAt, params.chatFk);
    }
  }

  listRecentMessages(chatFk: string, limit: number) {
    const rows = this.db
      .prepare(
        "SELECT * FROM messages WHERE chat_fk = ? AND stored = 1 ORDER BY created_at DESC LIMIT ?"
      )
      .all(chatFk, limit) as Array<{
      id: string;
      chat_fk: string;
      sender_id: string;
      role: string;
      content: string;
      created_at: string;
      stored: number;
    }>;
    return rows.reverse();
  }

  countMessages(chatFk: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM messages WHERE chat_fk = ? AND stored = 1")
      .get(chatFk) as { count: number };
    return row?.count ?? 0;
  }

  pruneMessages(chatFk: string, keep: number) {
    const rows = this.db
      .prepare(
        "SELECT id FROM messages WHERE chat_fk = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?"
      )
      .all(chatFk, keep) as Array<{ id: string }>;
    if (rows.length === 0) {
      return;
    }
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(",");
    this.db
      .prepare(`DELETE FROM messages WHERE id IN (${placeholders})`)
      .run(...ids);
  }

  getConversationState(chatFk: string): ConversationState {
    const row = this.db
      .prepare("SELECT * FROM conversation_state WHERE chat_fk = ?")
      .get(chatFk) as
      | {
          chat_fk: string;
          summary: string;
          enabled_skills_json: string;
          last_compact_at: string | null;
        }
      | undefined;
    if (!row) {
      return {
        chatFk,
        summary: "",
        enabledSkills: [],
        lastCompactAt: null
      };
    }
    return {
      chatFk: row.chat_fk,
      summary: row.summary ?? "",
      enabledSkills: JSON.parse(row.enabled_skills_json ?? "[]") as string[],
      lastCompactAt: row.last_compact_at ?? null
    };
  }

  setConversationState(state: ConversationState) {
    this.db
      .prepare(
        "INSERT INTO conversation_state(chat_fk, summary, enabled_skills_json, last_compact_at) VALUES(?,?,?,?) ON CONFLICT(chat_fk) DO UPDATE SET summary=excluded.summary, enabled_skills_json=excluded.enabled_skills_json, last_compact_at=excluded.last_compact_at"
      )
      .run(
        state.chatFk,
        state.summary,
        JSON.stringify(state.enabledSkills),
        state.lastCompactAt
      );
  }

  createTask(task: Omit<TaskRecord, "id" | "createdAt" | "nextRunAt" | "status"> & {
    nextRunAt: string | null;
    status?: TaskRecord["status"];
  }): TaskRecord {
    const record: TaskRecord = {
      id: newId(),
      chatFk: task.chatFk,
      prompt: task.prompt,
      scheduleType: task.scheduleType,
      scheduleValue: task.scheduleValue,
      contextMode: task.contextMode,
      status: task.status ?? "active",
      nextRunAt: task.nextRunAt,
      createdAt: nowIso()
    };
    this.db
      .prepare(
        "INSERT INTO tasks(id, chat_fk, prompt, schedule_type, schedule_value, context_mode, status, next_run_at, created_at) VALUES(?,?,?,?,?,?,?,?,?)"
      )
      .run(
        record.id,
        record.chatFk,
        record.prompt,
        record.scheduleType,
        record.scheduleValue,
        record.contextMode,
        record.status,
        record.nextRunAt,
        record.createdAt
      );
    return record;
  }

  listTasks(chatFk?: string, includeInactive = true): TaskRecord[] {
    const rows = (chatFk
      ? this.db
          .prepare("SELECT * FROM tasks WHERE chat_fk = ?")
          .all(chatFk)
      : this.db.prepare("SELECT * FROM tasks").all()) as Array<{
      id: string;
      chat_fk: string;
      prompt: string;
      schedule_type: string;
      schedule_value: string;
      context_mode: string;
      status: string;
      next_run_at: string | null;
      created_at: string;
    }>;
    const mapped = rows.map((row) => ({
      id: row.id,
      chatFk: row.chat_fk,
      prompt: row.prompt,
      scheduleType: row.schedule_type as TaskRecord["scheduleType"],
      scheduleValue: row.schedule_value,
      contextMode: row.context_mode as TaskRecord["contextMode"],
      status: row.status as TaskRecord["status"],
      nextRunAt: row.next_run_at,
      createdAt: row.created_at
    }));
    return includeInactive
      ? mapped
      : mapped.filter((task) => task.status === "active");
  }

  countAdminChats(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM chats WHERE role = 'admin'")
      .get() as { count: number };
    return row?.count ?? 0;
  }

  updateTask(taskId: string, patch: Partial<TaskRecord>) {
    const existing = this.getTask(taskId);
    if (!existing) {
      return null;
    }
    const updated: TaskRecord = {
      ...existing,
      ...patch
    };
    this.db
      .prepare(
        "UPDATE tasks SET prompt = ?, schedule_type = ?, schedule_value = ?, context_mode = ?, status = ?, next_run_at = ? WHERE id = ?"
      )
      .run(
        updated.prompt,
        updated.scheduleType,
        updated.scheduleValue,
        updated.contextMode,
        updated.status,
        updated.nextRunAt,
        taskId
      );
    return updated;
  }

  getTask(taskId: string): TaskRecord | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(taskId) as
      | {
          id: string;
          chat_fk: string;
          prompt: string;
          schedule_type: string;
          schedule_value: string;
          context_mode: string;
          status: string;
          next_run_at: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      chatFk: row.chat_fk,
      prompt: row.prompt,
      scheduleType: row.schedule_type as TaskRecord["scheduleType"],
      scheduleValue: row.schedule_value,
      contextMode: row.context_mode as TaskRecord["contextMode"],
      status: row.status as TaskRecord["status"],
      nextRunAt: row.next_run_at,
      createdAt: row.created_at
    };
  }

  dueTasks(now: string): TaskRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?"
      )
      .all(now) as Array<{
      id: string;
      chat_fk: string;
      prompt: string;
      schedule_type: string;
      schedule_value: string;
      context_mode: string;
      status: string;
      next_run_at: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      chatFk: row.chat_fk,
      prompt: row.prompt,
      scheduleType: row.schedule_type as TaskRecord["scheduleType"],
      scheduleValue: row.schedule_value,
      contextMode: row.context_mode as TaskRecord["contextMode"],
      status: row.status as TaskRecord["status"],
      nextRunAt: row.next_run_at,
      createdAt: row.created_at
    }));
  }

  dispatchScheduledTasks(params: {
    dueBefore: string;
    maxAttempts: number;
    items: Array<{
      taskId: string;
      nextRunAt: string | null;
      status: TaskRecord["status"];
      inbound: InboundMessage;
    }>;
  }): { dispatched: number; taskIds: string[] } {
    const now = nowIso();

    const run = this.db.transaction(() => {
      const taskIds: string[] = [];
      const updateTask = this.db.prepare(
        "UPDATE tasks SET status = ?, next_run_at = ? WHERE id = ? AND status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?"
      );
      const insertQueue = this.db.prepare(
        "INSERT INTO message_queue(id, direction, payload, status, attempts, max_attempts, available_at, created_at, updated_at, claimed_at, processed_at, dead_lettered_at, last_error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"
      );

      for (const item of params.items) {
        const updated = updateTask.run(
          item.status,
          item.nextRunAt,
          item.taskId,
          params.dueBefore
        );
        if (updated.changes <= 0) {
          continue;
        }

        insertQueue.run(
          item.inbound.id,
          "inbound",
          JSON.stringify(item.inbound),
          "pending",
          0,
          params.maxAttempts,
          now,
          now,
          now,
          null,
          null,
          null,
          null
        );
        taskIds.push(item.taskId);
      }

      return {
        dispatched: taskIds.length,
        taskIds
      };
    });

    return run();
  }

  logTaskRun(params: {
    taskFk: string;
    inboundId?: string;
    runAt: string;
    durationMs: number;
    status: "success" | "error";
    resultPreview?: string;
    error?: string;
  }) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO task_runs(task_fk, inbound_id, run_at, duration_ms, status, result_preview, error) VALUES(?,?,?,?,?,?,?)"
      )
      .run(
        params.taskFk,
        params.inboundId ?? null,
        params.runAt,
        params.durationMs,
        params.status,
        params.resultPreview ?? null,
        params.error ?? null
      );
  }

  listTaskRuns(taskFk: string, limit = 50): TaskRunRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM task_runs WHERE task_fk = ? ORDER BY run_at DESC LIMIT ?"
      )
      .all(taskFk, limit) as Array<{
      id: number;
      task_fk: string;
      inbound_id: string | null;
      run_at: string;
      duration_ms: number;
      status: "success" | "error";
      result_preview: string | null;
      error: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      taskFk: row.task_fk,
      inboundId: row.inbound_id,
      runAt: row.run_at,
      durationMs: row.duration_ms,
      status: row.status,
      resultPreview: row.result_preview,
      error: row.error
    }));
  }

  close() {
    this.db.close();
  }

  private mapChatRow(row: {
    id: string;
    channel: string;
    chat_id: string;
    display_name: string | null;
    last_message_at: string | null;
    role: "admin" | "normal";
    registered: number;
  }): ChatRecord {
    return {
      id: row.id,
      channel: row.channel,
      chatId: row.chat_id,
      displayName: row.display_name,
      role: row.role,
      registered: row.registered === 1,
      lastMessageAt: row.last_message_at
    };
  }
}
