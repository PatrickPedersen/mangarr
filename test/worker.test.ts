import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yauzl from 'yauzl'
import { text } from 'node:stream/consumers'
import { cbzEntries } from '../src/server/cbz.ts'
import { expect, test, vi } from 'vitest'
import { openDb } from '../src/server/db.ts'
import { assignVolumes, enqueue, missingChapters, pageCountWarnings, runNext, scheduleChecks, type Ctx } from '../src/server/worker.ts'
import type { Chapter } from '../src/server/suwayomi.ts'

const ch = (id: number, chapterNumber: number, sourceOrder = id): Chapter => ({ id, name: `Ch ${chapterNumber}`, chapterNumber, sourceOrder })

function setup(chapters: Chapter[], volumeSize = 25) {
  const db = openDb(':memory:')
  const lib = mkdtempSync(join(tmpdir(), 'mangarr-'))
  const dir = join(lib, 'S')
  const vol = (n: number) => join(dir, `S Vol. ${String(n).padStart(2, '0')}.cbz`)
  const file = vol(1)
  db.prepare(`insert into series (title, suwayomi_manga_id, source_name, dir, volume_size) values ('S', 7, 'src', ?, ?)`).run(dir, volumeSize)
  const sw = {
    manga: vi.fn(async () => ({
      manga: { id: 7, title: 'S', thumbnailUrl: '/thumb', description: null, author: null, artist: null, genre: [], status: '', realUrl: null, source: { displayName: 'src' } },
      chapters,
    })),
    pages: vi.fn(async (id: number) => [`/c${id}/p0`, `/c${id}/p1`]),
    image: vi.fn(async (path: string) => ({ data: new TextEncoder().encode(path), ext: 'jpg' })),
  }
  const notify = vi.fn(async (_title: string, _message: string) => {})
  const ctx: Ctx = { db, sw, libraryDir: lib, notify }
  const rows = () => db.prepare(`select number from chapters order by number`).all().map(r => (r as { number: number }).number)
  const job = () => db.prepare(`select state, error from jobs order by id desc limit 1`).get() as { state: string; error: string | null }
  const status = () => (db.prepare(`select status from series where id = 1`).get() as { status: string }).status
  return { db, dir, vol, file, sw, ctx, rows, job, notify, status }
}

test('missingChapters skips known, unparsed (-1) and duplicate numbers, sorted', () => {
  const remote = [ch(1, 2), ch(2, 1), ch(3, -1), ch(4, 1.5), ch(5, 2, 0)]
  expect(missingChapters(remote, new Set([1])).map(c => c.id)).toEqual([4, 5])
})

test('missingChapters numbers by source order when nothing has a number (oneshots)', () => {
  expect(missingChapters([ch(9, -1, 1)], new Set()).map(c => [c.id, c.chapterNumber])).toEqual([[9, 1]])
  expect(missingChapters([ch(9, -1, 1)], new Set([1]))).toEqual([])
})

test('first download with nothing to fetch fails instead of silently succeeding', async () => {
  const { db, ctx, job } = setup([])
  enqueue(db, 1, 'download')
  await runNext(ctx)
  expect(job()).toEqual({ state: 'failed', error: 'source returned no downloadable chapters' })
})

test('download job writes every chapter + cover and records them', async () => {
  const { db, file, ctx, rows, job } = setup([ch(10, 1), ch(11, 2), ch(12, 2.5)])
  enqueue(db, 1, 'download')
  expect(await runNext(ctx)).toBe(true)
  expect(job().state).toBe('done')
  expect(rows()).toEqual([1, 2, 2.5])
  expect(await cbzEntries(file)).toEqual(['ComicInfo.xml', '0000-cover.jpg', '0001.0/001.jpg', '0001.0/002.jpg', '0002.0/001.jpg', '0002.0/002.jpg', '0002.5/001.jpg', '0002.5/002.jpg'])
  expect(existsSync(join(ctx.libraryDir, '.mangarr-tmp', 'series-1'))).toBe(false)
  expect(await runNext(ctx)).toBe(false)
})

test('second run only fetches new chapters and keeps the cover', async () => {
  const chapters = [ch(10, 1)]
  const { db, file, sw, ctx, rows } = setup(chapters)
  enqueue(db, 1, 'download')
  await runNext(ctx)
  chapters.push(ch(11, 2))
  sw.pages.mockClear()
  enqueue(db, 1, 'download')
  await runNext(ctx)
  expect(sw.pages).toHaveBeenCalledExactlyOnceWith(11)
  expect(rows()).toEqual([1, 2])
  expect(await cbzEntries(file)).toContain('0000-cover.jpg')
})

