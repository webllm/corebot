import path from "node:path";
import { validateWebTargetByPolicy } from "./web-guard.js";
import type { ToolContext } from "./registry.js";
import { resolveWorkspacePath } from "../util/file.js";

export type PolicyDecision = {
  allowed: boolean;
  reason?: string;
};

export interface ToolPolicyEngine {
  authorize(params: {
    toolName: string;
    args: unknown;
    ctx: ToolContext;
  }): Promise<PolicyDecision> | PolicyDecision;
}

const allow = (): PolicyDecision => ({ allowed: true });
const deny = (reason: string): PolicyDecision => ({ allowed: false, reason });

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const NON_ADMIN_PROTECTED_WRITE_PATHS = new Set([
  "IDENTITY.md",
  "TOOLS.md",
  "USER.md",
  ".mcp.json"
]);

const NON_ADMIN_PROTECTED_WRITE_PREFIXES = [
  "skills/"
];

const toWorkspaceRelativePath = (
  workspaceDir: string,
  targetPath: string
): string | null => {
  try {
    const resolved = resolveWorkspacePath(workspaceDir, targetPath);
    const relative = path.relative(path.resolve(workspaceDir), resolved);
    return relative.split(path.sep).join("/");
  } catch {
    return null;
  }
};

export class DefaultToolPolicyEngine implements ToolPolicyEngine {
  async authorize(params: {
    toolName: string;
    args: unknown;
    ctx: ToolContext;
  }): Promise<PolicyDecision> {
    const { toolName, args, ctx } = params;
    const record = asRecord(args);
    const role = ctx.chat.role;

    if (toolName === "chat.set_role" && role !== "admin") {
      return deny("Only admin can set chat roles.");
    }

    if (toolName === "shell.exec" && role !== "admin") {
      return deny("Only admin can use shell.exec.");
    }

    if (toolName === "memory.write" && role !== "admin") {
      if (record.scope === "global") {
        return deny("Only admin can write global memory.");
      }
    }

    if (toolName === "fs.write" && role !== "admin") {
      const targetPath = asString(record.path);
      if (!targetPath) {
        return deny("fs.write requires path.");
      }
      const relativePath = toWorkspaceRelativePath(ctx.workspaceDir, targetPath);
      if (!relativePath) {
        return deny("Path is outside workspace.");
      }
      if (NON_ADMIN_PROTECTED_WRITE_PATHS.has(relativePath)) {
        return deny("Only admin can modify protected workspace files.");
      }
      const hitsProtectedPrefix = NON_ADMIN_PROTECTED_WRITE_PREFIXES.some((prefix) => {
        const root = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
        return relativePath === root || relativePath.startsWith(prefix);
      });
      if (hitsProtectedPrefix) {
        return deny("Only admin can modify protected workspace files.");
      }
    }

    if (toolName === "message.send" && role !== "admin") {
      const targetChannel = asString(record.channel) ?? ctx.chat.channel;
      const targetChatId = asString(record.chatId) ?? ctx.chat.chatId;
      if (targetChannel !== ctx.chat.channel || targetChatId !== ctx.chat.chatId) {
        return deny("Only admin can send cross-chat messages.");
      }
    }

    if (toolName === "chat.register" && role !== "admin") {
      const targetChannel = asString(record.channel) ?? ctx.chat.channel;
      const targetChatId = asString(record.chatId) ?? ctx.chat.chatId;
      if (targetChannel !== ctx.chat.channel || targetChatId !== ctx.chat.chatId) {
        return deny("Only admin can register other chats.");
      }
      if (record.role !== undefined && record.role !== "admin") {
        return deny("Only admin can set chat role during registration.");
      }
      if (record.role === "admin" && typeof record.bootstrapKey !== "string") {
        return deny("Bootstrap key is required for admin self-registration.");
      }
    }

    if (toolName === "tasks.update" && role !== "admin") {
      const taskId = asString(record.taskId);
      if (!taskId) {
        return deny("tasks.update requires taskId.");
      }
      const task = ctx.storage.getTask(taskId);
      if (!task) {
        return deny("Task not found.");
      }
      if (task.chatFk !== ctx.chat.id) {
        return deny("Only admin can update tasks from other chats.");
      }
    }

    if (toolName === "web.fetch") {
      const urlRaw = asString(record.url);
      if (!urlRaw) {
        return deny("web.fetch requires url.");
      }
      let parsed: URL;
      try {
        parsed = new URL(urlRaw);
      } catch {
        return deny("Invalid URL.");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return deny("Only http/https URLs are allowed.");
      }
      const policyError = validateWebTargetByPolicy(parsed, {
        allowedWebDomains: ctx.config.allowedWebDomains,
        allowedWebPorts: ctx.config.allowedWebPorts,
        blockedWebPorts: ctx.config.blockedWebPorts
      });
      if (policyError) {
        return deny(policyError);
      }
    }

    if (toolName.startsWith("mcp__") && role !== "admin") {
      return deny("Only admin can execute MCP tools.");
    }

    return allow();
  }
}
