import type { InboundMessage, OutboundMessage, ToolMessage } from "../types.js";
import { createHash } from "node:crypto";
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
import type { McpReloadRequest, McpReloadResult } from "../tools/registry.js";
import type { RuntimeTelemetry } from "../observability/telemetry.js";
import type { HeartbeatController } from "../heartbeat/service.js";

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

const normalizeHeartbeatContent = (value: string) =>
  value.trim().replace(/\s+/g, " ");

const hashHeartbeatContent = (value: string) =>
  createHash("sha256")
    .update(normalizeHeartbeatContent(value).toLowerCase())
    .digest("hex");

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
    private skills: SkillIndexEntry[] | (() => SkillIndexEntry[]),
    private isolatedRuntime?: IsolatedToolRuntime,
    private mcpReloader?: (params?: McpReloadRequest) => Promise<McpReloadResult>,
    private heartbeatController?: HeartbeatController,
    private wakeHeartbeat?: (reason: string) => void,
    private telemetry?: RuntimeTelemetry
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

    if (this.mcpReloader) {
      try {
        await this.mcpReloader({
          force: false,
          reason: "inbound:auto-sync",
          audit: {
            chatFk: chat.id,
            channel: chat.channel,
            chatId: chat.chatId,
            actorRole: chat.role
          }
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.warn({ error: detail }, "failed to auto-sync MCP tools");
      }
    }

    const skills = this.resolveSkills();

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
      skills
    });

    const toolContext = {
      workspaceDir: this.config.workspaceDir,
      chat: { channel: chat.channel, chatId: chat.chatId, role: chat.role, id: chat.id },
      storage: this.storage,
      mcp: this.mcp,
      heartbeat: this.heartbeatController,
      logger: this.logger,
      bus: this.bus,
      config: this.config,
      skills,
      mcpReloader: this.mcpReloader,
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
    const isHeartbeat = Boolean(message.metadata?.isHeartbeat);
    if (isHeartbeat) {
      const delivery = this.handleHeartbeatDelivery({
        message,
        chat,
        responseContent
      });
      if (delivery.send) {
        outbound.metadata = {
          ...(message.metadata ?? {}),
          isHeartbeat: true
        };
        this.bus.publishOutbound(outbound);
      }
    } else {
      this.bus.publishOutbound(outbound);
      this.wakeHeartbeat?.("router:message-processed");
    }

    if (message.metadata?.taskId) {
      this.storage.logTaskRun({
        taskFk: String(message.metadata.taskId),
        inboundId: message.id,
        runAt: nowIso(),
        durationMs: Date.now() - start,
        status: errorMessage ? "error" : "success",
        resultPreview: responseContent.slice(0, 240),
        error: errorMessage ?? undefined
      });
    }
  }

  private resolveSkills(): SkillIndexEntry[] {
    const resolved = typeof this.skills === "function" ? this.skills() : this.skills;
    return [...resolved];
  }

  private handleHeartbeatDelivery(params: {
    message: InboundMessage;
    chat: {
      id: string;
      channel: string;
      chatId: string;
      role: "admin" | "normal";
    };
    responseContent: string;
  }): { send: boolean } {
    const content = normalizeHeartbeatContent(params.responseContent);
    const contentHash = hashHeartbeatContent(content);
    const metadata: Record<string, unknown> = {
      contentHash,
      triggerReason: params.message.metadata?.heartbeatReason ?? null,
      suppressAck: this.config.heartbeat.suppressAck
    };

    if (!content) {
      this.recordHeartbeatDeliveryAudit({
        chat: params.chat,
        outcome: "skipped",
        reason: "empty_response",
        metadata
      });
      this.telemetry?.recordHeartbeat({ scope: "delivery", outcome: "skipped" });
      return { send: false };
    }

    if (this.config.heartbeat.suppressAck) {
      const token = this.config.heartbeat.ackToken.trim();
      const tokenRegex = new RegExp(`^\\W*${escapeRegex(token)}\\W*$`, "i");
      if (tokenRegex.test(content)) {
        this.recordHeartbeatDeliveryAudit({
          chat: params.chat,
          outcome: "skipped",
          reason: "ok_token",
          metadata
        });
        this.telemetry?.recordHeartbeat({ scope: "delivery", outcome: "skipped" });
        return { send: false };
      }
    }

    const dedupeSince = new Date(
      Date.now() - this.config.heartbeat.dedupeWindowMs
    ).toISOString();
    const duplicate = this.storage.hasRecentHeartbeatDelivery({
      chatFk: params.chat.id,
      contentHash,
      since: dedupeSince
    });
    if (duplicate) {
      this.recordHeartbeatDeliveryAudit({
        chat: params.chat,
        outcome: "skipped",
        reason: "duplicate",
        metadata
      });
      this.telemetry?.recordHeartbeat({ scope: "delivery", outcome: "skipped" });
      return { send: false };
    }

    this.recordHeartbeatDeliveryAudit({
      chat: params.chat,
      outcome: "sent",
      reason: contentHash,
      metadata
    });
    this.telemetry?.recordHeartbeat({ scope: "delivery", outcome: "sent" });
    return { send: true };
  }

  private recordHeartbeatDeliveryAudit(params: {
    chat: {
      id: string;
      channel: string;
      chatId: string;
      role: "admin" | "normal";
    };
    outcome: "sent" | "skipped";
    reason: string;
    metadata?: Record<string, unknown>;
  }) {
    try {
      this.storage.insertAuditEvent({
        at: nowIso(),
        eventType: "heartbeat.delivery",
        toolName: "heartbeat.delivery",
        chatFk: params.chat.id,
        channel: params.chat.channel,
        chatId: params.chat.chatId,
        actorRole: params.chat.role,
        outcome: params.outcome,
        reason: params.reason,
        metadataJson: params.metadata ? JSON.stringify(params.metadata) : undefined
      });
    } catch {
      // best-effort audit
    }
  }
}
