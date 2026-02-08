import fs from "node:fs";
import type { ToolDefinition } from "../types.js";
import type { McpConfigFile, McpServerConfig } from "./types.js";
import type { Logger } from "pino";
import { isMcpServerAllowed, isMcpToolAllowed } from "./allowlist.js";

export type McpToolInfo = {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpServerHealth = {
  status: "healthy" | "degraded" | "down";
  tools: number;
  calls: number;
  failures: number;
  lastCheckedAt: string;
  lastError?: string;
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
  private serverHealth = new Map<string, McpServerHealth>();
  private logger?: Pick<Logger, "warn" | "info" | "error" | "debug">;
  private allowedServers: string[];
  private allowedTools: string[];

  constructor(options?: {
    factory?: McpClientFactory;
    logger?: Pick<Logger, "warn" | "info" | "error" | "debug">;
    allowedServers?: string[];
    allowedTools?: string[];
  }) {
    this.factory = options?.factory ?? defaultClientFactory;
    this.logger = options?.logger;
    this.allowedServers = options?.allowedServers ?? [];
    this.allowedTools = options?.allowedTools ?? [];
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
        if (!isMcpServerAllowed(this.allowedServers, name)) {
          this.logger?.info({ server: name }, "MCP server skipped by allowlist");
          continue;
        }

        const { client } = await this.factory.createClient(serverConfig);
        this.clients.set(name, client);
        const listResult = await client.listTools();
        const tools = Array.isArray(listResult)
          ? listResult
          : (listResult as { tools?: unknown[] })?.tools ?? [];
        this.setServerHealth(name, {
          status: "healthy",
          tools: tools.length,
          lastError: undefined
        });

        for (const tool of tools as Array<{
          name: string;
          description?: string;
          inputSchema?: Record<string, unknown>;
        }>) {
          const fullName = `mcp__${name}__${tool.name}`;
          if (
            !isMcpToolAllowed(this.allowedTools, {
              fullName,
              server: name,
              tool: tool.name
            })
          ) {
            this.logger?.info({ tool: fullName }, "MCP tool skipped by allowlist");
            continue;
          }
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
        const message = error instanceof Error ? error.message : String(error);
        this.setServerHealth(name, {
          status: "down",
          tools: 0,
          lastError: message
        });
        if (this.logger) {
          this.logger.warn({ server: name, error: message }, "failed to load MCP server");
        } else {
          console.warn(`[MCP] failed to load server '${name}':`, error);
        }
      }
    }

    return toolDefs;
  }

  async reloadFromConfig(configPath: string): Promise<ToolDefinition[]> {
    await this.closeClients();
    this.tools.clear();
    this.serverHealth.clear();
    return this.loadFromConfig(configPath);
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
    try {
      const result = await client.callTool({ name: info.name, arguments: args });
      this.setServerHealth(info.server, {
        status: "healthy",
        tools: this.getServerToolCount(info.server),
        callAttempt: true,
        callFailed: false
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setServerHealth(info.server, {
        status: "degraded",
        tools: this.getServerToolCount(info.server),
        lastError: message,
        callAttempt: true,
        callFailed: true
      });
      throw error;
    }
  }

  async shutdown() {
    await this.closeClients();
    this.clients.clear();
    this.tools.clear();
    this.serverHealth.clear();
  }

  getHealthSnapshot(): Record<string, McpServerHealth> {
    return Object.fromEntries(
      [...this.serverHealth.entries()].map(([name, health]) => [name, { ...health }])
    );
  }

  private getServerToolCount(server: string): number {
    let count = 0;
    for (const info of this.tools.values()) {
      if (info.server === server) {
        count += 1;
      }
    }
    return count;
  }

  private setServerHealth(
    server: string,
    patch: {
      status: McpServerHealth["status"];
      tools: number;
      lastError?: string;
      callAttempt?: boolean;
      callFailed?: boolean;
    }
  ) {
    const existing = this.serverHealth.get(server);
    const calls = (existing?.calls ?? 0) + (patch.callAttempt ? 1 : 0);
    const failures =
      (existing?.failures ?? 0) + (patch.callFailed ? 1 : 0);
    this.serverHealth.set(server, {
      status: patch.status,
      tools: patch.tools,
      calls,
      failures,
      lastCheckedAt: new Date().toISOString(),
      ...(patch.lastError ? { lastError: patch.lastError } : {})
    });
  }

  private async closeClients() {
    for (const client of this.clients.values()) {
      if (client.close) {
        await client.close();
      }
    }
    this.clients.clear();
  }
}