test('a job that dies mid-download resumes from staged chapters without re-fetching them', async () => {
  const { db, file, ctx, rows, sw, job } = setup([ch(10, 1), ch(11, 2), ch(12, 3)])
  sw.pages.mockImplementation(async (id: number) => {
    if (id === 12) throw new Error('boom')
    return [`/c${id}/p0`]
  })
  enqueue(db, 1, 'download')
  await runNext(ctx)
  expect(job().state).toBe('failed')
  expect(existsSync(file)).toBe(false) // nothing half-written reaches the library
  expect(rows()).toEqual([])

  sw.pages.mockClear()
  sw.pages.mockImplementation(async (id: number) => [`/c${id}/p0`])
  enqueue(db, 1, 'download')
  await runNext(ctx)
  expect(sw.pages).toHaveBeenCalledExactlyOnceWith(12)
  expect(rows()).toEqual([1, 2, 3])
})

test('a failing source marks the job failed with the error', async () => {
  const { db, ctx, sw, job } = setup([])
  sw.manga.mockRejectedValueOnce(new Error('HTTP error 503'))
  enqueue(db, 1, 'download')
  await runNext(ctx)
  expect(job()).toEqual({ state: 'failed', error: 'HTTP error 503' })
  expect(db.prepare(`select last_error from series`).get()).toEqual({ last_error: 'HTTP error 503' })
})

test('enqueue does not stack queued jobs for one series', () => {
  const { db } = setup([])
  enqueue(db, 1, 'download')
  enqueue(db, 1, 'check')
  expect(db.prepare(`select count(*) as n from jobs`).get()).toEqual({ n: 1 })
})

test('scheduleChecks queues never-checked and stale series only', () => {
  const { db } = setup([])
  db.prepare(`insert into series (title, suwayomi_manga_id, source_name, dir, last_checked_at) values ('Fresh', 8, 'src', '/f', datetime('now', '-1 hours'))`).run()
  db.prepare(`insert into series (title, suwayomi_manga_id, source_name, dir, last_checked_at) values ('Stale', 9, 'src', '/s', datetime('now', '-25 hours'))`).run()
  expect(scheduleChecks(db, 24)).toBe(2) // series 1 (never checked) + Stale
  expect(db.prepare(`select series_id, kind from jobs order by series_id`).all()).toEqual([
    { series_id: 1, kind: 'check' },
    { series_id: 3, kind: 'check' },
  ])
})

test('a check with new chapters on the source appends them; without, it only touches last_checked_at', async () => {
  const chapters = [ch(10, 1)]
  const { db, file, sw, ctx, rows } = setup(chapters)
  enqueue(db, 1, 'download')
  await runNext(ctx)
  sw.pages.mockClear()
  enqueue(db, 1, 'check')
  await runNext(ctx)
  expect(sw.pages).not.toHaveBeenCalled()
  chapters.push(ch(11, 2))
  enqueue(db, 1, 'check')
  await runNext(ctx)
  expect(rows()).toEqual([1, 2])
  expect((await cbzEntries(file)).filter(n => n.startsWith('0002.0/'))).toHaveLength(2)
})

test('a series whose volume disappeared fails instead of starting a new one', async () => {
  const chapters = [ch(10, 1)]
  const { db, file, ctx, job } = setup(chapters)
  enqueue(db, 1, 'download')
  await runNext(ctx)
  rmSync(file)
  chapters.push(ch(11, 2))
  enqueue(db, 1, 'check')
  await runNext(ctx)
  expect(job().state).toBe('failed')
  expect(job().error).toContain('not found')
  expect(existsSync(file)).toBe(false)
})

test('notifies once on ok → failing, stays quiet while failing, recovers to ok', async () => {
  const { db, ctx, sw, notify, status } = setup([ch(10, 1)])
  enqueue(db, 1, 'download')
  await runNext(ctx)
  sw.manga.mockRejectedValue(new Error('Cloudflare'))
  for (let i = 0; i < 3; i++) {
    enqueue(db, 1, 'check')
    await runNext(ctx)
  }
  expect(status()).toBe('failing')
  expect(notify).toHaveBeenCalledOnce()
  expect(notify.mock.calls[0]![0]).toContain('S is failing')
  expect(notify.mock.calls[0]![1]).toContain('Cloudflare')

  sw.manga.mockReset()
  sw.manga.mockResolvedValue({ manga: { id: 7, title: 'S', thumbnailUrl: '/thumb', description: null, author: null, artist: null, genre: [], status: '', realUrl: null, source: { displayName: 'src' } }, chapters: [ch(10, 1)] })
  enqueue(db, 1, 'check')
  await runNext(ctx)
  expect(status()).toBe('ok')
  expect(db.prepare(`select last_error from series`).get()).toEqual({ last_error: null })
})

