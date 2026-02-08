import type { ChatMessage, ToolCall, ToolDefinition, ToolMessage } from "../types.js";
import type { ToolRegistry, ToolContext } from "../tools/registry.js";
import type { Config } from "../config/schema.js";
import type { Logger } from "pino";

export interface LlmProvider {
  chat(req: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    temperature?: number;
  }): Promise<{ content?: string; toolCalls?: ToolCall[] }>;
}

export class OpenAICompatibleProvider implements LlmProvider {
  constructor(private config: Config) {}

  async chat(req: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    temperature?: number;
  }): Promise<{ content?: string; toolCalls?: ToolCall[] }> {
    const apiKey = this.config.provider.apiKey;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is missing.");
    }
    const payload: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? this.config.provider.temperature
    };
    if (req.tools) {
      payload.tools = req.tools.map((tool) => ({
        type: "function",
        function: tool
      }));
    }

    const response = await fetch(`${this.config.provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Provider error: ${response.status} ${text}`);
    }
    const data = (await response.json()) as any;
    const message = data.choices?.[0]?.message;
    const toolCalls = message?.tool_calls?.map((call: any) => {
      let parsedArgs: unknown = {};
      if (call.function?.arguments) {
        try {
          parsedArgs = JSON.parse(call.function.arguments);
        } catch {
          parsedArgs = {};
        }
      }
      return {
        id: call.id,
        name: call.function?.name,
        args: parsedArgs
      };
    });
    return {
      content: message?.content ?? undefined,
      toolCalls: toolCalls?.length ? toolCalls : undefined
    };
  }
}

export class AgentRuntime {
  constructor(
    public provider: LlmProvider,
    private tools: ToolRegistry,
    private config: Config,
    private logger: Logger
  ) {}

  async run(params: {
    messages: ChatMessage[];
    toolContext: ToolContext;
  }): Promise<{ content: string; toolMessages: ToolMessage[] }> {
    const messages: ChatMessage[] = [...params.messages];
    const toolMessages: ToolMessage[] = [];

    for (let i = 0; i < this.config.maxToolIterations; i += 1) {
      const toolDefs = this.tools.listDefinitions();
      const toolsForRequest = toolDefs.length > 0 ? toolDefs : undefined;
      const response = await this.provider.chat({
        model: this.config.provider.model,
        messages,
        tools: toolsForRequest,
        temperature: this.config.provider.temperature
      });

      if (response.toolCalls && response.toolCalls.length > 0) {
        const toolCalls = response.toolCalls;
        messages.push({
          role: "assistant",
          content: "",
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.args ?? {})
            }
          }))
        });

        for (const call of toolCalls) {
          try {
            const output = await this.tools.execute(call.name, call.args, params.toolContext);
            const toolMessage: ChatMessage = {
              role: "tool",
              tool_call_id: call.id,
              content: output
            };
            messages.push(toolMessage);
            toolMessages.push(toolMessage);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error({ tool: call.name, error: message }, "tool error");
            const toolMessage: ChatMessage = {
              role: "tool",
              tool_call_id: call.id,
              content: `Tool error: ${message}`
            };
            messages.push(toolMessage);
            toolMessages.push(toolMessage);
          }
        }
        continue;
      }

      if (response.content) {
        return { content: response.content, toolMessages };
      }
    }

    return {
      content: "Unable to complete the request within tool limits.",
      toolMessages
    };
  }
}
