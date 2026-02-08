import { z } from "zod";
import type { ToolSpec, ToolContext } from "../registry.js";

type McpToolsOptions = {
  mcpReloader?: ToolContext["mcpReloader"];
};

export const mcpTools = (options: McpToolsOptions = {}): ToolSpec<any>[] => {
  const { mcpReloader } = options;
  if (!mcpReloader) {
    return [];
  }

  const reloadTool: ToolSpec<any> = {
    name: "mcp.reload",
    description:
      "Reload MCP server config and re-register MCP tools without restarting the process.",
    schema: z.object({
      reason: z.string().max(200).optional()
    }),
    async run(args, ctx) {
      const result = await mcpReloader({
        force: true,
        reason: args.reason ?? `manual:${ctx.chat.channel}:${ctx.chat.chatId}`
      });
      return JSON.stringify(result, null, 2);
    }
  };

  return [reloadTool];
};