test('a source that suddenly lists zero chapters counts as failing', async () => {
  const chapters = [ch(10, 1)]
  const { db, ctx, job, status } = setup(chapters)
  enqueue(db, 1, 'download')
  await runNext(ctx)
  chapters.length = 0
  enqueue(db, 1, 'check')
  await runNext(ctx)
  expect(job().error).toContain('source returned no chapters')
  expect(status()).toBe('failing')
})

test('after a source switch only chapters above the old max are downloaded', async () => {
  const chapters = [ch(10, 1), ch(11, 2)]
  const { db, ctx, sw, rows } = setup(chapters)
  enqueue(db, 1, 'download')
  await runNext(ctx)
  // New source: has a 1.5 the old one lacked (must be skipped) plus a new 3.
  db.prepare(`update series set suwayomi_manga_id = 8, resume_after = 2`).run()
  chapters.splice(0, chapters.length, ch(20, 1), ch(21, 1.5), ch(22, 2), ch(23, 3))
  sw.pages.mockClear()
  enqueue(db, 1, 'check')
  await runNext(ctx)
  expect(sw.pages).toHaveBeenCalledExactlyOnceWith(23)
  expect(rows()).toEqual([1, 2, 3])
})

test('a new source whose numbering is far behind fails instead of silently finding nothing', async () => {
  const { db, dir, file, ctx, job } = setup([ch(20, 1), ch(21, 2)])
  mkdirSync(dir)
  writeFileSync(file, '') // the CBZ exists; only the numbering is off
  db.prepare(`insert into chapters (series_id, number, suwayomi_chapter_id) values (1, 120, 1)`).run()
  db.prepare(`update series set resume_after = 120`).run()
  enqueue(db, 1, 'check')
  await runNext(ctx)
  expect(job().error).toContain('numbering differs')
})

test('rebuild replaces the CBZ and chapter rows from scratch and clears resume_after', async () => {
  const chapters = [ch(10, 1), ch(11, 2)]
  const { db, file, ctx, rows } = setup(chapters)
  enqueue(db, 1, 'download')
  await runNext(ctx)
  db.prepare(`update series set resume_after = 2`).run()
  chapters.splice(0, chapters.length, ch(30, 1), ch(31, 1.5))
  enqueue(db, 1, 'rebuild')
  await runNext(ctx)
  expect(rows()).toEqual([1, 1.5])
  expect((await cbzEntries(file)).filter(n => n.includes('/'))).toEqual(['0001.0/001.jpg', '0001.0/002.jpg', '0001.5/001.jpg', '0001.5/002.jpg'])
  expect(await cbzEntries(file)).toContain('0000-cover.jpg')
  expect(db.prepare(`select resume_after from series`).get()).toEqual({ resume_after: null })
})

test('a rebuild request upgrades an already-queued check', () => {
  const { db } = setup([])
  enqueue(db, 1, 'check')
  enqueue(db, 1, 'rebuild')
  expect(db.prepare(`select kind from jobs`).all()).toEqual([{ kind: 'rebuild' }])
})

test('a page that keeps failing loses only itself: the retry fetches just the missing pages', async () => {
  const { db, ctx, sw, rows } = setup([ch(10, 1)])
  sw.pages.mockImplementation(async () => ['/p0', '/p1', '/p2'])
  sw.image.mockImplementation(async (path: string) => {
    if (path === '/p2') throw new Error('500')
    return { data: new TextEncoder().encode(path), ext: 'jpg' }
  })
  enqueue(db, 1, 'download')
  await runNext(ctx)
  expect(rows()).toEqual([])

  sw.image.mockClear()
  sw.image.mockImplementation(async (path: string) => ({ data: new TextEncoder().encode(path), ext: 'jpg' }))
  enqueue(db, 1, 'download')
  await runNext(ctx)
  expect(sw.image.mock.calls.map(c => c[0])).toEqual(['/p2', '/thumb'])
  expect(rows()).toEqual([1])
})

