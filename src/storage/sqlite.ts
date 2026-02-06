import Database from "better-sqlite3";
import type { Config } from "../config/schema.js";
import { migrations } from "./migrations.js";
import type { ChatRecord, ConversationState, TaskRecord } from "../types.js";
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
