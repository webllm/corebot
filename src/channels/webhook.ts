import http from "node:http";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import type { Config } from "../config/schema.js";
import type { MessageBus } from "../bus/bus.js";
import type { Logger } from "pino";
import type { Channel } from "./base.js";
import { isChannelIdentityAllowed } from "./allowlist.js";

type OutboundEnvelope = {
  id: string;
  chatId: string;
  content: string;
  createdAt: string;
};

export class WebhookChannel implements Channel {
  readonly name = "webhook";
  private bus: MessageBus | null = null;
  private logger: Logger | null = null;
  private server: http.Server | null = null;
  private outbox = new Map<string, OutboundEnvelope[]>();
  private readonly maxOutboxPerChat = 500;

  constructor(private config: Config) {}

  async start(bus: MessageBus, logger: Logger) {
    this.bus = bus;
    this.logger = logger;
    if (this.server) {
      return;
    }

    const inboundPath = this.normalizePath(this.config.webhook.path);
    const outboundPath = `${inboundPath.replace(/\/$/, "")}/outbound`;

    this.server = http.createServer((req, res) => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");

      if (!this.authorized(req)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      if (method === "POST" && url.pathname === inboundPath) {
        void this.handleInbound(req, res);
        return;
      }

      if (method === "GET" && url.pathname === outboundPath) {
        this.handleOutboundPull(url, res);
        return;
      }

      if (method === "GET" && url.pathname === inboundPath) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", channel: this.name }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.config.webhook.port, this.config.webhook.host, () => {
        resolve();
      });
    });
    this.logger.info(
      {
        host: this.config.webhook.host,
        port: this.config.webhook.port,
        path: inboundPath
      },
      "webhook channel listening"
    );
  }

  async stop() {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  async send(payload: { chatId: string; content: string }) {
    const queue = this.outbox.get(payload.chatId) ?? [];
    queue.push({
      id: newId(),
      chatId: payload.chatId,
      content: payload.content,
      createdAt: nowIso()
    });
    if (queue.length > this.maxOutboxPerChat) {
      queue.splice(0, queue.length - this.maxOutboxPerChat);
    }
    this.outbox.set(payload.chatId, queue);
  }

  private normalizePath(pathValue: string) {
    const withPrefix = pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
    return withPrefix.length > 1 && withPrefix.endsWith("/")
      ? withPrefix.slice(0, -1)
      : withPrefix;
  }

  private authorized(req: http.IncomingMessage) {
    const expected = this.config.webhook.authToken;
    if (!expected) {
      return true;
    }
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const token = bearer ?? (req.headers["x-corebot-token"] as string | undefined);
    return token === expected;
  }

  private async handleInbound(
    req: http.IncomingMessage,
    res: http.ServerResponse<http.IncomingMessage>
  ) {
    const payload = await this.parseJsonBody(req);
    if (payload.error) {
      res.writeHead(payload.statusCode, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: payload.error }));
      return;
    }

    const body = payload.body as Record<string, unknown>;
    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : "";
    const content = typeof body.content === "string" ? body.content : "";
    if (!chatId || !content) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "chatId and content are required." }));
      return;
    }

    const senderId =
      typeof body.senderId === "string" && body.senderId.trim() ? body.senderId : "webhook-user";
    const allowed = isChannelIdentityAllowed(this.config.allowedChannelIdentities, senderId);
    if (!allowed) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Sender is not in channel allowlist." }));
      return;
    }

    const createdAt =
      typeof body.createdAt === "string" && body.createdAt.trim() ? body.createdAt : nowIso();
    const inboundId =
      typeof body.id === "string" && body.id.trim() ? body.id : newId();
    const metadata =
      body.metadata && typeof body.metadata === "object" ? (body.metadata as Record<string, unknown>) : undefined;

    this.bus?.publishInbound({
      id: inboundId,
      channel: this.name,
      chatId,
      senderId,
      content,
      createdAt,
      metadata
    });

    res.writeHead(202, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        id: inboundId
      })
    );
  }

  private handleOutboundPull(url: URL, res: http.ServerResponse<http.IncomingMessage>) {
    const chatId = url.searchParams.get("chatId")?.trim() ?? "";
    if (!chatId) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "chatId query is required." }));
      return;
    }
    const limitRaw = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.floor(limitRaw), 1), 200)
      : 50;
    const queue = this.outbox.get(chatId) ?? [];
    const batch = queue.slice(0, limit);
    if (batch.length > 0) {
      queue.splice(0, batch.length);
      if (queue.length === 0) {
        this.outbox.delete(chatId);
      } else {
        this.outbox.set(chatId, queue);
      }
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        chatId,
        messages: batch
      })
    );
  }

  private async parseJsonBody(req: http.IncomingMessage): Promise<{
    body?: unknown;
    error?: string;
    statusCode: number;
  }> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += data.length;
      if (size > this.config.webhook.maxBodyBytes) {
        return {
          error: "Payload too large.",
          statusCode: 413
        };
      }
      chunks.push(data);
    }
    if (chunks.length === 0) {
      return {
        error: "Request body is empty.",
        statusCode: 400
      };
    }
    const raw = Buffer.concat(chunks).toString("utf-8");
    try {
      return {
        body: JSON.parse(raw) as unknown,
        statusCode: 200
      };
    } catch {
      return {
        error: "Invalid JSON body.",
        statusCode: 400
      };
    }
  }
}
