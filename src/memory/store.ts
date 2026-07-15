import Database from "better-sqlite3";
import { SkillUsageStats } from "../skills/types.js";

export interface StoredMessage {
  role: string;
  content: string;
  at: number;
}

export class MemoryStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_notes (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skill_usage (
        skill_id TEXT PRIMARY KEY,
        use_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS learnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        context TEXT NOT NULL,
        lesson TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        success_count INTEGER DEFAULT 0
      );
    `);
  }

  appendMessage(role: string, content: string): void {
    this.db.prepare("INSERT INTO messages (role, content, at) VALUES (?, ?, ?)").run(role, content, Date.now());
  }

  recentMessages(limit: number): StoredMessage[] {
    const rows = this.db
      .prepare("SELECT role, content, at FROM messages ORDER BY id DESC LIMIT ?")
      .all(limit) as StoredMessage[];
    return rows.reverse();
  }

  setProjectNote(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO project_notes (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  getProjectNote(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM project_notes WHERE key = ?").get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  recordSkillUse(skillId: string, success: boolean): void {
    this.db
      .prepare(
        `INSERT INTO skill_usage (skill_id, use_count, success_count, last_used_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(skill_id) DO UPDATE SET
           use_count = use_count + 1,
           success_count = success_count + excluded.success_count,
           last_used_at = excluded.last_used_at`,
      )
      .run(skillId, success ? 1 : 0, Date.now());
  }

  getSkillUsage(skillId: string): SkillUsageStats | undefined {
    const row = this.db.prepare("SELECT * FROM skill_usage WHERE skill_id = ?").get(skillId) as
      { skill_id: string; use_count: number; success_count: number; last_used_at: number | null } | undefined;
    return row
      ? {
          skillId: row.skill_id,
          useCount: row.use_count,
          successCount: row.success_count,
          lastUsedAt: row.last_used_at,
        }
      : undefined;
  }

  allSkillUsage(): SkillUsageStats[] {
    const rows = this.db.prepare("SELECT * FROM skill_usage").all() as Array<{
      skill_id: string;
      use_count: number;
      success_count: number;
      last_used_at: number | null;
    }>;
    return rows.map((row) => ({
      skillId: row.skill_id,
      useCount: row.use_count,
      successCount: row.success_count,
      lastUsedAt: row.last_used_at,
    }));
  }

  addLearning(category: string, context: string, lesson: string): void {
    this.db
      .prepare("INSERT INTO learnings (category, context, lesson, created_at) VALUES (?, ?, ?, ?)")
      .run(category, context, lesson, Date.now());
  }

  getLearnings(): Array<{ id: number; category: string; context: string; lesson: string; created_at: number; success_count: number }> {
    return this.db.prepare("SELECT * FROM learnings ORDER BY id DESC").all() as any[];
  }

  close(): void {
    this.db.close();
  }
}
