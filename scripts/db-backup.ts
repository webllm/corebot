import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

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

const nowStamp = () => new Date().toISOString().replace(/[:.]/g, "-");

const main = () => {
  const dbPath = path.resolve(parseArg("--db") ?? process.env.COREBOT_SQLITE_PATH ?? "data/bot.sqlite");
  if (!fs.existsSync(dbPath)) {
    throw new Error(`SQLite file not found: ${dbPath}`);
  }

  const outputArg = parseArg("--out");
  const outputPath = path.resolve(
    outputArg ?? path.join(path.dirname(dbPath), "backups", `manual-${nowStamp()}.sqlite`)
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const db = new Database(dbPath, { readonly: true });
  try {
    const escaped = outputPath.replace(/'/g, "''");
    db.exec(`VACUUM main INTO '${escaped}'`);
  } finally {
    db.close();
  }

  process.stdout.write(`Backup created: ${outputPath}\n`);
};

main();
