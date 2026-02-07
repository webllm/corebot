import type { Config } from "../config/schema.js";

export const normalizeDomain = (value: string) =>
  value.trim().toLowerCase().replace(/^\*\./, "");

export const isAllowedHostname = (hostname: string, allowedDomains: string[]): boolean => {
  if (allowedDomains.length === 0) {
    return true;
  }

  const normalizedHost = hostname.toLowerCase();
  return allowedDomains
    .map(normalizeDomain)
    .some((domain) => normalizedHost === domain || normalizedHost.endsWith(`.${domain}`));
};

export const getPortFromUrl = (url: URL): number => {
  if (url.port) {
    const parsed = Number(url.port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error("Invalid target port.");
    }
    return parsed;
  }
  return url.protocol === "https:" ? 443 : 80;
};

export const validateWebTargetByPolicy = (
  url: URL,
  config: Pick<Config, "allowedWebDomains" | "allowedWebPorts" | "blockedWebPorts">
): string | null => {
  const port = getPortFromUrl(url);
  if (config.blockedWebPorts.includes(port)) {
    return `Target port ${port} is blocked.`;
  }
  if (config.allowedWebPorts.length > 0 && !config.allowedWebPorts.includes(port)) {
    return `Target port ${port} is not in allowlist.`;
  }

  if (!isAllowedHostname(url.hostname, config.allowedWebDomains)) {
    return "Target host is not in allowlist.";
  }

  return null;
};
