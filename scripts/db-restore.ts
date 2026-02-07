import fs from "node:fs";
import path from "node:path";

const parseArg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    return undefined;
  }
  return value;
};

const hasFlag = (name: string) => process.argv.includes(name);

const nowStamp = () => new Date().toISOString().replace(/[:.]/g, "-");

const main = () => {
  const fromPath = parseArg("--from");
  if (!fromPath) {
    throw new Error("Missing required argument: --from <backup.sqlite>");
  }

  const source = path.resolve(fromPath);
  if (!fs.existsSync(source)) {
    throw new Error(`Backup file not found: ${source}`);
  }

  const dbPath = path.resolve(parseArg("--db") ?? process.env.COREBOT_SQLITE_PATH ?? "data/bot.sqlite");
  const force = hasFlag("--force");
  if (!force) {
    throw new Error("Refusing restore without --force. Stop bot process, then retry with --force.");
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  if (fs.existsSync(dbPath)) {
    const preRestore = `${dbPath}.pre-restore-${nowStamp()}.sqlite`;
    fs.copyFileSync(dbPath, preRestore);
    process.stdout.write(`Pre-restore snapshot: ${preRestore}\n`);
  }

  const tempPath = `${dbPath}.restore-tmp-${Date.now()}`;
  fs.copyFileSync(source, tempPath);
  fs.renameSync(tempPath, dbPath);

  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  if (fs.existsSync(walPath)) {
    fs.rmSync(walPath, { force: true });
  }
  if (fs.existsSync(shmPath)) {
    fs.rmSync(shmPath, { force: true });
  }

  process.stdout.write(`Restore complete: ${dbPath}\n`);
};

main();
