import fs from "node:fs";
import type { ToolDefinition } from "../types.js";
import type { McpConfigFile, McpServerConfig } from "./types.js";

export type McpToolInfo = {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type McpClientInstance = {
  listTools: () => Promise<unknown>;
  callTool: (params: { name: string; arguments?: unknown }) => Promise<unknown>;
  connect: (transport: unknown) => Promise<void>;
  close?: () => Promise<void> | void;
};

type McpTransport = unknown;

type McpClientFactory = {
  createClient: (server: McpServerConfig) => Promise<{ client: McpClientInstance; transport?: McpTransport }>;
};

const defaultClientFactory: McpClientFactory = {
  async createClient(server) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/stdio.js"
    );
    const { SSEClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/sse.js"
    );

    let transport: McpTransport | undefined;
    if (server.command) {
      transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: server.env ?? {}
      });
    } else if (server.url) {
      transport = new SSEClientTransport(new URL(server.url));
    } else {
      throw new Error("MCP server requires command or url.");
    }

    const client = new Client(
      { name: "corebot", version: "0.1.0" },
      { capabilities: {} }
    ) as McpClientInstance;

    await client.connect(transport);
    return { client, transport };
  }
};

export class McpManager {
  private clients = new Map<string, McpClientInstance>();
  private tools = new Map<string, McpToolInfo>();
  private factory: McpClientFactory;

  constructor(factory: McpClientFactory = defaultClientFactory) {
    this.factory = factory;
  }

  async loadFromConfig(configPath: string): Promise<ToolDefinition[]> {
    if (!fs.existsSync(configPath)) {
      return [];
    }
    const raw = fs.readFileSync(configPath, "utf-8");
    let parsed: McpConfigFile | null = null;
    try {
      parsed = JSON.parse(raw) as McpConfigFile;
    } catch {
      parsed = null;
    }
    if (!parsed?.servers) {
      return [];
    }

    const toolDefs: ToolDefinition[] = [];

    for (const [name, config] of Object.entries(parsed.servers)) {
      try {
        const serverConfig: McpServerConfig = { name, ...config };
        if (serverConfig.disabled) {
          continue;
        }

        const { client } = await this.factory.createClient(serverConfig);
        this.clients.set(name, client);
        const listResult = await client.listTools();
        const tools = Array.isArray(listResult)
          ? listResult
          : (listResult as { tools?: unknown[] })?.tools ?? [];

        for (const tool of tools as Array<{
          name: string;
          description?: string;
          inputSchema?: Record<string, unknown>;
        }>) {
          const fullName = `mcp__${name}__${tool.name}`;
          const info: McpToolInfo = {
            server: name,
            name: tool.name,
            description: tool.description ?? "MCP tool",
            inputSchema: tool.inputSchema ?? { type: "object", properties: {} }
          };
          this.tools.set(fullName, info);
          toolDefs.push({
            name: fullName,
            description: info.description,
            parameters: info.inputSchema
          });
        }
      } catch (error) {
        console.warn(`[MCP] failed to load server '${name}':`, error);
      }
    }

    return toolDefs;
  }

  async callTool(fullName: string, args: unknown): Promise<unknown> {
    const info = this.tools.get(fullName);
    if (!info) {
      throw new Error(`Unknown MCP tool: ${fullName}`);
    }
    const client = this.clients.get(info.server);
    if (!client) {
      throw new Error(`MCP client not connected for ${info.server}`);
    }
    return client.callTool({ name: info.name, arguments: args });
  }

  async shutdown() {
    for (const client of this.clients.values()) {
      if (client.close) {
        await client.close();
      }
    }
    this.clients.clear();
    this.tools.clear();
  }
}
