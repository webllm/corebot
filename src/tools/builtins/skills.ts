import fs from "node:fs";
import { z } from "zod";
import type { ToolSpec } from "../registry.js";

const updateEnabledSkills = (
  current: string[],
  name: string,
  action: "enable" | "disable"
) => {
  const set = new Set(current);
  if (action === "enable") {
    set.add(name);
  } else {
    set.delete(name);
  }
  return [...set];
};

export const skillTools = (): ToolSpec<any>[] => {
  const listTool: ToolSpec<z.ZodTypeAny> = {
    name: "skills.list",
    description: "List available skills.",
    schema: z.object({}),
    async run(_args, ctx) {
      const state = ctx.storage.getConversationState(ctx.chat.id);
      const enabled = new Set(state.enabledSkills);
      const list = ctx.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        always: skill.always,
        enabled: skill.always || enabled.has(skill.name)
      }));
      return JSON.stringify(list, null, 2);
    }
  };

  const readTool: ToolSpec<z.ZodTypeAny> = {
    name: "skills.read",
    description: "Read a skill file.",
    schema: z.object({
      name: z.string()
    }),
    async run(args, ctx) {
      const skill = ctx.skills.find((entry) => entry.name === args.name);
      if (!skill) {
        throw new Error(`Skill not found: ${args.name}`);
      }
      return fs.readFileSync(skill.skillPath, "utf-8");
    }
  };

  const enableTool: ToolSpec<z.ZodTypeAny> = {
    name: "skills.enable",
    description: "Enable a skill for this chat.",
    schema: z.object({
      name: z.string()
    }),
    async run(args, ctx) {
      const skill = ctx.skills.find((entry) => entry.name === args.name);
      if (!skill) {
        throw new Error(`Skill not found: ${args.name}`);
      }
      if (skill.always) {
        return "Skill is always enabled.";
      }
      const state = ctx.storage.getConversationState(ctx.chat.id);
      ctx.storage.setConversationState({
        chatFk: state.chatFk,
        summary: state.summary,
        enabledSkills: updateEnabledSkills(state.enabledSkills, args.name, "enable"),
        lastCompactAt: state.lastCompactAt
      });
      return "ok";
    }
  };

  const disableTool: ToolSpec<z.ZodTypeAny> = {
    name: "skills.disable",
    description: "Disable a skill for this chat.",
    schema: z.object({
      name: z.string()
    }),
    async run(args, ctx) {
      const skill = ctx.skills.find((entry) => entry.name === args.name);
      if (!skill) {
        throw new Error(`Skill not found: ${args.name}`);
      }
      if (skill.always) {
        throw new Error("Always skill cannot be disabled.");
      }
      const state = ctx.storage.getConversationState(ctx.chat.id);
      ctx.storage.setConversationState({
        chatFk: state.chatFk,
        summary: state.summary,
        enabledSkills: updateEnabledSkills(state.enabledSkills, args.name, "disable"),
        lastCompactAt: state.lastCompactAt
      });
      return "ok";
    }
  };

  const enabledTool: ToolSpec<z.ZodTypeAny> = {
    name: "skills.enabled",
    description: "List currently enabled skill names for this chat.",
    schema: z.object({}),
    async run(_args, ctx) {
      const state = ctx.storage.getConversationState(ctx.chat.id);
      const active = new Set(state.enabledSkills);
      for (const skill of ctx.skills) {
        if (skill.always) {
          active.add(skill.name);
        }
      }
      return JSON.stringify([...active], null, 2);
    }
  };

  return [listTool, readTool, enableTool, disableTool, enabledTool];
};
