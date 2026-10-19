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
  file_path text not null unique,
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
  downloaded_at text not null default (datetime('now')),
  unique (series_id, number)
);
create table if not exists jobs (
  id integer primary key,
  series_id integer not null references series(id) on delete cascade,
  kind text not null check (kind in ('check', 'download', 'rebuild')),
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
  return db
}
