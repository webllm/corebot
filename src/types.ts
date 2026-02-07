export type MessageRole = "user" | "assistant" | "system" | "tool";

export type InboundMessage = {
  id: string;
  channel: string;
  chatId: string;
  senderId: string;
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type OutboundMessage = {
  id: string;
  channel: string;
  chatId: string;
  content: string;
  createdAt: string;
  replyToId?: string;
  metadata?: Record<string, unknown>;
};

export type ConversationKey = string;

export type ChatRecord = {
  id: string;
  channel: string;
  chatId: string;
  displayName: string | null;
  role: "admin" | "normal";
  registered: boolean;
  lastMessageAt: string | null;
};

export type ConversationState = {
  chatFk: string;
  summary: string;
  enabledSkills: string[];
  lastCompactAt: string | null;
};

export type TaskScheduleType = "cron" | "interval" | "once";
export type TaskContextMode = "group" | "isolated";
export type TaskStatus = "active" | "paused" | "done";
export type BusMessageDirection = "inbound" | "outbound";
export type BusMessageStatus = "pending" | "processing" | "processed" | "dead_letter";

export type TaskRecord = {
  id: string;
  chatFk: string;
  prompt: string;
  scheduleType: TaskScheduleType;
  scheduleValue: string;
  contextMode: TaskContextMode;
  status: TaskStatus;
  nextRunAt: string | null;
  createdAt: string;
};

export type BusQueueRecord = {
  id: string;
  direction: BusMessageDirection;
  payload: string;
  status: BusMessageStatus;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  processedAt: string | null;
  deadLetteredAt: string | null;
  lastError: string | null;
};

export type ToolCall = {
  id: string;
  name: string;
  args: unknown;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ChatMessage =
  | {
      role: "system" | "user" | "assistant";
      content: string;
      name?: string;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
      name?: string;
    };

export type ToolMessage = Extract<ChatMessage, { role: "tool" }>;
