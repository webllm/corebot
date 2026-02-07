import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCorebotApp } from "./app.js";

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

export const main = async () => {
  const app = await createCorebotApp();

  const shutdown = async () => {
    await app.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  await app.start();
};

if (isDirectExecution()) {
  void main();
}
