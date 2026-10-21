import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { openDb } from '../src/server/db.ts'

test('schema creates and enforces chapter uniqueness per series', () => {
  const db = openDb(':memory:')
  db.prepare(`insert into series (title, suwayomi_manga_id, source_name, dir) values ('A', 1, 'src', '/a')`).run()
  const ins = db.prepare(`insert into chapters (series_id, number, suwayomi_chapter_id) values (1, ?, ?)`)
  ins.run(1.5, 10)
  expect(() => ins.run(1.5, 11)).toThrow(/UNIQUE/)
})

test('a v0.1 database (one CBZ per series) migrates to folders, keeping chapters and their foreign key', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mangarr-db-')), 'm.db')
  const old = new DatabaseSync(path)
  old.exec(`
    create table series (id integer primary key, title text not null, suwayomi_manga_id integer not null, source_name text not null,
      cover_url text, status text not null default 'ok', last_checked_at text, last_error text, resume_after real,
      file_path text not null unique, added_at text not null default (datetime('now')));
    create table jobs (id integer primary key, series_id integer not null references series(id) on delete cascade,
      kind text not null check (kind in ('check', 'download', 'rebuild')), state text not null default 'queued', error text,
      created_at text not null default (datetime('now')), finished_at text);
    create table chapters (id integer primary key, series_id integer not null references series(id) on delete cascade, number real not null,
      title text, suwayomi_chapter_id integer not null, removed integer not null default 0, warning text,
      downloaded_at text not null default (datetime('now')), unique (series_id, number));
    insert into series (title, suwayomi_manga_id, source_name, file_path, resume_after) values
      ('TBATE', 1, 'src', '/lib/TBATE.cbz', 3), ('VS', 2, 'src', '/lib/Author/VS/VS.cbz', null);
    insert into chapters (series_id, number, suwayomi_chapter_id) values (1, 1, 1), (1, 2, 2), (2, 1, 3);
    insert into jobs (series_id, kind, state) values (2, 'check', 'done');`)
  old.close()

  const db = openDb(path)
  expect(db.prepare(`select id, dir, legacy_file, volume_size, resume_after from series order by id`).all()).toEqual([
    { id: 1, dir: '/lib/TBATE', legacy_file: '/lib/TBATE.cbz', volume_size: 25, resume_after: 3 },
    { id: 2, dir: '/lib/Author/VS', legacy_file: '/lib/Author/VS/VS.cbz', volume_size: 25, resume_after: null },
  ])
  expect(db.prepare(`select count(*) n from chapters`).get()).toEqual({ n: 3 })
  expect(db.prepare(`select volumes_dirty from series`).all()).toEqual([{ volumes_dirty: 1 }, { volumes_dirty: 1 }]) // split on first run
  expect(db.prepare(`select kind, state from jobs`).all()).toEqual([{ kind: 'check', state: 'done' }])
  db.prepare(`insert into jobs (series_id, kind) values (2, 'restructure')`).run()
  db.prepare(`delete from series where id = 1`).run()
  expect(db.prepare(`select count(*) n from chapters`).get()).toEqual({ n: 1 }) // still cascades to the new table
  expect(db.prepare(`pragma foreign_key_check`).all()).toEqual([])
  db.close()
  expect(() => openDb(path)).not.toThrow() // second open is a no-op
})

test('upgrading to user_version 1 queues every split series for a title refresh, once', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mangarr-db-')), 'm.db')
  const db = openDb(path)
  db.prepare(`insert into series (title, suwayomi_manga_id, source_name, dir) values ('A', 1, 'src', '/a')`).run()
  db.exec('pragma user_version = 0')
  db.close()
  const again = openDb(path)
  expect(again.prepare(`select volumes_dirty from series`).get()).toEqual({ volumes_dirty: 1 })
  again.prepare(`update series set volumes_dirty = 0`).run()
  again.close()
  expect(openDb(path).prepare(`select volumes_dirty from series`).get()).toEqual({ volumes_dirty: 0 })
})
