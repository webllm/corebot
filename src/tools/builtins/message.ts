import { z } from "zod";
import type { ToolSpec } from "../registry.js";
import { nowIso } from "../../util/time.js";
import { newId } from "../../util/ids.js";

export const messageTools = (): ToolSpec<any>[] => {
  const sendTool: ToolSpec<z.ZodTypeAny> = {
    name: "message.send",
    description: "Send a message to a channel chat.",
    schema: z.object({
      channel: z.string().optional(),
      chatId: z.string().optional(),
      content: z.string()
    }),
    async run(args, ctx) {
      const channel = args.channel ?? ctx.chat.channel;
      const chatId = args.chatId ?? ctx.chat.chatId;
      if (
        (channel !== ctx.chat.channel || chatId !== ctx.chat.chatId) &&
        ctx.chat.role !== "admin"
      ) {
        throw new Error("Only admin can send cross-chat messages.");
      }
      ctx.bus.publishOutbound({
        id: newId(),
        channel,
        chatId,
        content: args.content,
        createdAt: nowIso()
      });
      return "ok";
    }
  };

  const registerChat: ToolSpec<z.ZodTypeAny> = {
    name: "chat.register",
    description: "Register a chat for full message storage.",
    schema: z.object({
      channel: z.string().optional(),
      chatId: z.string().optional(),
      role: z.enum(["admin", "normal"]).optional(),
      bootstrapKey: z.string().optional()
    }),
    async run(args, ctx) {
      const channel = args.channel ?? ctx.chat.channel;
      const chatId = args.chatId ?? ctx.chat.chatId;
      const isCrossChat = channel !== ctx.chat.channel || chatId !== ctx.chat.chatId;
      if (
        isCrossChat &&
        ctx.chat.role !== "admin"
      ) {
        throw new Error("Only admin can register other chats.");
      }

      if (args.role === "admin" && ctx.chat.role !== "admin") {
        const bootstrapKey = ctx.config.adminBootstrapKey;
        if (!bootstrapKey) {
          throw new Error("Admin bootstrap is not configured.");
        }
        if (args.bootstrapKey !== bootstrapKey) {
          throw new Error("Invalid admin bootstrap key.");
        }
        if (ctx.storage.countAdminChats() > 0) {
          throw new Error("Admin already exists. Ask an admin to grant role.");
        }
      }

      if (args.role && ctx.chat.role !== "admin" && args.role !== "admin") {
        throw new Error("Only admin can set chat roles.");
      }

      const chat = ctx.storage.upsertChat({ channel, chatId });
      ctx.storage.setChatRegistered(chat.id, true);
      if (args.role) {
        ctx.storage.setChatRole(chat.id, args.role);
      }
      return "ok";
    }
  };

  const setRole: ToolSpec<z.ZodTypeAny> = {
    name: "chat.set_role",
    description: "Set chat role (admin/normal).",
    schema: z.object({
      channel: z.string(),
      chatId: z.string(),
      role: z.enum(["admin", "normal"])
    }),
    async run(args, ctx) {
      if (ctx.chat.role !== "admin") {
        throw new Error("Only admin can change roles.");
      }
      const chat = ctx.storage.upsertChat({
        channel: args.channel,
        chatId: args.chatId
      });
      ctx.storage.setChatRole(chat.id, args.role);
      return "ok";
    }
  };

  return [sendTool, registerChat, setRole];
};
