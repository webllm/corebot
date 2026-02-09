import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { Config } from "../config/schema.js";
import type { SqliteStorage } from "../storage/sqlite.js";
import type { MessageBus } from "../bus/bus.js";
import type { RuntimeTelemetry } from "../observability/telemetry.js";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";

type ActiveHoursWindow = {
  startMinutes: number;
  endMinutes: number;
};

const normalizeText = (text: string) => text.trim().replace(/\s+/g, " ");

const hashText = (text: string) =>
  createHash("sha256").update(normalizeText(text).toLowerCase()).digest("hex");

const parseActiveHours = (value: string): ActiveHoursWindow | null => {
  if (!value.trim()) {
    return null;
  }
  const [startRaw, endRaw] = value.split("-");
  if (!startRaw || !endRaw) {
    return null;
  }
  const parseTime = (time: string) => {
    const [hourRaw, minuteRaw] = time.split(":");
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    if (
      !Number.isInteger(hour) ||
      !Number.isInteger(minute) ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59
    ) {
      return null;
    }
    return hour * 60 + minute;
  };
  const startMinutes = parseTime(startRaw);
  const endMinutes = parseTime(endRaw);
  if (startMinutes === null || endMinutes === null) {
    return null;
  }
  return {
    startMinutes,
    endMinutes
  };
};

const isInActiveWindow = (window: ActiveHoursWindow | null, at: Date) => {
  if (!window) {
    return true;
  }
  if (window.startMinutes === window.endMinutes) {
    return true;
  }
  const nowMinutes = at.getHours() * 60 + at.getMinutes();
  if (window.startMinutes < window.endMinutes) {
    return nowMinutes >= window.startMinutes && nowMinutes < window.endMinutes;
  }
  return nowMinutes >= window.startMinutes || nowMinutes < window.endMinutes;
};

export type HeartbeatRequest = {
  reason?: string;
  force?: boolean;
  channel?: string;
  chatId?: string;
};

export type HeartbeatStatus = {
  running: boolean;
  enabled: boolean;
  config: {
    enabled: boolean;
    intervalMs: number;
    wakeDebounceMs: number;
    wakeRetryMs: number;
    promptPath: string;
    activeHours: string;
    skipWhenInboundBusy: boolean;
    ackToken: string;
    suppressAck: boolean;
    dedupeWindowMs: number;
    maxDispatchPerRun: number;
  };
  nextDueCount: number;
  nextDuePreview: Array<{
    chatFk: string;
    channel: string;
    chatId: string;
    dueAt: string;
  }>;
};

export type HeartbeatController = {
  requestNow: (params?: HeartbeatRequest) => void;
  setEnabled: (enabled: boolean, reason?: string) => void;
  getStatus: () => HeartbeatStatus;
};

export class HeartbeatService implements HeartbeatController {
  private timer: NodeJS.Timeout | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private running = false;
  private enabled: boolean;
  private nextDueByChat = new Map<string, number>();
  private pendingForce = false;
  private pendingReason = new Set<string>();
  private pendingTargets = new Set<string>();
  private readonly activeHoursWindow: ActiveHoursWindow | null;

  constructor(
    private storage: SqliteStorage,
    private bus: MessageBus,
    private config: Config,
    private logger: Pick<Logger, "info" | "warn" | "error" | "debug">,
    private telemetry?: RuntimeTelemetry
  ) {
    this.enabled = this.config.heartbeat.enabled;
    this.activeHoursWindow = parseActiveHours(this.config.heartbeat.activeHours);
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.timer = setInterval(() => {
      this.requestNow({ reason: "heartbeat:tick" });
    }, this.config.heartbeat.intervalMs);
    this.timer.unref?.();
    this.requestNow({ reason: "heartbeat:startup" });
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.pendingReason.clear();
    this.pendingTargets.clear();
    this.pendingForce = false;
  }

  isRunning() {
    return this.running;
  }

