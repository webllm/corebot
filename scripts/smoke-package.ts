import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf-8",
    stdio: "pipe"
  });
  if (result.status !== 0) {
    const stderr = result.stderr || "";
    const stdout = result.stdout || "";
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}\n${stdout}\n${stderr}`
    );
  }
  return result.stdout ?? "";
};

const assert = (condition: unknown, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const ensureBuildArtifacts = () => {
  const required = ["dist/bin.js", "dist/index.js", "dist/index.d.ts"];
  for (const filePath of required) {
    assert(fs.existsSync(path.resolve(filePath)), `Missing build artifact: ${filePath}`);
  }
};

const smokeCli = () => {
  const help = run("node", ["dist/bin.js", "--help"]);
  assert(help.includes("Usage:"), "CLI help output is missing Usage section.");
  const version = run("node", ["dist/bin.js", "--version"]).trim();
  const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf-8")) as {
    version?: string;
  };
  assert(version === (pkg.version ?? ""), "CLI --version output does not match package version.");
};

const smokeSdk = async () => {
  const sdk = await import(pathToFileURL(path.resolve("dist/index.js")).href);
  assert(typeof sdk.createCorebotApp === "function", "SDK export createCorebotApp is missing.");
  assert(typeof sdk.main === "function", "SDK export main is missing.");
};

const smokePack = () => {
  const out = run(npmCmd, ["pack", "--dry-run", "--json"]);
  const parsed = JSON.parse(out) as Array<{
    files: Array<{ path: string }>;
  }>;
  const files = parsed[0]?.files?.map((item) => item.path) ?? [];

  const mustHave = ["dist/bin.js", "dist/index.js", "dist/index.d.ts"];
  for (const filePath of mustHave) {
    assert(files.includes(filePath), `Packed artifact missing: ${filePath}`);
  }

  const blockedPrefixes = ["nanobot/", "nanoclaw/", "coremind/", "src/", "test/"];
  const leaked = files.find((entry) =>
    blockedPrefixes.some((prefix) => entry.startsWith(prefix))
  );
  assert(!leaked, `Packed artifact leaked unexpected file: ${leaked}`);
};

const main = async () => {
  ensureBuildArtifacts();
  smokeCli();
  await smokeSdk();
  smokePack();
  process.stdout.write("smoke-package passed\n");
};

void main();
