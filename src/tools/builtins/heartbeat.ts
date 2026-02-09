import { z } from "zod";
import type { ToolSpec } from "../registry.js";

export const heartbeatTools = (): ToolSpec<any>[] => {
  const statusTool: ToolSpec<any> = {
    name: "heartbeat.status",
    description: "Get runtime heartbeat status, config, and next due chats. Admin only.",
    schema: z.object({}),
    async run(_args, ctx) {
      if (!ctx.heartbeat) {
        throw new Error("Heartbeat service is not available.");
      }
      return JSON.stringify(ctx.heartbeat.getStatus(), null, 2);
    }
  };

  const triggerTool: ToolSpec<any> = {
    name: "heartbeat.trigger",
    description:
      "Trigger heartbeat wake now (optional force and target chat). Admin only.",
    schema: z.object({
      reason: z.string().max(200).optional(),
      force: z.boolean().optional(),
      channel: z.string().min(1).max(100).optional(),
      chatId: z.string().min(1).max(200).optional()
    }),
    async run(args, ctx) {
      if (!ctx.heartbeat) {
        throw new Error("Heartbeat service is not available.");
      }
      ctx.heartbeat.requestNow({
        reason: args.reason ?? "manual:tool-trigger",
        force: args.force,
        channel: args.channel,
        chatId: args.chatId
      });
      return JSON.stringify(
        {
          queued: true,
          reason: args.reason ?? "manual:tool-trigger",
          force: Boolean(args.force),
          target: args.channel && args.chatId ? { channel: args.channel, chatId: args.chatId } : null
        },
        null,
        2
      );
    }
  };

  const enableTool: ToolSpec<any> = {
    name: "heartbeat.enable",
    description:
      "Enable or disable runtime heartbeat loop without process restart. Admin only.",
    schema: z.object({
      enabled: z.boolean(),
      reason: z.string().max(200).optional()
    }),
    async run(args, ctx) {
      if (!ctx.heartbeat) {
        throw new Error("Heartbeat service is not available.");
      }
      ctx.heartbeat.setEnabled(args.enabled, args.reason ?? "manual:tool-enable");
      return JSON.stringify(
        {
          enabled: args.enabled
        },
        null,
        2
      );
    }
  };

  return [statusTool, triggerTool, enableTool];
};

