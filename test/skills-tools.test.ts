import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { skillTools } from "../src/tools/builtins/skills.js";
import { ContextBuilder } from "../src/agent/context.js";
import type { SkillIndexEntry } from "../src/skills/types.js";
import { createStorageFixture, createToolContext } from "./test-utils.js";

const getTool = (name: string) => {
  const tool = skillTools().find((item) => item.name === name);
  if (!tool) {
    throw new Error(`${name} tool missing`);
  }
  return tool;
};

test("skills.enable/disable updates conversation state", async () => {
  const fixture = createStorageFixture();
  try {
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    const skill: SkillIndexEntry = {
      name: "sample",
      description: "sample skill",
      always: false,
      dir: path.join(fixture.workspaceDir, "skills", "sample"),
      skillPath: path.join(fixture.workspaceDir, "skills", "sample", "SKILL.md")
    };
    fs.mkdirSync(skill.dir, { recursive: true });
    fs.writeFileSync(skill.skillPath, "# Sample Skill\nBody", "utf-8");

    const { context } = createToolContext({
      config: fixture.config,
      storage: fixture.storage,
      workspaceDir: fixture.workspaceDir,
      chatFk: chat.id,
      skills: [skill]
    });

    await getTool("skills.enable").run({ name: "sample" }, context);
    assert.deepEqual(fixture.storage.getConversationState(chat.id).enabledSkills, ["sample"]);

    const list = await getTool("skills.list").run({}, context);
    assert.match(list, /"enabled": true/);

    await getTool("skills.disable").run({ name: "sample" }, context);
    assert.deepEqual(fixture.storage.getConversationState(chat.id).enabledSkills, []);
  } finally {
    fixture.cleanup();
  }
});

test("ContextBuilder injects enabled skill bodies", () => {
  const fixture = createStorageFixture();
  try {
    const chat = fixture.storage.upsertChat({ channel: "cli", chatId: "local" });
    const skill: SkillIndexEntry = {
      name: "writer",
      description: "writing helper",
      always: false,
      dir: path.join(fixture.workspaceDir, "skills", "writer"),
      skillPath: path.join(fixture.workspaceDir, "skills", "writer", "SKILL.md")
    };
    fs.mkdirSync(skill.dir, { recursive: true });
    fs.writeFileSync(skill.skillPath, "# Writer Skill\nUse concise writing.", "utf-8");
    fixture.storage.setConversationState({
      chatFk: chat.id,
      summary: "",
      enabledSkills: ["writer"],
      lastCompactAt: null
    });

    const builder = new ContextBuilder(fixture.storage, fixture.config, fixture.workspaceDir);
    const built = builder.build({
      chat,
      skills: [skill],
      inbound: {
        id: "1",
        channel: "cli",
        chatId: "local",
        senderId: "user",
        content: "hello",
        createdAt: new Date().toISOString()
      }
    });

    assert.match(built.systemPrompt, /# Enabled Skills/);
    assert.match(built.systemPrompt, /Writer Skill/);
  } finally {
    fixture.cleanup();
  }
});
