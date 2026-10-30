// Neon Postgres access. Tables are created on first use, so a fresh database needs no setup step.
import { neon } from '@neondatabase/serverless';

let sql = null;
let ready = null;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS photo_groups (
     class_no INTEGER NOT NULL,
     group_no INTEGER NOT NULL,
     pw_hash TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (class_no, group_no)
   )`,
  // One row per group: the primary key is what limits every group to a single selected photo.
  `CREATE TABLE IF NOT EXISTS photo_selections (
     class_no INTEGER NOT NULL,
     group_no INTEGER NOT NULL,
     file_id TEXT NOT NULL,
     file_name TEXT NOT NULL,
     selected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (class_no, group_no)
   )`,
  `CREATE TABLE IF NOT EXISTS photo_teachers (
     id SERIAL PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     class_no INTEGER NOT NULL,
     pw_hash TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Whole-class photo chosen by a teacher: one per class, remembering which teacher chose it.
  `CREATE TABLE IF NOT EXISTS photo_class_picks (
     class_no INTEGER PRIMARY KEY,
     file_id TEXT NOT NULL,
     file_name TEXT NOT NULL,
     teacher_id INTEGER,
     teacher_name TEXT NOT NULL,
     selected_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Every select / cancel by anyone, so the final admin can see the full history.
  `CREATE TABLE IF NOT EXISTS photo_log (
     id SERIAL PRIMARY KEY,
     at TIMESTAMPTZ NOT NULL DEFAULT now(),
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     class_no INTEGER,
     group_no INTEGER,
     file_id TEXT,
     file_name TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS photo_settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

export function hasDatabase() {
  return Boolean(process.env.DATABASE_URL);
}

export async function query(text, params = []) {
  if (!sql) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL 환경 변수가 없어요.');
    sql = neon(process.env.DATABASE_URL);
  }
  if (!ready) {
    ready = (async () => { for (const s of SCHEMA) await sql.query(s); })().catch((e) => { ready = null; throw e; });
  }
  await ready;
  return sql.query(text, params);
}

export async function getGroup(classNo, groupNo) {
  const rows = await query('SELECT pw_hash FROM photo_groups WHERE class_no = $1 AND group_no = $2', [classNo, groupNo]);
  return rows[0] || null;
}

export async function getSetting(key, fallback = null) {
  const rows = await query('SELECT value FROM photo_settings WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : fallback;
}

export async function setSetting(key, value) {
  await query(
    'INSERT INTO photo_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, String(value)],
  );
}

export async function getTeacher(id) {
  const rows = await query('SELECT id, name, class_no, pw_hash FROM photo_teachers WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function log(actor, action, { classNo = null, groupNo = null, fileId = null, fileName = null } = {}) {
  await query(
    'INSERT INTO photo_log (actor, action, class_no, group_no, file_id, file_name) VALUES ($1, $2, $3, $4, $5, $6)',
    [actor, action, classNo, groupNo, fileId, fileName],
  );
}