test('if the page list changes between attempts, the chapter restarts instead of mixing pages', async () => {
  const { db, file, ctx, sw, rows } = setup([ch(10, 1)])
  sw.pages.mockImplementation(async () => ['/a0', '/a1', '/a2'])
  sw.image.mockImplementation(async (path: string) => {
    if (path === '/a2') throw new Error('500')
    return { data: new TextEncoder().encode(path), ext: 'jpg' }
  })
  enqueue(db, 1, 'download')
  await runNext(ctx)

  sw.pages.mockImplementation(async () => ['/b0', '/b1'])
  sw.image.mockImplementation(async (path: string) => ({ data: new TextEncoder().encode(path), ext: 'jpg' }))
  enqueue(db, 1, 'download')
  await runNext(ctx)
  expect(rows()).toEqual([1])
  expect((await cbzEntries(file)).filter(n => n.startsWith('0001.0/'))).toEqual(['0001.0/001.jpg', '0001.0/002.jpg'])
})

test('pageCountWarnings flags chapters far from the median, needs 5 chapters of evidence', () => {
  const usual = [38, 40, 36, 42, 39]
  expect(pageCountWarnings(usual, new Map([[41, 240], [42, 8], [43, 45], [44, 80]]))).toEqual(
    new Map([[41, '240 pages; this series usually has about 39'], [42, '8 pages; this series usually has about 39']]),
  )
  expect(pageCountWarnings([38, 40], new Map([[3, 240]]))).toEqual(new Map()) // too little to judge
  // First download: the new chapters are their own baseline.
  expect([...pageCountWarnings([], new Map([[1, 30], [2, 31], [3, 29], [4, 30], [5, 300]])).keys()]).toEqual([5])
})

test('removing a chapter drops it from the CBZ and it is never fetched again, even by a rebuild', async () => {
  const { db, file, ctx, sw, rows } = setup([ch(10, 1), ch(11, 2), ch(12, 3)])
  enqueue(db, 1, 'download')
  await runNext(ctx)
  db.prepare(`update chapters set removed = 1 where number = 2`).run()
  sw.pages.mockClear()
  enqueue(db, 1, 'check')
  await runNext(ctx)
  expect(sw.pages).not.toHaveBeenCalled()
  expect((await cbzEntries(file)).some(n => n.startsWith('0002.0/'))).toBe(false)
  expect((await cbzEntries(file)).some(n => n.startsWith('0003.0/'))).toBe(true)

  enqueue(db, 1, 'rebuild')
  await runNext(ctx)
  expect(sw.pages.mock.calls.map(c => c[0])).toEqual([10, 12])
  expect((await cbzEntries(file)).some(n => n.startsWith('0002.0/'))).toBe(false)
  expect(rows()).toEqual([1, 2, 3]) // 2 is still recorded, as removed
  expect(db.prepare(`select removed from chapters where number = 2`).get()).toEqual({ removed: 1 })
})

test('an outlier chapter is stored with a warning and notified once', async () => {
  const chapters = [1, 2, 3, 4, 5].map(n => ch(n, n))
  const { db, ctx, sw, notify } = setup(chapters)
  sw.pages.mockImplementation(async (id: number) => Array.from({ length: id === 6 ? 40 : 4 }, (_, i) => `/c${id}/p${i}`))
  enqueue(db, 1, 'download')
  await runNext(ctx)
  expect(notify).not.toHaveBeenCalled()
  chapters.push(ch(6, 6))
  enqueue(db, 1, 'check')
  await runNext(ctx)
  expect(db.prepare(`select warning from chapters where number = 6`).get()).toEqual({ warning: '40 pages; this series usually has about 4' })
  expect(notify).toHaveBeenCalledOnce()
  expect(notify.mock.calls[0]![1]).toContain('Chapter 6: 40 pages')
})

const comicInfo = (path: string) =>
  new Promise<string>((ok, fail) =>
    yauzl.open(path, { lazyEntries: true }, (e, z) => {
      if (e) return fail(e)
      z.on('entry', (entry: yauzl.Entry) => z.openReadStream(entry, (err, s) => (err ? fail(err) : text(s).then(ok, fail))))
      z.readEntry() // ComicInfo.xml is always the first entry
    }),
  )
const volumes = (db: Ctx['db']) => db.prepare(`select number, volume from chapters order by number`).all().map(r => [(r as { number: number }).number, (r as { volume: number }).volume])