  requestNow(params: HeartbeatRequest = {}) {
    const reason = params.reason?.trim() || "heartbeat:wake";
    this.pendingReason.add(reason);
    if (params.force) {
      this.pendingForce = true;
    }
    if (params.channel && params.chatId) {
      this.pendingTargets.add(`${params.channel}:${params.chatId}`);
    }
    if (this.wakeTimer) {
      return;
    }
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      void this.flushWake();
    }, this.config.heartbeat.wakeDebounceMs);
    this.wakeTimer.unref?.();
  }

  setEnabled(enabled: boolean, reason = "manual") {
    this.enabled = enabled;
    if (!enabled && this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.writeControlAudit(enabled, reason);
    if (enabled) {
      this.requestNow({ reason: `heartbeat:enabled:${reason}`, force: true });
    }
  }

  getStatus(): HeartbeatStatus {
    const preview = [...this.nextDueByChat.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, 20)
      .flatMap(([chatFk, dueMs]) => {
        const chat = this.storage.getChatById(chatFk);
        if (!chat) {
          return [];
        }
        return [
          {
            chatFk,
            channel: chat.channel,
            chatId: chat.chatId,
            dueAt: new Date(dueMs).toISOString()
          }
        ];
      });
    return {
      running: this.running,
      enabled: this.enabled,
      config: {
        enabled: this.config.heartbeat.enabled,
        intervalMs: this.config.heartbeat.intervalMs,
        wakeDebounceMs: this.config.heartbeat.wakeDebounceMs,
        wakeRetryMs: this.config.heartbeat.wakeRetryMs,
        promptPath: this.config.heartbeat.promptPath,
        activeHours: this.config.heartbeat.activeHours,
        skipWhenInboundBusy: this.config.heartbeat.skipWhenInboundBusy,
        ackToken: this.config.heartbeat.ackToken,
        suppressAck: this.config.heartbeat.suppressAck,
        dedupeWindowMs: this.config.heartbeat.dedupeWindowMs,
        maxDispatchPerRun: this.config.heartbeat.maxDispatchPerRun
      },
      nextDueCount: this.nextDueByChat.size,
      nextDuePreview: preview
    };
  }

  private async flushWake() {
    if (!this.running) {
      return;
    }
    const reasons = [...this.pendingReason];
    const force = this.pendingForce;
    const targets = [...this.pendingTargets];
    this.pendingReason.clear();
    this.pendingTargets.clear();
    this.pendingForce = false;

    try {
      await this.runOnce({
        reason: reasons.length > 0 ? reasons.join(",") : "heartbeat:wake",
        force,
        targetKeys: targets
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.telemetry?.recordHeartbeat({
        scope: "run",
        outcome: "failed"
      });
      this.logger.warn({ error: detail }, "heartbeat run failed");
      this.writeRunAudit({
        outcome: "failed",
        reason: "run_error",
        metadata: {
          error: detail
        }
      });
    }
  }

  private async runOnce(params: {
    reason: string;
    force: boolean;
    targetKeys: string[];
  }) {
    if (!this.enabled) {
      this.telemetry?.recordHeartbeat({
        scope: "run",
        outcome: "skipped"
      });
      this.writeRunAudit({
        outcome: "skipped",
        reason: "disabled",
        metadata: { triggerReason: params.reason }
      });
      return;
    }

    const now = new Date();
    if (!isInActiveWindow(this.activeHoursWindow, now)) {
      this.telemetry?.recordHeartbeat({
        scope: "run",
        outcome: "skipped"
      });
      this.writeRunAudit({
        outcome: "skipped",
        reason: "outside_active_hours",
        metadata: { triggerReason: params.reason }
      });
      return;
    }

    if (!params.force && this.config.heartbeat.skipWhenInboundBusy) {
      const inbound = this.storage.countBusMessagesByStatus("inbound");
      const busy = inbound.pending + inbound.processing > 0;
      if (busy) {
        this.telemetry?.recordHeartbeat({
          scope: "run",
          outcome: "skipped"
        });
        this.writeRunAudit({
          outcome: "skipped",
          reason: "inbound_busy",
          metadata: { triggerReason: params.reason }
        });
        if (!this.retryTimer) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.requestNow({ reason: "heartbeat:retry-after-busy", force: false });
          }, this.config.heartbeat.wakeRetryMs);
          this.retryTimer.unref?.();
        }
        return;
      }
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    const prompt = this.readPrompt();
    if (!prompt) {
      this.telemetry?.recordHeartbeat({
        scope: "run",
        outcome: "skipped"
      });
      this.writeRunAudit({
        outcome: "skipped",
        reason: "prompt_missing_or_empty",
        metadata: { triggerReason: params.reason }
      });
      return;
    }

    const chats = this.storage.listChats(2_000);
    const chatByKey = new Map<string, (typeof chats)[number]>(
      chats.map((chat) => [`${chat.channel}:${chat.chatId}`, chat])
    );

    const activeChatIds = new Set(chats.map((chat) => chat.id));
    for (const chatFk of [...this.nextDueByChat.keys()]) {
      if (!activeChatIds.has(chatFk)) {
        this.nextDueByChat.delete(chatFk);
      }
    }

    const nowMs = now.getTime();
    const targets =
      params.targetKeys.length > 0
        ? params.targetKeys.flatMap((key) => {
            const chat = chatByKey.get(key);
            return chat ? [chat] : [];
          })
        : chats;

    let dispatched = 0;
    for (const chat of targets) {
      const dueAt = this.nextDueByChat.get(chat.id);
      if (dueAt === undefined) {
        this.nextDueByChat.set(chat.id, nowMs + this.config.heartbeat.intervalMs);
        if (!params.force) {
          continue;
        }
      }

      const nextDue = this.nextDueByChat.get(chat.id) ?? nowMs;
      if (!params.force && nowMs < nextDue) {
        continue;
      }

      this.bus.publishInbound({
        id: `heartbeat:${newId()}`,
        channel: chat.channel,
        chatId: chat.chatId,
        senderId: "heartbeat",
        content: prompt.text,
        createdAt: nowIso(),
        metadata: {
          isHeartbeat: true,
          contextMode: "group",
          heartbeatReason: params.reason,
          heartbeatPromptHash: prompt.hash,
          heartbeatForce: params.force
        }
      });
      this.nextDueByChat.set(chat.id, nowMs + this.config.heartbeat.intervalMs);
      this.telemetry?.recordHeartbeat({
        scope: "run",
        outcome: "queued"
      });
      this.writeRunAudit({
        outcome: "queued",
        reason: params.reason,
        chat: {
          chatFk: chat.id,
          channel: chat.channel,
          chatId: chat.chatId
        },
        metadata: {
          promptHash: prompt.hash,
          force: params.force
        }
      });

      dispatched += 1;
      if (dispatched >= this.config.heartbeat.maxDispatchPerRun) {
        break;
      }
    }

    if (dispatched === 0) {
      this.telemetry?.recordHeartbeat({
        scope: "run",
        outcome: "skipped"
      });
      this.writeRunAudit({
        outcome: "skipped",
        reason: "no_due_chat",
        metadata: {
          triggerReason: params.reason,
          force: params.force,
          targetCount: targets.length
        }
      });
    }
  }

  private readPrompt(): { text: string; hash: string } | null {
    const promptPath = path.resolve(this.config.workspaceDir, this.config.heartbeat.promptPath);
    if (!fs.existsSync(promptPath)) {
      return null;
    }
    const text = fs.readFileSync(promptPath, "utf-8").trim();
    if (!text) {
      return null;
    }
    return {
      text,
      hash: hashText(text)
    };
  }

  private writeControlAudit(enabled: boolean, reason: string) {
    try {
      this.storage.insertAuditEvent({
        at: nowIso(),
        eventType: "heartbeat.control",
        toolName: "heartbeat.enable",
        actorRole: "system",
        outcome: "success",
        reason: enabled ? "enabled" : "disabled",
        argsJson: JSON.stringify({
          enabled,
          reason
        })
      });
    } catch {
      // best-effort
    }
  }

  private writeRunAudit(params: {
    outcome: "queued" | "skipped" | "failed";
    reason: string;
    chat?: {
      chatFk: string;
      channel: string;
      chatId: string;
    };
    metadata?: Record<string, unknown>;
  }) {
    try {
      this.storage.insertAuditEvent({
        at: nowIso(),
        eventType: "heartbeat.run",
        toolName: "heartbeat.runner",
        chatFk: params.chat?.chatFk,
        channel: params.chat?.channel,
        chatId: params.chat?.chatId,
        actorRole: "system",
        outcome: params.outcome,
        reason: params.reason,
        metadataJson: params.metadata ? JSON.stringify(params.metadata) : undefined
      });
    } catch {
      // best-effort
    }
  }
}
