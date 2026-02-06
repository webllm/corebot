import type { LlmProvider } from "./runtime.js";
import type { Config } from "../config/schema.js";

const summaryPrompt = `You are a conversation summarizer. Create a concise bullet summary of the key facts, decisions, and user preferences. Keep it under 150 words.`;

export const compactConversation = async (params: {
  provider: LlmProvider;
  config: Config;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<string> => {
  if (params.messages.length === 0) {
    return "";
  }

  const response = await params.provider.chat({
    model: params.config.provider.model,
    messages: [
      { role: "system", content: summaryPrompt },
      ...params.messages.map((message) => ({
        role: message.role,
        content: message.content
      })),
      { role: "user", content: "Summarize the conversation." }
    ],
    temperature: 0.2
  });

  return response.content ?? "";
};
