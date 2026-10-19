import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { api } from '../src/server/api.ts'
import { openDb } from '../src/server/db.ts'
import type * as suwayomi from '../src/server/suwayomi.ts'

function setup() {
  const lib = mkdtempSync(join(tmpdir(), 'mangarr-lib-'))
  const db = openDb(':memory:')
  const file = join(lib, 'S.cbz')
  db.prepare(`insert into series (title, suwayomi_manga_id, source_name, file_path) values ('S', 1, 'src', ?)`).run(file)
  db.prepare(`insert into series (title, suwayomi_manga_id, source_name, file_path) values ('T', 2, 'src', ?)`).run(join(lib, 'T.cbz'))
  const sw = {
    manga: async (id: number) => ({ manga: { id, title: 'S', thumbnailUrl: `/t/${id}`, source: { displayName: 'Other (EN)' } }, chapters: [] }),
  } as unknown as typeof suwayomi
  const app = api(db, lib, sw)
  const patch = (filePath: unknown, id = 1) =>
    app.request(`/series/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filePath }) })
  const path = () => (db.prepare(`select file_path from series where id = 1`).get() as { file_path: string }).file_path
  return { lib, db, file, patch, path }
}

test('moves our CBZ to a new relative path inside the library', async () => {
  const { lib, file, patch, path } = setup()
  writeFileSync(file, 'cbz')
  const res = await patch('Author/S/S.cbz')
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ moved: true })
  expect(path()).toBe(join(lib, 'Author/S/S.cbz'))
  expect(existsSync(file)).toBe(false)
  expect(existsSync(join(lib, 'Author/S/S.cbz'))).toBe(true)
})

test('adopts a file that is already at the new path (moved by BookOrbit)', async () => {
  const { lib, patch, path } = setup()
  mkdirSync(join(lib, 'Author/S'), { recursive: true })
  writeFileSync(join(lib, 'Author/S/S.cbz'), 'moved')
  const res = await patch(join(lib, 'Author/S/S.cbz'))
  expect(await res.json()).toMatchObject({ moved: false })
  expect(path()).toBe(join(lib, 'Author/S/S.cbz'))
})

test.each([
  ['../outside.cbz', 400],
  ['/etc/passwd.cbz', 400],
  ['.mangarr-tmp/S.cbz', 400],
  ['S.zip', 400],
  ['', 400],
  [42, 400],
  ['T.cbz', 409],
])('rejects %j with %i', async (filePath, status) => {
  const { patch, path, file } = setup()
  expect((await patch(filePath)).status).toBe(status)
  expect(path()).toBe(file)
})

test('refuses while a download is running for the series', async () => {
  const { db, patch } = setup()
  db.prepare(`insert into jobs (series_id, kind, state) values (1, 'download', 'running')`).run()
  expect((await patch('New.cbz')).status).toBe(409)
})

test('switching source records the resume point and queues a check', async () => {
  const { db } = setup()
  db.prepare(`insert into chapters (series_id, number, suwayomi_chapter_id) values (1, 1, 1), (1, 7.5, 2)`).run()
  const app = api(db, '/lib', {
    manga: async (id: number) => ({ manga: { id, title: 'S', thumbnailUrl: null, source: { displayName: 'Other (EN)' } }, chapters: [] }),
  } as unknown as typeof suwayomi)
  const post = (body: unknown) => app.request('/series/1/source', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect((await post({ mangaId: 1 })).status).toBe(400) // same as current
  expect((await post({ mangaId: 'x' })).status).toBe(400)
  expect((await post({ mangaId: 99 })).status).toBe(200)
  expect(db.prepare(`select suwayomi_manga_id, source_name, resume_after from series where id = 1`).get()).toEqual({
    suwayomi_manga_id: 99, source_name: 'Other (EN)', resume_after: 7.5,
  })
  expect(db.prepare(`select kind, state from jobs where series_id = 1`).all()).toEqual([{ kind: 'check', state: 'queued' }])
})

test('remove and restore chapters queue a check; restore refuses chapters from before a source switch', async () => {
  const { db } = setup()
  db.prepare(`insert into chapters (series_id, number, suwayomi_chapter_id) values (1, 1, 1), (1, 2.5, 2)`).run()
  const app = api(db, '/lib', {} as typeof suwayomi)
  const post = (path: string) => app.request(path, { method: 'POST' })
  expect((await post('/series/1/chapters/2.5/remove')).status).toBe(202)
  expect(db.prepare(`select removed from chapters where number = 2.5`).get()).toEqual({ removed: 1 })
  expect((await post('/series/1/chapters/9/remove')).status).toBe(404)
  expect((await post('/series/1/chapters/abc/remove')).status).toBe(400)

  db.prepare(`update series set resume_after = 2.5 where id = 1`).run()
  expect((await post('/series/1/chapters/2.5/restore')).status).toBe(409)
  db.prepare(`update series set resume_after = null where id = 1`).run()
  expect((await post('/series/1/chapters/2.5/restore')).status).toBe(202)
  expect(db.prepare(`select count(*) n from chapters where number = 2.5`).get()).toEqual({ n: 0 })
  expect(db.prepare(`select count(*) n from jobs where series_id = 1 and state = 'queued'`).get()).toEqual({ n: 1 })
})
