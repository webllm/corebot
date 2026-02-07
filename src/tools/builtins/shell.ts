import { spawn } from "node:child_process";
import { z } from "zod";
import { resolveWorkspacePath } from "../../util/file.js";
import type { ToolSpec } from "../registry.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;

const tokenizeCommand = (input: string): string[] => {
  const command = input.trim();
  if (!command) {
    return [];
  }

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped || quote) {
    throw new Error("Invalid command format: unterminated escape or quote.");
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
};

const resolveCommandInvocation = (params: {
  command: string;
  allowShell: boolean;
  allowedShellCommands: string[];
}): { file: string; args: string[] } => {
  if (!params.allowShell) {
    throw new Error("Shell execution is disabled.");
  }

  const tokens = tokenizeCommand(params.command);
  if (tokens.length === 0) {
    throw new Error("Command is empty.");
  }
  const [file, ...fileArgs] = tokens;

  if (params.allowedShellCommands.length > 0) {
    const allowed = params.allowedShellCommands.includes(file);
    if (!allowed) {
      throw new Error("Executable not in allowlist.");
    }
  }

  return { file, args: fileArgs };
};

const runDirectCommand = async (params: {
  file: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(params.file, params.args, {
      cwd: params.cwd,
      shell: false,
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, params.timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command timed out after ${params.timeoutMs}ms.`));
        return;
      }
      if (code !== 0) {
        const message = stderr.trim() || `Command exited with code ${code}.`;
        reject(new Error(message));
        return;
      }
      resolve([stdout, stderr].filter(Boolean).join("\n").trim());
    });
  });

export const shellTools = (): ToolSpec<any>[] => {
  const shellExec: ToolSpec<z.ZodTypeAny> = {
    name: "shell.exec",
    description:
      "Execute a shell command within the workspace using isolated runtime when enabled.",
    schema: z.object({
      command: z.string(),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS)
    }),
    async run(args, ctx) {
      const invocation = resolveCommandInvocation({
        command: args.command,
        allowShell: ctx.config.allowShell,
        allowedShellCommands: ctx.config.allowedShellCommands
      });
      const cwd = args.cwd
        ? resolveWorkspacePath(ctx.workspaceDir, args.cwd)
        : ctx.workspaceDir;
      const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      const isolatedRuntime = ctx.isolatedRuntime;
      if (isolatedRuntime?.isToolIsolated("shell.exec")) {
        return isolatedRuntime.executeShell({
          command: args.command,
          cwd,
          timeoutMs,
          allowShell: ctx.config.allowShell,
          allowedShellCommands: ctx.config.allowedShellCommands,
          allowedEnvKeys: ctx.config.allowedEnv,
          maxOutputChars: ctx.config.maxToolOutputChars
        });
      }

      return runDirectCommand({
        file: invocation.file,
        args: invocation.args,
        cwd,
        timeoutMs
      });
    }
  };

  return [shellExec];
};
