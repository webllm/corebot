import { spawn } from "node:child_process";

type WorkerRequest = {
  toolName: "shell.exec";
  request: {
    command: string;
    cwd: string;
    timeoutMs: number;
    allowShell: boolean;
    allowedShellCommands: string[];
    env: Record<string, string>;
    maxOutputChars: number;
  };
};

type WorkerResponse =
  | {
      ok: true;
      result: string;
    }
  | {
      ok: false;
      error: string;
    };

const appendWithLimit = (
  current: string,
  chunk: string,
  maxChars: number
): { value: string; truncated: boolean } => {
  if (current.length >= maxChars) {
    return { value: current, truncated: true };
  }
  const next = current + chunk;
  if (next.length <= maxChars) {
    return { value: next, truncated: false };
  }
  return { value: next.slice(0, maxChars), truncated: true };
};

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

const readStdin = async (): Promise<string> => {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });
};

const executeShell = async (request: WorkerRequest["request"]): Promise<string> => {
  if (!request.allowShell) {
    throw new Error("Shell execution is disabled.");
  }

  const tokens = tokenizeCommand(request.command);
  if (tokens.length === 0) {
    throw new Error("Command is empty.");
  }
  const [file, ...args] = tokens;

  if (request.allowedShellCommands.length > 0) {
    const allowed = request.allowedShellCommands.includes(file);
    if (!allowed) {
      throw new Error("Executable not in allowlist.");
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: request.cwd,
      env: request.env,
      shell: false
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed && child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 1_000);
    }, request.timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      const appended = appendWithLimit(stdout, chunk.toString(), request.maxOutputChars);
      stdout = appended.value;
      truncated = truncated || appended.truncated;
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const appended = appendWithLimit(stderr, chunk.toString(), request.maxOutputChars);
      stderr = appended.value;
      truncated = truncated || appended.truncated;
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command timed out after ${request.timeoutMs}ms.`));
        return;
      }
      if (code !== 0) {
        const message = stderr.trim() || `Command exited with code ${code}.`;
        reject(new Error(message));
        return;
      }
      let output = [stdout, stderr].filter(Boolean).join("\n").trim();
      if (truncated) {
        output = output
          ? `${output}\n...truncated`
          : "...truncated";
      }
      resolve(output);
    });
  });
};

const writeResponse = (response: WorkerResponse) => {
  process.stdout.write(JSON.stringify(response));
};

const main = async () => {
  try {
    const raw = await readStdin();
    const request = JSON.parse(raw) as WorkerRequest;
    if (request.toolName !== "shell.exec") {
      throw new Error(`unsupported isolated tool: ${request.toolName}`);
    }
    const result = await executeShell(request.request);
    writeResponse({
      ok: true,
      result
    });
  } catch (error) {
    writeResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
    process.exitCode = 1;
  }
};

void main();
