import net from "node:net";
import test from "node:test";
import assert from "node:assert/strict";
import { MessageBus } from "../src/bus/bus.js";
import { WebhookChannel } from "../src/channels/webhook.js";
import { createStorageFixture } from "./test-utils.js";

const getFreePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });

const waitUntil = async (predicate: () => boolean, timeoutMs = 2_000, intervalMs = 25) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
};

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
} as any;

test("WebhookChannel accepts inbound POST and publishes bus message", async () => {
  const fixture = createStorageFixture({
    webhook: {
      enabled: true,
      host: "127.0.0.1",
      port: await getFreePort(),
      path: "/ingress",
      authToken: "token-123"
    }
  });

  const bus = new MessageBus(fixture.storage, fixture.config, logger);
  const channel = new WebhookChannel(fixture.config);
  const inbound: Array<{ id: string; chatId: string; content: string; channel: string }> = [];

  try {
    bus.onInbound(async (message) => {
      inbound.push({
        id: message.id,
        chatId: message.chatId,
        content: message.content,
        channel: message.channel
      });
    });
    bus.start();
    await channel.start(bus, logger);

    const res = await fetch(
      `http://${fixture.config.webhook.host}:${fixture.config.webhook.port}${fixture.config.webhook.path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer token-123"
        },
        body: JSON.stringify({
          chatId: "c-1",
          senderId: "u-1",
          content: "hello webhook"
        })
      }
    );
    assert.equal(res.status, 202);
    const body = (await res.json()) as { id?: string };
    assert.ok(body.id);

    await waitUntil(() => inbound.length >= 1);
    assert.equal(inbound[0]?.chatId, "c-1");
    assert.equal(inbound[0]?.content, "hello webhook");
    assert.equal(inbound[0]?.channel, "webhook");
  } finally {
    bus.stop();
    await channel.stop();
    fixture.cleanup();
  }
});

test("WebhookChannel stores outbound messages and supports pull API", async () => {
  const fixture = createStorageFixture({
    webhook: {
      enabled: true,
      host: "127.0.0.1",
      port: await getFreePort(),
      path: "/webhook",
      authToken: undefined
    }
  });

  const bus = new MessageBus(fixture.storage, fixture.config, logger);
  const channel = new WebhookChannel(fixture.config);

  try {
    await channel.start(bus, logger);
    await channel.send({
      chatId: "chat-x",
      content: "first"
    });
    await channel.send({
      chatId: "chat-x",
      content: "second"
    });

    const base = `http://${fixture.config.webhook.host}:${fixture.config.webhook.port}${fixture.config.webhook.path}/outbound?chatId=chat-x`;
    const firstRes = await fetch(`${base}&limit=1`);
    assert.equal(firstRes.status, 200);
    const firstBody = (await firstRes.json()) as {
      messages: Array<{ content: string }>;
    };
    assert.equal(firstBody.messages.length, 1);
    assert.equal(firstBody.messages[0]?.content, "first");

    const secondRes = await fetch(`${base}&limit=10`);
    const secondBody = (await secondRes.json()) as {
      messages: Array<{ content: string }>;
    };
    assert.equal(secondBody.messages.length, 1);
    assert.equal(secondBody.messages[0]?.content, "second");

    const emptyRes = await fetch(`${base}&limit=10`);
    const emptyBody = (await emptyRes.json()) as {
      messages: Array<{ content: string }>;
    };
    assert.equal(emptyBody.messages.length, 0);
  } finally {
    await channel.stop();
    fixture.cleanup();
  }
});

test("WebhookChannel enforces auth token when configured", async () => {
  const fixture = createStorageFixture({
    webhook: {
      enabled: true,
      host: "127.0.0.1",
      port: await getFreePort(),
      path: "/hook",
      authToken: "top-secret"
    }
  });

  const bus = new MessageBus(fixture.storage, fixture.config, logger);
  const channel = new WebhookChannel(fixture.config);

  try {
    await channel.start(bus, logger);
    const base = `http://${fixture.config.webhook.host}:${fixture.config.webhook.port}${fixture.config.webhook.path}`;

    const unauthorized = await fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        chatId: "c-unauth",
        content: "nope"
      })
    });
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-corebot-token": "top-secret"
      },
      body: JSON.stringify({
        chatId: "c-ok",
        content: "ok"
      })
    });
    assert.equal(authorized.status, 202);
  } finally {
    await channel.stop();
    fixture.cleanup();
  }
});

test("WebhookChannel enforces configured channel identity allowlist", async () => {
  const fixture = createStorageFixture({
    allowedChannelIdentities: ["@alice", "42|service-bot"],
    webhook: {
      enabled: true,
      host: "127.0.0.1",
      port: await getFreePort(),
      path: "/allow",
      authToken: undefined
    }
  });

  const bus = new MessageBus(fixture.storage, fixture.config, logger);
  const channel = new WebhookChannel(fixture.config);

  try {
    await channel.start(bus, logger);
    const base = `http://${fixture.config.webhook.host}:${fixture.config.webhook.port}${fixture.config.webhook.path}`;

    const denied = await fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        chatId: "c-denied",
        senderId: "7|mallory",
        content: "no"
      })
    });
    assert.equal(denied.status, 403);

    const allowed = await fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        chatId: "c-ok",
        senderId: "7|alice",
        content: "ok"
      })
    });
    assert.equal(allowed.status, 202);
  } finally {
    await channel.stop();
    fixture.cleanup();
  }
});
