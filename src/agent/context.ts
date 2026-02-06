import fs from "node:fs";
import path from "node:path";
import type { InboundMessage, ChatMessage, ChatRecord } from "../types.js";
import type { SqliteStorage } from "../storage/sqlite.js";
import type { Config } from "../config/schema.js";
import type { SkillIndexEntry } from "../skills/types.js";

const readIfExists = (filePath: string) =>
  fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8").trim() : "";

const renderSkillsIndex = (skills: SkillIndexEntry[], enabledSkills: Set<string>) => {
  if (skills.length === 0) {
    return "(no skills available)";
  }
  return skills
    .map((skill) => {
      const flags: string[] = [];
      if (skill.always) {
        flags.push("always");
      }
      if (enabledSkills.has(skill.name)) {
        flags.push("enabled");
      }
      const suffix = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
      return `- ${skill.name}${suffix}: ${skill.description}`;
    })
    .join("\n");
};

export class ContextBuilder {
  constructor(
    private storage: SqliteStorage,
    private config: Config,
    private workspaceDir: string
  ) {}

  build(params: {
    chat: ChatRecord;
    inbound: InboundMessage;
    skills: SkillIndexEntry[];
  }): { messages: ChatMessage[]; systemPrompt: string } {
    const identityPath = path.join(this.workspaceDir, "IDENTITY.md");
    const userPath = path.join(this.workspaceDir, "USER.md");
    const toolsPath = path.join(this.workspaceDir, "TOOLS.md");
    const globalMemoryPath = path.join(this.workspaceDir, "memory/MEMORY.md");
    const chatMemoryPath = path.join(
      this.workspaceDir,
      `memory/${params.chat.channel}_${params.chat.chatId}.md`
    );

    const identity = readIfExists(identityPath);
    const userProfile = readIfExists(userPath);
    const toolsPolicy = readIfExists(toolsPath);
    const globalMemory = readIfExists(globalMemoryPath);
    const chatMemory = readIfExists(chatMemoryPath);

    const state = this.storage.getConversationState(params.chat.id);
    const isScheduled = Boolean(params.inbound.metadata?.isScheduledTask);
    const contextMode =
      (params.inbound.metadata?.contextMode as string | undefined) ?? "group";
    const includeChatContext = !isScheduled || contextMode === "group";
    const enabledSkills = new Set(state.enabledSkills);

    const systemSections: string[] = [];
    if (identity) {
      systemSections.push(`# Identity\n${identity}`);
    }
    if (toolsPolicy) {
      systemSections.push(`# Tool Policy\n${toolsPolicy}`);
    }
    if (userProfile) {
      systemSections.push(`# User Profile\n${userProfile}`);
    }
    if (globalMemory) {
      systemSections.push(`# Global Memory\n${globalMemory}`);
    }
    if (includeChatContext && chatMemory) {
      systemSections.push(`# Chat Memory\n${chatMemory}`);
    }
    systemSections.push("# Skills Index\n" + renderSkillsIndex(params.skills, enabledSkills));

    const alwaysSkills = params.skills.filter((skill) => skill.always);
    if (alwaysSkills.length > 0) {
      const skillBodies = alwaysSkills
        .map((skill) => {
          const content = readIfExists(skill.skillPath);
          return `# Skill: ${skill.name}\n${content}`;
        })
        .join("\n\n");
      systemSections.push(`# Always Skills\n${skillBodies}`);
    }

    const activeSkills = params.skills.filter(
      (skill) => !skill.always && enabledSkills.has(skill.name)
    );
    if (activeSkills.length > 0) {
      const skillBodies = activeSkills
        .map((skill) => {
          const content = readIfExists(skill.skillPath);
          return `# Skill: ${skill.name}\n${content}`;
        })
        .join("\n\n");
      systemSections.push(`# Enabled Skills\n${skillBodies}`);
    }

    if (includeChatContext && state.summary) {
      systemSections.push(`# Conversation Summary\n${state.summary}`);
    }

    const systemPrompt = systemSections.filter(Boolean).join("\n\n");

    const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];

    if (includeChatContext) {
      const history = this.storage.listRecentMessages(
        params.chat.id,
        this.config.historyMaxMessages
      );
      for (const msg of history) {
        if (!msg.content) {
          continue;
        }
        if (msg.role === "assistant" || msg.role === "user") {
          messages.push({
            role: msg.role,
            content: msg.content
          });
        }
      }
    }

    const userContent = isScheduled
      ? `[Scheduled Task] ${params.inbound.content}`
      : params.inbound.content;

    messages.push({ role: "user", content: userContent });

    return { messages, systemPrompt };
  }
}
