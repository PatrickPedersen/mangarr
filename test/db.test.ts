import { expect, test } from 'vitest'
import { openDb } from '../src/server/db.ts'

test('schema creates and enforces chapter uniqueness per series', () => {
  const db = openDb(':memory:')
  db.prepare(`insert into series (title, suwayomi_manga_id, source_name, file_path) values ('A', 1, 'src', '/a.cbz')`).run()
  const ins = db.prepare(`insert into chapters (series_id, number, suwayomi_chapter_id) values (1, ?, ?)`)
  ins.run(1.5, 10)
  expect(() => ins.run(1.5, 11)).toThrow(/UNIQUE/)
})
