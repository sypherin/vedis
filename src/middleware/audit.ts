import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditConfig, AuditEntry } from '../types.js';

export class AuditLogger {
  private jsonlPath: string | null;
  private db: unknown = null;
  private insertStmt: unknown = null;

  constructor(config?: AuditConfig) {
    const enabled = config?.enabled ?? true;
    this.jsonlPath = enabled ? (config?.jsonl ?? null) : null;

    if (this.jsonlPath) {
      mkdirSync(dirname(this.jsonlPath) || '.', { recursive: true });
    }

    // SQLite is optional — only init if configured
    if (enabled && config?.sqlite) {
      this.initSqlite(config.sqlite);
    }
  }

  private async initSqlite(path: string): Promise<void> {
    try {
      const mod = await import('better-sqlite3');
      const Database = mod.default ?? mod;
      const db = new (Database as new (path: string) => { exec: (sql: string) => void; prepare: (sql: string) => unknown })(path);
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          direction TEXT NOT NULL,
          method TEXT NOT NULL,
          tool TEXT,
          blocked INTEGER NOT NULL DEFAULT 0,
          threats TEXT,
          filtered TEXT,
          latency_ms INTEGER
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit(timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit(tool);
        CREATE INDEX IF NOT EXISTS idx_audit_blocked ON audit(blocked);
      `);
      this.db = db;
      this.insertStmt = db.prepare(`
        INSERT INTO audit (timestamp, direction, method, tool, blocked, threats, filtered, latency_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
    } catch {
      // SQLite optional — if better-sqlite3 not available, skip
      this.db = null;
    }
  }

  log(entry: AuditEntry): void {
    // JSONL output
    if (this.jsonlPath) {
      try {
        appendFileSync(this.jsonlPath, JSON.stringify(entry) + '\n');
      } catch { /* best effort */ }
    }

    // SQLite output
    if (this.insertStmt) {
      try {
        (this.insertStmt as { run: (...args: unknown[]) => void }).run(
          entry.timestamp,
          entry.direction,
          entry.method,
          entry.tool ?? null,
          entry.blocked ? 1 : 0,
          JSON.stringify(entry.threats),
          JSON.stringify(entry.filtered),
          entry.latencyMs,
        );
      } catch { /* best effort */ }
    }
  }

  close(): void {
    if (this.db) {
      try { (this.db as { close: () => void }).close(); } catch { /* */ }
    }
  }
}
