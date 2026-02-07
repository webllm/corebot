#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./main.js";

const HELP_TEXT = `corebot - lightweight AI bot runtime

Usage:
  corebot [options]

Options:
  -h, --help      Show help
  -v, --version   Show version
`;

const isDirectExecution = () => {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};

const readVersion = () => {
  try {
    const packagePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "package.json"
    );
    const raw = fs.readFileSync(packagePath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
};

export const runCli = async (args: string[] = process.argv.slice(2)) => {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }
  await main();
};

if (isDirectExecution()) {
  void runCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`corebot startup failed: ${message}\n`);
    process.exit(1);
  });
}
