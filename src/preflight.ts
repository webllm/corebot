import path from "node:path";
import { loadConfig } from "./config/load.js";
import { readMcpConfigFile } from "./mcp/config.js";

export type PreflightOptions = {
  mcpConfigPath?: string;
};

export type PreflightReport = {
  resolvedMcpConfigPath: string;
  mcpConfigPresent: boolean;
  mcpServerCount: number;
};

export const runPreflightChecks = (options: PreflightOptions = {}): PreflightReport => {
  const config = loadConfig();
  const resolvedMcpConfigPath = path.resolve(options.mcpConfigPath ?? config.mcpConfigPath);
  const mcpConfig = readMcpConfigFile(resolvedMcpConfigPath);

  return {
    resolvedMcpConfigPath,
    mcpConfigPresent: mcpConfig !== null,
    mcpServerCount: mcpConfig ? Object.keys(mcpConfig.servers).length : 0
  };
};

