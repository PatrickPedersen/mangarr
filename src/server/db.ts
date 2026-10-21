import { basename, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const schema = `
create table if not exists series (
  id integer primary key,
  title text not null,
  suwayomi_manga_id integer not null,
  source_name text not null,
  cover_url text,
  status text not null default 'ok' check (status in ('ok', 'failing')),
  last_checked_at text,
  last_error text,
  resume_after real, -- set on source switch: only chapters above this come from the new source
  dir text not null unique, -- folder holding the series' volume CBZs
  volume_size integer not null default 25, -- chapters per volume when a new one is started
  legacy_file text, -- pre-volumes single CBZ, waiting to be split into volumes
  volumes_dirty integer not null default 0, -- chapters.volume changed; files not yet restructured to match
  added_at text not null default (datetime('now'))
);
create table if not exists chapters (
  id integer primary key,
  series_id integer not null references series(id) on delete cascade,
  number real not null,
  title text,
  suwayomi_chapter_id integer not null,
  removed integer not null default 0, -- dropped from the CBZ by the user; never re-fetched
  warning text, -- set when the page count looks off for this series
  volume integer, -- null only for chapters still in a legacy single CBZ
  pages integer,
  downloaded_at text not null default (datetime('now')),
  unique (series_id, number)
);
create table if not exists jobs (
  id integer primary key,
  series_id integer not null references series(id) on delete cascade,
  kind text not null check (kind in ('check', 'download', 'rebuild', 'restructure')),
  state text not null default 'queued' check (state in ('queued', 'running', 'done', 'failed')),
  error text,
  created_at text not null default (datetime('now')),
  finished_at text
);
`

export function openDb(path: string) {
  const db = new DatabaseSync(path)
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on;')
  db.exec(schema)
  // Columns added after a table first shipped. ponytail: append-only list, a real migrator once one gets dropped/renamed.
  const cols = (table: string) => (db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map(c => c.name)
  const add = (table: string, col: string, def: string) => cols(table).includes(col) || db.exec(`alter table ${table} add column ${col} ${def}`)
  add('series', 'resume_after', 'real')
  add('chapters', 'removed', 'integer not null default 0')
  add('chapters', 'warning', 'text')
  add('chapters', 'volume', 'integer')
  add('chapters', 'pages', 'integer')
  add('series', 'volumes_dirty', 'integer not null default 0')
  if (cols('series').includes('file_path')) toVolumes(db)
  // A CHECK constraint can't be altered either: copy jobs into a table with the new kind allowed.
  if (!(db.prepare(`select sql from sqlite_master where name = 'jobs'`).get() as { sql: string }).sql.includes('restructure')) {
    db.exec('begin')
    db.exec(schema.slice(schema.indexOf('create table if not exists jobs')).replace('jobs (', 'jobs_v2 ('))
    db.exec(`insert into jobs_v2 select id, series_id, kind, state, error, created_at, finished_at from jobs; drop table jobs; alter table jobs_v2 rename to jobs; commit`)
  }
  return db
}

/**
 * v0.1 → v0.2: `file_path` (one CBZ) becomes `dir` (a folder of volumes); the old file is kept as
 * `legacy_file` until the worker has split it. SQLite can't drop a NOT NULL UNIQUE column, so the
 * table is rebuilt; foreign keys are off meanwhile or dropping `series` would cascade to chapters.
 */
function toVolumes(db: DatabaseSync) {
  // "<lib>/S/S.cbz" (already in its own folder) → "<lib>/S"; "<lib>/S.cbz" → "<lib>/S".
  const dirFor = (file: string) => {
    const stem = basename(file).replace(/\.cbz$/i, '')
    return basename(dirname(file)) === stem ? dirname(file) : file.replace(/\.cbz$/i, '')
  }
  const rows = db.prepare(`select * from series`).all() as Record<string, string | number | null>[]
  db.exec('pragma foreign_keys = off; begin')
  try {
    // New table first, then rename: renaming the old one would repoint chapters' foreign key at it.
    db.exec(schema.slice(0, schema.indexOf(');') + 2).replace('series (', 'series_v2 ('))
    const ins = db.prepare(`insert into series_v2 (id, title, suwayomi_manga_id, source_name, cover_url, status, last_checked_at, last_error, resume_after, dir, legacy_file, volumes_dirty, added_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
    for (const r of rows) {
      ins.run(r.id, r.title, r.suwayomi_manga_id, r.source_name, r.cover_url, r.status, r.last_checked_at, r.last_error, r.resume_after, dirFor(String(r.file_path)), r.file_path, r.added_at)
    }
    db.exec(`drop table series; alter table series_v2 rename to series; commit`)
  } catch (e) {
    db.exec('rollback')
    throw e
  } finally {
    db.exec('pragma foreign_keys = on')
  }
}
