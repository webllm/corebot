import type { InboundMessage, OutboundMessage, ToolMessage } from "../types.js";
import type { SqliteStorage } from "../storage/sqlite.js";
import type { ContextBuilder } from "../agent/context.js";
import type { AgentRuntime } from "../agent/runtime.js";
import type { MessageBus } from "./bus.js";
import type { Config } from "../config/schema.js";
import type { Logger } from "pino";
import type { SkillIndexEntry } from "../skills/types.js";
import { compactConversation } from "../agent/compact.js";
import { nowIso } from "../util/time.js";
import type { McpManager } from "../mcp/manager.js";
import type { IsolatedToolRuntime } from "../isolation/runtime.js";

class SerialQueue {
  private tail = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

export class ConversationRouter {
  private queues = new Map<string, SerialQueue>();

  constructor(
    private storage: SqliteStorage,
    private contextBuilder: ContextBuilder,
    private runtime: AgentRuntime,
    private mcp: McpManager,
    private bus: MessageBus,
    private logger: Logger,
    private config: Config,
    private skills: SkillIndexEntry[],
    private isolatedRuntime?: IsolatedToolRuntime
  ) {}

  handleInbound = async (message: InboundMessage) => {
    const key = `${message.channel}:${message.chatId}`;
    const queue = this.queues.get(key) ?? new SerialQueue();
    this.queues.set(key, queue);
    await queue.enqueue(() => this.processMessage(message));
  };

  private async processMessage(message: InboundMessage) {
    const chat = this.storage.upsertChat({
      channel: message.channel,
      chatId: message.chatId
    });

    const executionNow = nowIso();
    const execution = this.storage.startInboundExecution({
      channel: message.channel,
      chatId: message.chatId,
      inboundId: message.id,
      now: executionNow,
      staleBefore: new Date(
        Date.now() - this.config.bus.processingTimeoutMs
      ).toISOString()
    });
    if (execution.state === "running") {
      this.logger.warn(
        {
          channel: message.channel,
          chatId: message.chatId,
          inboundId: message.id
        },
        "inbound execution already in progress"
      );
      return;
    }

    const { messages } = this.contextBuilder.build({
      chat,
      inbound: message,
      skills: this.skills
    });

    const toolContext = {
      workspaceDir: this.config.workspaceDir,
      chat: { channel: chat.channel, chatId: chat.chatId, role: chat.role, id: chat.id },
      storage: this.storage,
      mcp: this.mcp,
      logger: this.logger,
      bus: this.bus,
      config: this.config,
      skills: this.skills,
      isolatedRuntime: this.isolatedRuntime
    };

    const start = Date.now();
    let responseContent = "";
    let toolMessages: ToolMessage[] = [];
    let errorMessage: string | null = null;
    if (execution.state === "completed") {
      responseContent = execution.responseContent;
      try {
        toolMessages = JSON.parse(execution.toolMessagesJson) as ToolMessage[];
      } catch {
        toolMessages = [];
      }
    } else {
      try {
        const result = await this.runtime.run({
          messages,
          toolContext
        });
        responseContent = result.content;
        toolMessages = result.toolMessages;
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
        responseContent = `Error: ${errorMessage}`;
        this.logger.error({ error: errorMessage }, "runtime error");
      }
      this.storage.completeInboundExecution({
        channel: message.channel,
        chatId: message.chatId,
        inboundId: message.id,
        responseContent,
        toolMessagesJson: JSON.stringify(toolMessages),
        completedAt: nowIso()
      });
    }

    const stored = this.config.storeFullMessages || chat.registered;
    this.storage.insertMessage({
      id: `user:${message.channel}:${message.chatId}:${message.id}`,
      chatFk: chat.id,
      senderId: message.senderId,
      role: "user",
      content: message.content,
      stored,
      createdAt: message.createdAt
    });

    for (const toolMessage of toolMessages) {
      this.storage.insertMessage({
        id: `tool:${message.channel}:${message.chatId}:${message.id}:${toolMessage.tool_call_id}`,
        chatFk: chat.id,
        senderId: toolMessage.tool_call_id,
        role: "tool",
        content: toolMessage.content,
        stored: true,
        createdAt: nowIso()
      });
    }

    this.storage.insertMessage({
      id: `assistant:${message.channel}:${message.chatId}:${message.id}`,
      chatFk: chat.id,
      senderId: "assistant",
      role: "assistant",
      content: responseContent,
      stored: true,
      createdAt: nowIso()
    });

    const shouldCompact =
      this.storage.countMessages(chat.id) > this.config.historyMaxMessages * 2;
    if (shouldCompact) {
      const state = this.storage.getConversationState(chat.id);
      const summarySource = this.storage
        .listRecentMessages(chat.id, this.config.historyMaxMessages * 2)
        .flatMap((entry) =>
          (entry.role === "user" || entry.role === "assistant") && entry.content
            ? [{ role: entry.role as "user" | "assistant", content: entry.content }]
            : []
        );
      const summary = await compactConversation({
        provider: this.runtime.provider,
        config: this.config,
        messages: summarySource
      });
      this.storage.setConversationState({
        chatFk: chat.id,
        summary,
        enabledSkills: state.enabledSkills,
        lastCompactAt: nowIso()
      });
      this.storage.pruneMessages(chat.id, this.config.historyMaxMessages);
    }

    const outbound: OutboundMessage = {
      id: `outbound:${message.channel}:${message.chatId}:${message.id}`,
      channel: message.channel,
      chatId: message.chatId,
      content: responseContent,
      createdAt: nowIso(),
      replyToId: message.id
    };

    this.bus.publishOutbound(outbound);

    if (message.metadata?.taskId) {
      this.storage.logTaskRun({
        taskFk: String(message.metadata.taskId),
        runAt: nowIso(),
        durationMs: Date.now() - start,
        status: errorMessage ? "error" : "success",
        resultPreview: responseContent.slice(0, 240),
        error: errorMessage ?? undefined
      });
    }
  }
}
