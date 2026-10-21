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
  const dir = join(lib, 'S')
  db.prepare(`insert into series (title, suwayomi_manga_id, source_name, dir) values ('S', 1, 'src', ?)`).run(dir)
  db.prepare(`insert into series (title, suwayomi_manga_id, source_name, dir) values ('T', 2, 'src', ?)`).run(join(lib, 'T'))
  const sw = {
    manga: async (id: number) => ({ manga: { id, title: 'S', thumbnailUrl: `/t/${id}`, source: { displayName: 'Other (EN)' } }, chapters: [] }),
  } as unknown as typeof suwayomi
  const app = api(db, lib, sw)
  const patch = (dir: unknown, id = 1) =>
    app.request(`/series/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir }) })
  const path = () => (db.prepare(`select dir from series where id = 1`).get() as { dir: string }).dir
  return { lib, db, dir, app, patch, path }
}

test('moves our series folder to a new relative path inside the library', async () => {
  const { lib, dir, patch, path } = setup()
  mkdirSync(dir)
  writeFileSync(join(dir, 'S Vol. 01.cbz'), 'cbz')
  const res = await patch('Author/S')
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ moved: true })
  expect(path()).toBe(join(lib, 'Author/S'))
  expect(existsSync(dir)).toBe(false)
  expect(existsSync(join(lib, 'Author/S/S Vol. 01.cbz'))).toBe(true)
})

test('adopts a folder that is already at the new path (moved by BookOrbit)', async () => {
  const { lib, patch, path } = setup()
  mkdirSync(join(lib, 'Author/S'), { recursive: true })
  const res = await patch(join(lib, 'Author/S'))
  expect(await res.json()).toMatchObject({ moved: false })
  expect(path()).toBe(join(lib, 'Author/S'))
})

test.each([
  ['../outside', 400],
  ['/etc', 400],
  ['.mangarr-tmp/S', 400],
  ['S/S Vol. 01.cbz', 400],
  ['', 400],
  [42, 400],
  ['T', 409],
])('rejects %j with %i', async (dir, status) => {
  const { patch, path, dir: before } = setup()
  expect((await patch(dir)).status).toBe(status)
  expect(path()).toBe(before)
})

test('refuses while a download is running for the series', async () => {
  const { db, patch } = setup()
  db.prepare(`insert into jobs (series_id, kind, state) values (1, 'download', 'running')`).run()
  expect((await patch('New')).status).toBe(409)
})

test('adding a series gives it its own folder and refuses a folder that already exists', async () => {
  const { lib, db, app } = setup()
  db.prepare(`delete from series`).run()
  const add = () => app.request('/series', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mangaId: 5 }) })
  expect((await add()).status).toBe(201)
  expect(db.prepare(`select dir from series`).get()).toEqual({ dir: join(lib, 'S') })
  expect((await add()).status).toBe(409) // already tracked
  db.prepare(`delete from series`).run()
  mkdirSync(join(lib, 'S'))
  expect((await add()).status).toBe(409) // someone else's folder
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

test('remove queues a restructure and restore a check; restore refuses chapters from before a source switch', async () => {
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
  expect(db.prepare(`select kind from jobs where series_id = 1 and state = 'queued' order by id`).all()).toEqual([{ kind: 'restructure' }, { kind: 'check' }])
  expect(db.prepare(`select volumes_dirty from series where id = 1`).get()).toEqual({ volumes_dirty: 1 })
})

test('volume boundaries by hand or by size; the DB changes now and a restructure is queued', async () => {
  const { db, app } = setup()
  db.prepare(`insert into chapters (series_id, number, suwayomi_chapter_id, volume, removed) values (1, 1, 1, 1, 0), (1, 2, 2, 1, 0), (1, 2.5, 3, 1, 1), (1, 3, 4, 1, 0), (1, 4, 5, 1, 0), (1, 5, 6, 1, 0)`).run()
  const put = (body: unknown) => app.request('/series/1/volumes', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const vols = () => db.prepare(`select number, volume from chapters where removed = 0 order by number`).all().map(r => (r as { volume: number }).volume)

  expect((await put({ starts: [3, 5] })).status).toBe(202)
  expect(vols()).toEqual([1, 1, 2, 2, 3])
  expect(db.prepare(`select kind from jobs`).all()).toEqual([{ kind: 'restructure' }])
  expect(db.prepare(`select volumes_dirty from series where id = 1`).get()).toEqual({ volumes_dirty: 1 })

  expect(await (await put({ size: 2, resplit: true })).json()).toEqual({ volumes: 3 })
  expect(vols()).toEqual([1, 1, 2, 2, 3])
  expect((await put({ starts: [] })).status).toBe(202) // everything in one volume
  expect(vols()).toEqual([1, 1, 1, 1, 1])
  expect(await (await put({ size: 4 })).json()).toEqual({ volumeSize: 4 }) // future volumes only
  expect(vols()).toEqual([1, 1, 1, 1, 1])
  expect(db.prepare(`select volume_size from series where id = 1`).get()).toEqual({ volume_size: 4 })
  expect(db.prepare(`select count(*) n from jobs`).get()).toEqual({ n: 1 }) // restructures queued once

  for (const bad of [{}, { starts: [2.5] }, { starts: [99] }, { starts: 'x' }, { size: 0 }, { size: 1.5 }, { size: 2, starts: [3] }]) {
    expect((await put(bad)).status, JSON.stringify(bad)).toBe(400)
  }
  db.prepare(`insert into jobs (series_id, kind, state) values (1, 'download', 'running')`).run()
  expect((await put({ starts: [3] })).status).toBe(409)
})
