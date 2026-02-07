import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import type { ToolSpec } from "../registry.js";
import { validateWebTargetByPolicy } from "../web-guard.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_CHARS = 200_000;

const isPrivateIpv4 = (ip: string): boolean => {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  return false;
};

const isPrivateIpv6 = (ip: string): boolean => {
  const normalized = ip.toLowerCase();
  if (normalized === "::1" || normalized === "::") {
    return true;
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isPrivateIpv4(mapped);
  }
  return false;
};

const isPrivateAddress = (ip: string): boolean => {
  const version = isIP(ip);
  if (version === 4) {
    return isPrivateIpv4(ip);
  }
  if (version === 6) {
    return isPrivateIpv6(ip);
  }
  return true;
};

const assertPublicUrl = async (
  url: URL,
  rules: { allowedDomains: string[]; allowedPorts: number[]; blockedPorts: number[] }
) => {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http/https URLs are allowed.");
  }

  const policyError = validateWebTargetByPolicy(url, {
    allowedWebDomains: rules.allowedDomains,
    allowedWebPorts: rules.allowedPorts,
    blockedWebPorts: rules.blockedPorts
  });
  if (policyError) {
    throw new Error(policyError);
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Localhost access is blocked.");
  }

  if (isIP(hostname) > 0) {
    if (isPrivateAddress(hostname)) {
      throw new Error("Private network access is blocked.");
    }
    return;
  }

  const resolved = await lookup(hostname, { all: true, verbatim: true });
  if (resolved.length === 0) {
    throw new Error("Unable to resolve host.");
  }
  if (resolved.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("Private network access is blocked.");
  }
};

const readBodyWithLimit = async (
  response: Response,
  maxChars: number
): Promise<{ body: string; truncated: boolean }> => {
  if (!response.body) {
    return { body: "", truncated: false };
  }

  let output = "";
  let truncated = false;

  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    output += Buffer.from(chunk).toString("utf-8");
    if (output.length > maxChars) {
      output = output.slice(0, maxChars);
      truncated = true;
      break;
    }
  }

  return { body: output, truncated };
};

const getAllowedEnv = (key: string, allowed: string[]) => {
  if (allowed.includes(key)) {
    return process.env[key];
  }
  return undefined;
};

export const webTools = (): ToolSpec<any>[] => {
  const fetchTool: ToolSpec<z.ZodTypeAny> = {
    name: "web.fetch",
    description: "Fetch a URL over HTTP.",
    schema: z.object({
      url: z.string().url(),
      method: z.enum(["GET", "POST"]).default("GET"),
      headers: z.record(z.string()).optional(),
      body: z.string().optional(),
      timeoutMs: z.number().int().min(1_000).max(120_000).default(DEFAULT_TIMEOUT_MS),
      maxResponseChars: z
        .number()
        .int()
        .min(1_000)
        .max(1_000_000)
        .default(DEFAULT_MAX_RESPONSE_CHARS)
    }),
    async run(args, ctx) {
      const url = new URL(args.url);
      await assertPublicUrl(url, {
        allowedDomains: ctx.config.allowedWebDomains,
        allowedPorts: ctx.config.allowedWebPorts,
        blockedPorts: ctx.config.blockedWebPorts
      });
      const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxResponseChars = args.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS;

      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);

      const response = await fetch(url.toString(), {
        method: args.method,
        headers: args.headers,
        body: args.method === "POST" ? args.body : undefined,
        signal: abort.signal,
        redirect: "error"
      }).finally(() => {
        clearTimeout(timer);
      });

      const { body, truncated } = await readBodyWithLimit(response, maxResponseChars);
      return JSON.stringify(
        {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body,
          truncated
        },
        null,
        2
      );
    }
  };

  const searchTool: ToolSpec<z.ZodTypeAny> = {
    name: "web.search",
    description: "Search the web using Brave Search API.",
    schema: z.object({
      query: z.string().min(1),
      count: z.number().int().min(1).max(10).default(5)
    }),
    async run(args, ctx) {
      const apiKey = getAllowedEnv("BRAVE_API_KEY", ctx.config.allowedEnv);
      if (!apiKey) {
        throw new Error("BRAVE_API_KEY not available.");
      }
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", args.query);
      url.searchParams.set("count", String(args.count));
      const response = await fetch(url.toString(), {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey
        }
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Brave search failed: ${response.status} ${body}`);
      }
      const data = await response.json();
      return JSON.stringify(data, null, 2);
    }
  };

  return [fetchTool, searchTool];
};
