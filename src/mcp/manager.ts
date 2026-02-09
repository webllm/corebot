import fs from "node:fs";
import type { ToolDefinition } from "../types.js";
import type { McpConfigFile, McpServerConfig } from "./types.js";
import type { Logger } from "pino";
import { isMcpServerAllowed, isMcpToolAllowed } from "./allowlist.js";
import { parseMcpConfigJson } from "./config.js";

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

type McpStateSnapshot = {
  clients: Map<string, McpClientInstance>;
  tools: Map<string, McpToolInfo>;
  serverHealth: Map<string, McpServerHealth>;
  toolDefs: ToolDefinition[];
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
  private activeCallsByClient = new Map<McpClientInstance, number>();
  private idleWaitersByClient = new Map<McpClientInstance, Array<() => void>>();
  private readonly closeDrainTimeoutMs: number;
  private logger?: Pick<Logger, "warn" | "info" | "error" | "debug">;
  private allowedServers: string[];
  private allowedTools: string[];

  constructor(options?: {
    factory?: McpClientFactory;
    logger?: Pick<Logger, "warn" | "info" | "error" | "debug">;
    allowedServers?: string[];
    allowedTools?: string[];
    closeDrainTimeoutMs?: number;
  }) {
    this.factory = options?.factory ?? defaultClientFactory;
    this.logger = options?.logger;
    this.allowedServers = options?.allowedServers ?? [];
    this.allowedTools = options?.allowedTools ?? [];
    this.closeDrainTimeoutMs = Math.max(0, options?.closeDrainTimeoutMs ?? 10_000);
  }

  async loadFromConfig(configPath: string): Promise<ToolDefinition[]> {
    return this.reloadFromConfig(configPath);
  }

  async reloadFromConfig(configPath: string): Promise<ToolDefinition[]> {
    const next = await this.buildStateFromConfig(configPath);
    const previousClients = this.clients;

    this.clients = next.clients;
    this.tools = next.tools;
    this.serverHealth = next.serverHealth;

    await this.closeClientMap(previousClients);
    return next.toolDefs;
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
    this.acquireClient(client);
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
    } finally {
      this.releaseClient(client);
    }
  }

  async shutdown() {
    const previousClients = this.clients;
    this.clients = new Map();
    this.tools.clear();
    this.serverHealth.clear();
    await this.closeClientMap(previousClients);
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

  private async buildStateFromConfig(configPath: string): Promise<McpStateSnapshot> {
    if (!fs.existsSync(configPath)) {
      return {
        clients: new Map(),
        tools: new Map(),
        serverHealth: new Map(),
        toolDefs: []
      };
    }

    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed: McpConfigFile = parseMcpConfigJson(raw);

    const clients = new Map<string, McpClientInstance>();
    const tools = new Map<string, McpToolInfo>();
    const serverHealth = new Map<string, McpServerHealth>();
    const toolDefs: ToolDefinition[] = [];

    try {
      for (const [name, config] of Object.entries(parsed.servers)) {
        let client: McpClientInstance | null = null;
        try {
          const serverConfig: McpServerConfig = { name, ...config };
          if (serverConfig.disabled) {
            continue;
          }
          if (!isMcpServerAllowed(this.allowedServers, name)) {
            this.logger?.info({ server: name }, "MCP server skipped by allowlist");
            continue;
          }

          const created = await this.factory.createClient(serverConfig);
          client = created.client;
          const listResult = await client.listTools();
          const remoteTools = Array.isArray(listResult)
            ? listResult
            : (listResult as { tools?: unknown[] })?.tools ?? [];
          clients.set(name, client);
          serverHealth.set(name, {
            status: "healthy",
            tools: remoteTools.length,
            calls: 0,
            failures: 0,
            lastCheckedAt: new Date().toISOString()
          });

          for (const tool of remoteTools as Array<{
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
            tools.set(fullName, info);
            toolDefs.push({
              name: fullName,
              description: info.description,
              parameters: info.inputSchema
            });
          }
        } catch (error) {
          if (client?.close) {
            try {
              await client.close();
            } catch (closeError) {
              const closeMessage =
                closeError instanceof Error ? closeError.message : String(closeError);
              this.logger?.warn(
                { server: name, error: closeMessage },
                "failed to close MCP client after load error"
              );
            }
          }
          const message = error instanceof Error ? error.message : String(error);
          serverHealth.set(name, {
            status: "down",
            tools: 0,
            calls: 0,
            failures: 0,
            lastCheckedAt: new Date().toISOString(),
            lastError: message
          });
          this.logger?.warn({ server: name, error: message }, "failed to load MCP server");
        }
      }
    } catch (error) {
      await this.closeClientMap(clients);
      throw error;
    }

    return {
      clients,
      tools,
      serverHealth,
      toolDefs
    };
  }

  private async closeClientMap(clients: Map<string, McpClientInstance>) {
    for (const [name, client] of clients.entries()) {
      const drained = await this.waitForClientIdle(client);
      if (!drained) {
        this.logger?.warn(
          { server: name, timeoutMs: this.closeDrainTimeoutMs },
          "closing MCP client with active in-flight calls after drain timeout"
        );
      }
      if (!client.close) {
        this.activeCallsByClient.delete(client);
        this.idleWaitersByClient.delete(client);
        continue;
      }
      try {
        await client.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.warn({ server: name, error: message }, "failed to close MCP client");
      } finally {
        this.activeCallsByClient.delete(client);
        this.idleWaitersByClient.delete(client);
      }
    }
    clients.clear();
  }

  private acquireClient(client: McpClientInstance) {
    const active = this.activeCallsByClient.get(client) ?? 0;
    this.activeCallsByClient.set(client, active + 1);
  }

  private releaseClient(client: McpClientInstance) {
    const active = this.activeCallsByClient.get(client) ?? 0;
    const next = Math.max(0, active - 1);
    if (next === 0) {
      this.activeCallsByClient.delete(client);
      const waiters = this.idleWaitersByClient.get(client);
      if (waiters && waiters.length > 0) {
        this.idleWaitersByClient.delete(client);
        for (const waiter of waiters) {
          waiter();
        }
      }
      return;
    }
    this.activeCallsByClient.set(client, next);
  }

  private async waitForClientIdle(client: McpClientInstance): Promise<boolean> {
    if ((this.activeCallsByClient.get(client) ?? 0) === 0) {
      return true;
    }
    if (this.closeDrainTimeoutMs <= 0) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      const waiter = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      const waiters = this.idleWaitersByClient.get(client) ?? [];
      waiters.push(waiter);
      this.idleWaitersByClient.set(client, waiters);

      const timeout = setTimeout(() => {
        this.removeIdleWaiter(client, waiter);
        resolve((this.activeCallsByClient.get(client) ?? 0) === 0);
      }, this.closeDrainTimeoutMs);
    });
  }

  private removeIdleWaiter(client: McpClientInstance, waiter: () => void) {
    const waiters = this.idleWaitersByClient.get(client);
    if (!waiters) {
      return;
    }
    const next = waiters.filter((entry) => entry !== waiter);
    if (next.length === 0) {
      this.idleWaitersByClient.delete(client);
      return;
    }
    this.idleWaitersByClient.set(client, next);
  }
}
