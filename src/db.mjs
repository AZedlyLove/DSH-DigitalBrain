import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS memories (
  id               TEXT PRIMARY KEY,
  layer            TEXT NOT NULL,              -- warm | cold | forgotten
  content          TEXT NOT NULL,
  summary          TEXT,                       -- Cold 层的压缩摘要
  importance       REAL NOT NULL,
  pad_p            REAL NOT NULL DEFAULT 0,    -- 情绪向量 P
  pad_a            REAL NOT NULL DEFAULT 0,    -- A
  pad_d            REAL NOT NULL DEFAULT 0,    -- D
  created_at       INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  access_count     INTEGER NOT NULL DEFAULT 1,
  memory_type      TEXT NOT NULL,              -- episodic | semantic | procedural
  tau_days         REAL NOT NULL DEFAULT 3,    -- 该条的记忆强度时间常数
  derived_from     TEXT,                       -- JSON 数组：由哪些记忆合成
  vec              BLOB,                       -- Float32 归一化嵌入
  meta             TEXT                        -- JSON：来源、session、行为标签等
);

CREATE TABLE IF NOT EXISTS edges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  type       TEXT NOT NULL,                    -- entity_cooccur | affect_align | causal_temporal
  weight     REAL NOT NULL DEFAULT 0.5,
  created_at INTEGER NOT NULL,
  UNIQUE(from_id, to_id, type)
);

CREATE TABLE IF NOT EXISTS hot (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session    TEXT NOT NULL,
  role       TEXT NOT NULL,                    -- user | assistant
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turn_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session    TEXT NOT NULL,
  user_text  TEXT,
  reply_text TEXT,
  behavior   TEXT,
  at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS forget_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  score     REAL NOT NULL,
  reason    TEXT NOT NULL,
  at        INTEGER NOT NULL,
  meta      TEXT
);

-- 她自己“做过的事”：写日志、改签名、主动搭话、刷视频……对外可见的产出都落这里
CREATE TABLE IF NOT EXISTS journal (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  kind    TEXT NOT NULL,              -- diary | signature | moment | share | note
  content TEXT NOT NULL,
  meta    TEXT
);

-- 自主行为的执行流水（限流、冷却、审计都靠它）
CREATE TABLE IF NOT EXISTS actions_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  action  TEXT NOT NULL,
  drive   TEXT,
  ok      INTEGER NOT NULL DEFAULT 1,
  detail  TEXT
);

CREATE INDEX IF NOT EXISTS idx_mem_layer ON memories(layer);
CREATE INDEX IF NOT EXISTS idx_mem_created ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_edge_from ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_actions_at ON actions_log(at);
`;

export function openDb(file = 'brain.sqlite') {
  const abs = path.resolve(file)
  fs.mkdirSync(path.dirname(abs), { recursive: true })

  // 一个进程内只允许一个写者：打开时先 try 一个 lock 文件
  const db = new DatabaseSync(abs)
  db.exec(SCHEMA)
  return db
}

export function getState(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key)
  if (!row) return fallback
  try { return JSON.parse(row.value) } catch { return fallback }
}

export function setState(db, key, value) {
  db.prepare('INSERT INTO state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value))
}

export function tx(db, fn) {
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  }
}

/* ---------- journal / actions_log：她自己做过的事 ---------- */

export function appendJournal(db, { at = Date.now(), kind, content, meta = null }) {
  db.prepare('INSERT INTO journal(at, kind, content, meta) VALUES (?,?,?,?)')
    .run(at, kind, content, meta ? JSON.stringify(meta) : null)
  return { at, kind, content }
}

export function listJournal(db, { kind, limit = 20 } = {}) {
  const sql = kind
    ? 'SELECT * FROM journal WHERE kind = ? ORDER BY id DESC LIMIT ?'
    : 'SELECT * FROM journal ORDER BY id DESC LIMIT ?'
  return kind ? db.prepare(sql).all(kind, limit) : db.prepare(sql).all(limit)
}

export function logAction(db, { at = Date.now(), action, drive = null, ok = 1, detail = null }) {
  db.prepare('INSERT INTO actions_log(at, action, drive, ok, detail) VALUES (?,?,?,?,?)')
    .run(at, action, drive, ok ? 1 : 0, detail == null ? null : JSON.stringify(detail))
}

export function actionsSince(db, action, since) {
  return db.prepare('SELECT COUNT(*) c FROM actions_log WHERE action = ? AND at >= ? AND ok = 1').get(action, since).c
}

export function lastAttemptAt(db, action) {
  const row = db.prepare('SELECT at FROM actions_log WHERE action = ? ORDER BY id DESC LIMIT 1').get(action)
  return row?.at ?? null
}

export function lastActionAt(db, action) {
  const row = db.prepare('SELECT at FROM actions_log WHERE action = ? AND ok = 1 ORDER BY id DESC LIMIT 1').get(action)
  return row?.at ?? null
}

