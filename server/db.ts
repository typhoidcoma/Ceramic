import path from "node:path";
import fs from "node:fs";
import sqlite3 from "sqlite3";
import { open, type Database } from "sqlite";

let dbInstance: Database | null = null;

export type AtomRow = {
  id: string;
  type: string;
  state: string;
  ts: string;
  due: string | null;
  urgency: number;
  importance: number;
  title: string | null;
  preview: string | null;
  payload: string | null;
};

function resolveDbPath(): string {
  const configured = process.env.DB_PATH?.trim();
  if (configured) return path.resolve(configured);
  return path.resolve(process.cwd(), "data", "ceramic.db");
}

export async function getDb(): Promise<Database> {
  if (dbInstance) return dbInstance;
  const filename = resolveDbPath();
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  dbInstance = await open({ filename, driver: sqlite3.Database });
  await dbInstance.exec("PRAGMA journal_mode=WAL;");
  await dbInstance.exec("PRAGMA foreign_keys=ON;");
  return dbInstance;
}

export async function initializeDatabase(): Promise<void> {
  const db = await getDb();
  const schemaPath = path.resolve(process.cwd(), "server", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  await db.exec(sql);
}
