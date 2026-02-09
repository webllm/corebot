import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/bin.js";
import { runPreflightChecks } from "../src/preflight.js";

test("runPreflightChecks validates explicit MCP config path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corebot-preflight-"));
  try {
    const mcpPath = path.join(root, "mcp.json");
    fs.writeFileSync(mcpPath, JSON.stringify({ servers: { demo: { command: "noop" } } }), "utf-8");

    const report = runPreflightChecks({ mcpConfigPath: mcpPath });
    assert.equal(report.mcpConfigPresent, true);
    assert.equal(report.mcpServerCount, 1);
    assert.equal(report.resolvedMcpConfigPath, path.resolve(mcpPath));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("corebot preflight command accepts missing MCP config file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corebot-preflight-missing-"));
  try {
    const mcpPath = path.join(root, "missing.json");
    await runCli(["preflight", "--mcp-config", mcpPath]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("corebot preflight command rejects invalid MCP config", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corebot-preflight-invalid-"));
  try {
    const mcpPath = path.join(root, "mcp.json");
    fs.writeFileSync(
      mcpPath,
      JSON.stringify({
        servers: {
          broken: { command: "noop", url: "http://localhost:4321" }
        }
      }),
      "utf-8"
    );
    await assert.rejects(
      runCli(["preflight", "--mcp-config", mcpPath]),
      /Invalid MCP config/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

