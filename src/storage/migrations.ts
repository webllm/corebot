export type Migration = {
  id: number;
  sql: string;
};

export const migrations: Migration[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        display_name TEXT,
        last_message_at TEXT,
        role TEXT NOT NULL DEFAULT 'normal',
        registered INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_chats_channel_chat_id ON chats(channel, chat_id);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_fk TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        created_at TEXT NOT NULL,
        stored INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_fk_created_at ON messages(chat_fk, created_at);

      CREATE TABLE IF NOT EXISTS conversation_state (
        chat_fk TEXT PRIMARY KEY,
        summary TEXT NOT NULL DEFAULT '',
        enabled_skills_json TEXT NOT NULL DEFAULT '[]',
        last_compact_at TEXT
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        chat_fk TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        schedule_value TEXT NOT NULL,
        context_mode TEXT NOT NULL DEFAULT 'group',
        status TEXT NOT NULL DEFAULT 'active',
        next_run_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON tasks(next_run_at, status);

      CREATE TABLE IF NOT EXISTS task_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_fk TEXT NOT NULL,
        run_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        result_preview TEXT,
        error TEXT
      );
    `
  },
  {
    id: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS message_queue (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_at TEXT,
        processed_at TEXT,
        dead_lettered_at TEXT,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_message_queue_fetch
        ON message_queue(direction, status, available_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_message_queue_dead
        ON message_queue(status, dead_lettered_at);
    `
  }
];