test('assignVolumes fills the last volume to size, then starts the next; late chapters join their neighbours', () => {
  expect([...assignVolumes([], [1, 2, 3, 4, 5], 2)]).toEqual([[1, 1], [2, 1], [3, 2], [4, 2], [5, 3]])
  const have = [{ number: 1, volume: 1 }, { number: 2, volume: 1 }, { number: 3, volume: 2 }]
  expect([...assignVolumes(have, [4, 5], 2)]).toEqual([[4, 2], [5, 3]])
  expect([...assignVolumes(have, [2.5], 2)]).toEqual([[2.5, 1]]) // posted late: stays with chapter 2
  expect([...assignVolumes(have, [0], 2)]).toEqual([[0, 1]]) // before everything: first volume
})

test('a first download splits into volumes, each with cover and its own ComicInfo number and range', async () => {
  const { db, ctx, vol, rows, job } = setup([1, 2, 3, 4, 5].map(n => ch(n, n)), 2)
  enqueue(db, 1, 'download')
  await runNext(ctx)
  expect(job().state).toBe('done')
  expect(rows()).toEqual([1, 2, 3, 4, 5])
  expect(volumes(db)).toEqual([[1, 1], [2, 1], [3, 2], [4, 2], [5, 3]])
  expect(await cbzEntries(vol(1))).toEqual(['ComicInfo.xml', '0000-cover.jpg', '0001.0/001.jpg', '0001.0/002.jpg', '0002.0/001.jpg', '0002.0/002.jpg'])
  expect(await cbzEntries(vol(3))).toEqual(['ComicInfo.xml', '0000-cover.jpg', '0005.0/001.jpg', '0005.0/002.jpg'])
  const xml = await comicInfo(vol(2))
  expect(xml).toContain('<Series>S</Series>')
  expect(xml).toContain('<Number>2</Number>')
  expect(xml).toContain('<Title>Vol. 2 (Ch. 3–4)</Title>')
  expect(db.prepare(`select pages from chapters where number = 1`).get()).toEqual({ pages: 2 })
})

test('new chapters only rewrite the volumes they land in', async () => {
  const chapters = [1, 2, 3].map(n => ch(n, n))
  const { db, ctx, vol } = setup(chapters, 2)
  enqueue(db, 1, 'download')
  await runNext(ctx)
  const vol1 = readFileSync(vol(1))
  chapters.push(ch(4, 4), ch(5, 5))
  enqueue(db, 1, 'check')
  await runNext(ctx)
  expect(readFileSync(vol(1)).equals(vol1)).toBe(true) // untouched
  expect((await cbzEntries(vol(2))).filter(n => n.includes('/')).map(n => n.split('/')[0])).toEqual(['0003.0', '0003.0', '0004.0', '0004.0'])
  expect(await cbzEntries(vol(3))).toContain('0000-cover.jpg') // a new volume gets the cover too
  expect(await comicInfo(vol(2))).toContain('<Title>Vol. 2 (Ch. 3–4)</Title>')
})

test('removing a chapter rewrites only its volume', async () => {
  const { db, ctx, vol } = setup([1, 2, 3, 4].map(n => ch(n, n)), 2)
  enqueue(db, 1, 'download')
  await runNext(ctx)
  const vol2 = readFileSync(vol(2))
  db.prepare(`update chapters set removed = 1 where number = 1`).run()
  enqueue(db, 1, 'check')
  await runNext(ctx)
  expect((await cbzEntries(vol(1))).some(n => n.startsWith('0001.0/'))).toBe(false)
  expect(readFileSync(vol(2)).equals(vol2)).toBe(true)
})

test('a rebuild re-splits by size and deletes volumes past the new last one', async () => {
  const chapters = [1, 2, 3, 4, 5].map(n => ch(n, n))
  const { db, ctx, vol } = setup(chapters, 2)
  enqueue(db, 1, 'download')
  await runNext(ctx)
  db.prepare(`update series set volume_size = 3`).run()
  chapters.pop()
  enqueue(db, 1, 'rebuild')
  await runNext(ctx)
  expect(volumes(db)).toEqual([[1, 1], [2, 1], [3, 1], [4, 2]])
  expect(existsSync(vol(2))).toBe(true)
  expect(existsSync(vol(3))).toBe(false)
})

test('a series still in a single legacy CBZ is left alone until it has been split', async () => {
  const { db, ctx, sw, job } = setup([ch(1, 1)])
  db.prepare(`update series set legacy_file = '/lib/S.cbz'`).run()
  enqueue(db, 1, 'check')
  await runNext(ctx)
  expect(sw.manga).not.toHaveBeenCalled()
  expect(job().error).toContain('waiting to be split')
})
