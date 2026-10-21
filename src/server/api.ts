import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import * as suwayomi from './suwayomi.ts'
import { safeName } from './cbz.ts'
import { enqueue } from './worker.ts'

const id = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : null)

export function api(db: DatabaseSync, libraryDir: string, sw: typeof suwayomi = suwayomi) {
  const app = new Hono()

  app.onError((e, c) => c.json({ error: e.message }, 502))

  app.get('/sources', async c => c.json(await sw.sources()))

  app.get('/search', async c => {
    const source = c.req.query('source')
    const q = c.req.query('q')?.trim()
    if (!source || !/^\d+$/.test(source) || !q) return c.json({ error: 'source and q are required' }, 400)
    return c.json(await sw.search(source, q))
  })

  // Suwayomi isn't reachable from the browser, so covers go through here.
  app.get('/cover/:mangaId', async c => {
    const mangaId = id(c.req.param('mangaId'))
    if (mangaId === null) return c.json({ error: 'bad id' }, 400)
    const { data, ext } = await sw.image(`/api/v1/manga/${mangaId}/thumbnail`)
    return c.body(data as Uint8Array<ArrayBuffer>, 200, { 'content-type': `image/${ext === 'jpg' ? 'jpeg' : ext}`, 'cache-control': 'max-age=86400' })
  })

  app.get('/series', c =>
    c.json(
      db
        .prepare(
          `select s.id, s.title, s.suwayomi_manga_id, s.source_name, s.status, s.last_checked_at, s.last_error,
                  count(c.id) as chapter_count, max(c.number) as latest_chapter, count(distinct c.volume) as volume_count,
                  (select state from jobs j where j.series_id = s.id order by j.id desc limit 1) as job_state
           from series s left join chapters c on c.series_id = s.id and c.removed = 0
           group by s.id order by s.title collate nocase`,
        )
        .all(),
    ),
  )

  app.get('/jobs', c =>
    c.json(
      db
        .prepare(
          `select j.id, j.series_id, s.title, j.kind, j.state, j.error, j.created_at, j.finished_at
           from jobs j join series s on s.id = j.series_id order by j.id desc limit 200`,
        )
        .all(),
    ),
  )

  app.get('/series/:id', c => {
    const seriesId = id(c.req.param('id'))
    const series = seriesId === null ? undefined : db.prepare(`select * from series where id = ?`).get(seriesId)
    if (!series) return c.json({ error: 'not found' }, 404)
    const chapters = db.prepare(`select number, title, downloaded_at, removed, warning, volume, pages from chapters where series_id = ? order by number desc`).all(seriesId)
    const jobs = db.prepare(`select id, kind, state, error, created_at, finished_at from jobs where series_id = ? order by id desc limit 10`).all(seriesId)
    return c.json({ ...series, chapters, jobs })
  })

  app.post('/series/:id/check', c => {
    const seriesId = id(c.req.param('id'))
    if (seriesId === null || !db.prepare(`select 1 from series where id = ?`).get(seriesId)) return c.json({ error: 'not found' }, 404)
    enqueue(db, seriesId, 'check')
    return c.json({ queued: true }, 202)
  })

  // Point a series at the same title on another source. Chapters already in the CBZ stay; only
  // numbers above the current max come from the new source (see resume_after in the worker).
  app.post('/series/:id/source', async c => {
    const seriesId = id(c.req.param('id'))
    const series = seriesId === null ? undefined : (db.prepare(`select id, suwayomi_manga_id from series where id = ?`).get(seriesId) as { id: number; suwayomi_manga_id: number } | undefined)
    if (!series) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json().catch(() => ({}))
    const mangaId = typeof body.mangaId === 'number' && Number.isInteger(body.mangaId) ? body.mangaId : null
    if (mangaId === null) return c.json({ error: 'mangaId (integer) is required' }, 400)
    if (mangaId === series.suwayomi_manga_id) return c.json({ error: 'that is already the current source' }, 400)
    if (db.prepare(`select 1 from jobs where series_id = ? and state = 'running'`).get(series.id)) return c.json({ error: 'a download is running; try again when it finishes' }, 409)
    const { manga } = await sw.manga(mangaId)
    db.prepare(
      `update series set suwayomi_manga_id = ?, source_name = ?, cover_url = ?, last_error = null,
         resume_after = (select max(number) from chapters where series_id = ?) where id = ?`,
    ).run(manga.id, manga.source.displayName, manga.thumbnailUrl, series.id, series.id)
    enqueue(db, series.id, 'check')
    return c.json({ sourceName: manga.source.displayName })
  })

  // Removal is applied by the worker (the only CBZ writer): a restructure drops it from its volume without asking the source.
  app.post('/series/:id/chapters/:number/remove', c => {
    const seriesId = id(c.req.param('id'))
    const number = Number(c.req.param('number'))
    if (seriesId === null || !Number.isFinite(number)) return c.json({ error: 'bad id or chapter number' }, 400)
    const res = db.prepare(`update chapters set removed = 1 where series_id = ? and number = ?`).run(seriesId, number)
    if (!res.changes) return c.json({ error: 'not found' }, 404)
    db.prepare(`update series set volumes_dirty = 1 where id = ?`).run(seriesId)
    enqueue(db, seriesId, 'restructure')
    return c.json({ queued: true }, 202)
  })

  app.post('/series/:id/chapters/:number/restore', c => {
    const seriesId = id(c.req.param('id'))
    const number = Number(c.req.param('number'))
    if (seriesId === null || !Number.isFinite(number)) return c.json({ error: 'bad id or chapter number' }, 400)
    const series = db.prepare(`select resume_after from series where id = ?`).get(seriesId) as { resume_after: number | null } | undefined
    if (!series) return c.json({ error: 'not found' }, 404)
    // Below the switch point the current source isn't asked for old chapters, so deleting the row wouldn't bring it back.
    if (series.resume_after !== null && number <= series.resume_after) {
      return c.json({ error: 'this chapter is from before the source switch; Redownload all brings it back' }, 409)
    }
    const res = db.prepare(`delete from chapters where series_id = ? and number = ? and removed = 1`).run(seriesId, number)
    if (!res.changes) return c.json({ error: 'not a removed chapter' }, 404)
    enqueue(db, seriesId, 'check')
    return c.json({ queued: true }, 202)
  })

  // Volume boundaries. { starts: [chapter numbers that begin a volume] } sets them by hand;
  // { size, resplit } sets chapters per volume for new volumes and, with resplit, re-splits everything.
  // The DB gets the new layout now; a restructure job makes the files match.
  app.put('/series/:id/volumes', async c => {
    const seriesId = id(c.req.param('id'))
    if (seriesId === null || !db.prepare(`select 1 from series where id = ?`).get(seriesId)) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json().catch(() => ({}))
    const starts = body.starts
    const size = body.size
    const validStarts = Array.isArray(starts) && starts.length <= 10000 && starts.every((n: unknown) => typeof n === 'number' && Number.isFinite(n))
    const validSize = Number.isInteger(size) && size >= 1 && size <= 1000
    if (validStarts === validSize) return c.json({ error: 'send either starts (array of chapter numbers) or size (integer 1–1000)' }, 400)
    if (db.prepare(`select 1 from jobs where series_id = ? and state = 'running'`).get(seriesId)) return c.json({ error: 'a download is running; try again when it finishes' }, 409)

    const numbers = (db.prepare(`select number from chapters where series_id = ? and removed = 0 order by number`).all(seriesId) as { number: number }[]).map(r => r.number)
    let volumeOf: (n: number, i: number) => number
    if (validStarts) {
      const have = new Set(numbers)
      const unknown = (starts as number[]).filter(n => !have.has(n))
      if (unknown.length) return c.json({ error: `not a downloaded chapter: ${unknown.join(', ')}` }, 400)
      const set = new Set(starts as number[])
      let v = 0
      const byNumber = new Map(numbers.map((n, i) => [n, i === 0 || set.has(n) ? ++v : v]))
      volumeOf = n => byNumber.get(n)!
    } else {
      db.prepare(`update series set volume_size = ? where id = ?`).run(size, seriesId)
      if (!body.resplit) return c.json({ volumeSize: size })
      volumeOf = (_n, i) => Math.floor(i / size) + 1
    }
    db.exec('begin')
    try {
      const upd = db.prepare(`update chapters set volume = ? where series_id = ? and number = ?`)
      numbers.forEach((n, i) => upd.run(volumeOf(n, i), seriesId, n))
      db.prepare(`update series set volumes_dirty = 1 where id = ?`).run(seriesId)
      db.exec('commit')
    } catch (e) {
      db.exec('rollback')
      throw e
    }
    enqueue(db, seriesId, 'restructure')
    return c.json({ volumes: numbers.length ? volumeOf(numbers.at(-1)!, numbers.length - 1) : 0 }, 202)
  })

  app.post('/series/:id/rebuild', c => {
    const seriesId = id(c.req.param('id'))
    if (seriesId === null || !db.prepare(`select 1 from series where id = ?`).get(seriesId)) return c.json({ error: 'not found' }, 404)
    enqueue(db, seriesId, 'rebuild')
    return c.json({ queued: true }, 202)
  })

  // For when the volumes live somewhere else, e.g. BookOrbit organised them into manhwa/<author>/<series>/.
  // Existing folder at the new path → adopt it. Otherwise move ours there.
  app.patch('/series/:id', async c => {
    const seriesId = id(c.req.param('id'))
    const series = seriesId === null ? undefined : (db.prepare(`select id, dir from series where id = ?`).get(seriesId) as { id: number; dir: string } | undefined)
    if (!series) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.dir !== 'string' || !body.dir.trim()) return c.json({ error: 'dir is required' }, 400)
    // Relative paths are relative to the library; either way it has to stay inside it.
    const next = resolve(libraryDir, body.dir.trim())
    const rel = relative(resolve(libraryDir), next)
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(/[\\/]/).some(p => p.startsWith('.'))) {
      return c.json({ error: `path must be a folder inside ${libraryDir} and not a hidden one` }, 400)
    }
    if (next.toLowerCase().endsWith('.cbz')) return c.json({ error: 'point at the series folder, not a CBZ' }, 400)
    if (next === resolve(series.dir)) return c.json({ dir: series.dir })
    if (db.prepare(`select 1 from series where dir = ? and id != ?`).get(next, series.id)) return c.json({ error: 'another series already uses that folder' }, 409)
    if (db.prepare(`select 1 from jobs where series_id = ? and state = 'running'`).get(series.id)) return c.json({ error: 'a download is running; try again when it finishes' }, 409)

    let moved = false
    if (!existsSync(next) && existsSync(series.dir)) {
      mkdirSync(dirname(next), { recursive: true })
      renameSync(series.dir, next)
      moved = true
    }
    db.prepare(`update series set dir = ?, last_error = null where id = ?`).run(next, series.id)
    return c.json({ dir: next, moved })
  })

  app.post('/series', async c => {
    const body = await c.req.json().catch(() => ({}))
    const mangaId = typeof body.mangaId === 'number' && Number.isInteger(body.mangaId) ? body.mangaId : null
    if (mangaId === null) return c.json({ error: 'mangaId (integer) is required' }, 400)
    const { manga } = await sw.manga(mangaId)
    const dir = join(libraryDir, safeName(manga.title))
    const taken = db.prepare(`select id from series where dir = ?`).get(dir)
    if (taken) return c.json({ error: `"${manga.title}" is already tracked` }, 409)
    // Never adopt a folder we didn't create: our volumes would mix with someone else's files.
    if (existsSync(dir)) return c.json({ error: `${safeName(manga.title)}/ already exists in the library` }, 409)
    const { lastInsertRowid } = db
      .prepare(`insert into series (title, suwayomi_manga_id, source_name, cover_url, dir) values (?, ?, ?, ?, ?)`)
      .run(manga.title, manga.id, manga.source.displayName, manga.thumbnailUrl, dir)
    enqueue(db, Number(lastInsertRowid), 'download')
    return c.json({ id: Number(lastInsertRowid), title: manga.title }, 201)
  })

  return app
}
