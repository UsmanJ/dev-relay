import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";
import { dbPath, migrationsDir } from "../config";

export type Db = BetterSQLite3Database<typeof schema>;

type Holder = { db: Db; sqlite: Database.Database; path: string };
const g = globalThis as unknown as { __devrelayDb?: Holder };

/** Open (and migrate) the SQLite database. Singleton per process and path. */
export function getDb(): Db {
  const p = dbPath();
  if (g.__devrelayDb && g.__devrelayDb.path === p) return g.__devrelayDb.db;
  if (g.__devrelayDb) g.__devrelayDb.sqlite.close();
  const sqlite = new Database(p);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsDir() });
  g.__devrelayDb = { db, sqlite, path: p };
  return db;
}

export function closeDb(): void {
  if (g.__devrelayDb) {
    g.__devrelayDb.sqlite.close();
    g.__devrelayDb = undefined;
  }
}

export { schema };