import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { Lesson, ReflectionResult } from "./types.js";

/**
 * Persistent lesson ledger. Dedupe uses a normalized token hash so repeated
 * observations accumulate evidence instead of duplicating learned state.
 */
const PROMOTE_MIN_EVIDENCE = 3;
const PROMOTE_MIN_CONFIDENCE = 0.6;
const DECAY = 0.9;
const DECAY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function lessonId(text: string): string {
  const normalized = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).join(" ");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

interface LessonRow {
  id: string;
  text: string;
  tags: string;
  language: string | null;
  kind: string;
  confidence: number;
  evidence_count: number;
  first_seen_at: number;
  last_seen_at: number;
  episode_ids: string;
  promoted_skill_id: string | null;
}

function rowToLesson(row: LessonRow): Lesson {
  const lesson: Lesson = {
    id: row.id,
    text: row.text,
    tags: JSON.parse(row.tags) as string[],
    kind: row.kind as Lesson["kind"],
    confidence: row.confidence,
    evidenceCount: row.evidence_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    episodeIds: JSON.parse(row.episode_ids) as string[],
    promotedSkillId: row.promoted_skill_id,
  };
  if (row.language) lesson.language = row.language;
  return lesson;
}

export class LessonStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lessons (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        tags TEXT NOT NULL,
        language TEXT,
        kind TEXT NOT NULL,
        confidence REAL NOT NULL,
        evidence_count INTEGER NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        episode_ids TEXT NOT NULL,
        promoted_skill_id TEXT
      );
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        verdict TEXT NOT NULL,
        score REAL NOT NULL,
        terminal TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        tool_event_count INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
    `);
  }

  recordEpisode(episode: {
    id: string;
    goal: string;
    verdict: string;
    score: number;
    terminal: string;
    startedAt: number;
    endedAt: number;
    toolEventCount: number;
    payload: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO episodes (id, goal, verdict, score, terminal, started_at, ended_at, tool_event_count, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        episode.id,
        episode.goal,
        episode.verdict,
        episode.score,
        episode.terminal,
        episode.startedAt,
        episode.endedAt,
        episode.toolEventCount,
        episode.payload,
      );
  }

  absorb(result: ReflectionResult, episodeId: string, evidenceWeight: number): Lesson[] {
    const weight = Math.max(0.1, Math.min(0.5, evidenceWeight));
    const now = Date.now();
    const touched: Lesson[] = [];

    const upsert = this.db.transaction(() => {
      for (const candidate of result.lessons) {
        const id = lessonId(candidate.text);
        const existing = this.db.prepare("SELECT * FROM lessons WHERE id = ?").get(id) as LessonRow | undefined;

        if (existing) {
          const episodeIds = JSON.parse(existing.episode_ids) as string[];
          const isNewEvidence = !episodeIds.includes(episodeId);
          if (isNewEvidence) episodeIds.push(episodeId);
          const confidence = existing.confidence + (1 - existing.confidence) * weight;
          this.db
            .prepare(
              `UPDATE lessons
               SET confidence = ?, evidence_count = evidence_count + ?, last_seen_at = ?, episode_ids = ?
               WHERE id = ?`,
            )
            .run(confidence, isNewEvidence ? 1 : 0, now, JSON.stringify(episodeIds.slice(-20)), id);
        } else {
          this.db
            .prepare(
              `INSERT INTO lessons (id, text, tags, language, kind, confidence, evidence_count, first_seen_at, last_seen_at, episode_ids, promoted_skill_id)
               VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL)`,
            )
            .run(
              id,
              candidate.text,
              JSON.stringify(candidate.tags),
              candidate.language ?? null,
              candidate.kind,
              weight,
              now,
              now,
              JSON.stringify([episodeId]),
            );
        }
        touched.push(rowToLesson(this.db.prepare("SELECT * FROM lessons WHERE id = ?").get(id) as LessonRow));
      }
    });
    upsert();
    return touched;
  }

  promotable(): Lesson[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM lessons WHERE promoted_skill_id IS NULL AND evidence_count >= ? AND confidence >= ? ORDER BY confidence DESC",
      )
      .all(PROMOTE_MIN_EVIDENCE, PROMOTE_MIN_CONFIDENCE) as LessonRow[];
    return rows.map(rowToLesson);
  }

  markPromoted(ids: string[], skillId: string): void {
    const stmt = this.db.prepare("UPDATE lessons SET promoted_skill_id = ? WHERE id = ?");
    const tx = this.db.transaction(() => ids.forEach((id) => stmt.run(skillId, id)));
    tx();
  }

  demote(skillId: string): void {
    this.db
      .prepare("UPDATE lessons SET promoted_skill_id = NULL, confidence = confidence * 0.5 WHERE promoted_skill_id = ?")
      .run(skillId);
  }

  promotedLessons(skillId: string): Lesson[] {
    const rows = this.db
      .prepare("SELECT * FROM lessons WHERE promoted_skill_id = ? ORDER BY confidence DESC")
      .all(skillId) as LessonRow[];
    return rows.map(rowToLesson);
  }

  sweep(now = Date.now()): { decayed: number; deleted: number } {
    const decayed = this.db
      .prepare("UPDATE lessons SET confidence = confidence * ? WHERE last_seen_at < ? AND promoted_skill_id IS NULL")
      .run(DECAY, now - DECAY_AFTER_MS).changes;
    const deleted = this.db
      .prepare("DELETE FROM lessons WHERE confidence < 0.1 AND promoted_skill_id IS NULL")
      .run().changes;
    return { decayed, deleted };
  }

  all(): Lesson[] {
    const rows = this.db.prepare("SELECT * FROM lessons ORDER BY confidence DESC").all() as LessonRow[];
    return rows.map(rowToLesson);
  }

  close(): void {
    this.db.close();
  }
}
