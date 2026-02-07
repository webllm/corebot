import Database from "better-sqlite3";
import type { Config } from "../config/schema.js";
import { migrations } from "./migrations.js";
import type {
  BusMessageDirection,
  BusQueueRecord,
  ChatRecord,
  ConversationState,
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
    for (const migration of migrations) {
      this.db.exec(migration.sql);
    }
    this.db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)")
      .run(String(migrations[migrations.length - 1]?.id ?? 0));
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
  }): string {
    const id = newId();
    const now = nowIso();
    this.db
      .prepare(
        "INSERT INTO message_queue(id, direction, payload, status, attempts, max_attempts, available_at, created_at, updated_at, claimed_at, processed_at, dead_lettered_at, last_error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        id,
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
    return id;
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
      .get(channel, chatId) as ChatRecord | undefined;
    return row ?? null;
  }

  getChatById(id: string): ChatRecord | null {
    const row = this.db
      .prepare("SELECT * FROM chats WHERE id = ?")
      .get(id) as ChatRecord | undefined;
    return row ?? null;
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
    chatFk: string;
    senderId: string;
    role: string;
    content: string;
    stored: boolean;
    createdAt?: string;
  }) {
    this.db
      .prepare(
        "INSERT INTO messages(id, chat_fk, sender_id, role, content, created_at, stored) VALUES(?,?,?,?,?,?,?)"
      )
      .run(
        newId(),
        params.chatFk,
        params.senderId,
        params.role,
        params.stored ? params.content : "",
        params.createdAt ?? nowIso(),
        params.stored ? 1 : 0
      );
    this.db
      .prepare("UPDATE chats SET last_message_at = ? WHERE id = ?")
      .run(params.createdAt ?? nowIso(), params.chatFk);
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

  logTaskRun(params: {
    taskFk: string;
    runAt: string;
    durationMs: number;
    status: "success" | "error";
    resultPreview?: string;
    error?: string;
  }) {
    this.db
      .prepare(
        "INSERT INTO task_runs(task_fk, run_at, duration_ms, status, result_preview, error) VALUES(?,?,?,?,?,?)"
      )
      .run(
        params.taskFk,
        params.runAt,
        params.durationMs,
        params.status,
        params.resultPreview ?? null,
        params.error ?? null
      );
  }

  close() {
    this.db.close();
  }
}
