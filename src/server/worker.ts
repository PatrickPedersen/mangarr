import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { DatabaseSync } from 'node:sqlite'
import * as suwayomi from './suwayomi.ts'
import type { Notify } from './notify.ts'
import { buildCbz, cbzEntries, chapterDir, cleanTmp, pageName, safeName, volumeName, writeCbz, type AddFile } from './cbz.ts'

export type Ctx = { db: DatabaseSync; sw: Pick<typeof suwayomi, 'manga' | 'pages' | 'image'>; libraryDir: string; notify: Notify }
type Series = {
  id: number; title: string; source_name: string; status: 'ok' | 'failing'; suwayomi_manga_id: number
  dir: string; volume_size: number; legacy_file: string | null; volumes_dirty: number; resume_after: number | null
}
type JobKind = 'check' | 'download' | 'rebuild' | 'restructure'

export function enqueue(db: DatabaseSync, seriesId: number, kind: JobKind) {
  // A series never needs two pending jobs of a sort; the queued one will see everything.
  // Restructures are their own sort: they never touch the source, so a check doesn't cover one or vice versa.
  const pending = (db.prepare(`select id, kind from jobs where series_id = ? and state = 'queued'`).all(seriesId) as { id: number; kind: JobKind }[])
    .find(j => (j.kind === 'restructure') === (kind === 'restructure'))
  if (!pending) db.prepare(`insert into jobs (series_id, kind) values (?, ?)`).run(seriesId, kind)
  // ...except a rebuild does strictly more than a check, so it takes over the queued job.
  else if (kind === 'rebuild') db.prepare(`update jobs set kind = 'rebuild' where id = ?`).run(pending.id)
}

/** Remote chapters not yet in the CBZ, one per number (first by source order wins), oldest first. */
export function missingChapters(remote: suwayomi.Chapter[], have: Set<number>) {
  // Oneshots and some sources number nothing; then source order is the only ordering there is.
  if (remote.length && remote.every(c => c.chapterNumber < 0)) remote = remote.map(c => ({ ...c, chapterNumber: c.sourceOrder }))
  const byNumber = new Map<number, suwayomi.Chapter>()
  for (const c of [...remote].sort((a, b) => a.sourceOrder - b.sourceOrder)) {
    // -1 = the extension couldn't parse a number (announcements, hiatus notices).
    if (c.chapterNumber < 0 || have.has(c.chapterNumber) || byNumber.has(c.chapterNumber)) continue
    byNumber.set(c.chapterNumber, c)
  }
  return [...byNumber.values()].sort((a, b) => a.chapterNumber - b.chapterNumber)
}

/** Page counts far from the series' usual (over 3x or under 1/3 of the median) are worth a human look. */
export function pageCountWarnings(baseline: number[], fresh: Map<number, number>) {
  const sample = baseline.length >= 5 ? baseline : [...baseline, ...fresh.values()]
  if (sample.length < 5) return new Map<number, string>()
  const sorted = [...sample].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!
  const out = new Map<number, string>()
  for (const [number, pages] of fresh) {
    if (pages > median * 3 || pages < median / 3) out.set(number, `${pages} pages; this series usually has about ${median}`)
  }
  return out
}

/**
 * Volume per new chapter. Chapters past the current last one fill the last volume up to `size`,
 * then start the next. A late chapter that sorts before the last (12.5 posted after 13) joins the
 * volume of the chapter just before it.
 */
export function assignVolumes(have: { number: number; volume: number }[], add: number[], size: number) {
  const sorted = [...have].sort((a, b) => a.number - b.number)
  const max = sorted.at(-1)?.number ?? -Infinity
  let last = Math.max(1, ...have.map(h => h.volume))
  let count = have.filter(h => h.volume === last).length
  const out = new Map<number, number>()
  for (const n of add) {
    if (n < max) {
      out.set(n, (sorted.findLast(h => h.number < n) ?? sorted[0]!).volume)
      continue
    }
    if (count >= size) [last, count] = [last + 1, 0]
    out.set(n, last)
    count++
  }
  return out
}

const range = (nums: number[]) => {
  const [lo, hi] = [Math.min(...nums), Math.max(...nums)]
  return lo === hi ? `Ch. ${lo}` : `Ch. ${lo}–${hi}`
}

/**
 * Pages are staged on disk (in the library's dot-dir, which BookOrbit ignores) and the CBZ is
 * rebuilt once at the end: each volume that got chapters (or lost removed ones) is rewritten once. A chapter counts as staged once its `.done` marker exists, so a job
 * that dies halfway resumes without re-fetching, and memory never holds more than one page.
 * `fresh` (Redownload all) ignores what we have and rewrites every volume, re-split by volume size.
 * Chapters marked removed are dropped from the CBZ here and never fetched again, not even by `fresh`.
 */
async function download({ db, sw, libraryDir, notify }: Ctx, series: Series, fresh: boolean) {
  const { manga, chapters } = await sw.manga(series.suwayomi_manga_id)
  const rows = db.prepare(`select number, removed, volume, pages from chapters where series_id = ?`).all(series.id) as {
    number: number; removed: number; volume: number; pages: number | null
  }[]
  const removed = rows.filter(r => r.removed)
  const kept = rows.filter(r => !r.removed)
  const have = new Set(fresh ? removed.map(r => r.number) : rows.map(r => r.number))
  // Never start fresh volumes for a series that already has some: it was moved (e.g. by BookOrbit) or deleted.
  if (!fresh && kept.length > 0 && !existsSync(series.dir)) {
    throw new Error(`folder not found at ${series.dir}. If it was moved, update the path on the series page.`)
  }
  // A source that suddenly lists nothing has usually removed the series or is serving a block page.
  if (kept.length > 0 && chapters.length === 0) throw new Error('source returned no chapters (series removed, or the site is blocking us?)')
  let todo = missingChapters(chapters, have)
  // After a source switch, only take chapters past what the old source gave us: numbering often differs between sites.
  if (!fresh && series.resume_after !== null) {
    const latest = Math.max(...chapters.map(c => c.chapterNumber))
    if (latest < series.resume_after) {
      throw new Error(`this source's latest chapter (${latest}) is below what we already have (${series.resume_after}); its numbering differs. Use Redownload all.`)
    }
    todo = todo.filter(c => c.chapterNumber > series.resume_after!)
  }
  if ((fresh || kept.length === 0) && todo.length === 0) throw new Error('source returned no downloadable chapters')

  const base = fresh ? [] : kept
  const volumeOf = assignVolumes(base, todo.map(c => c.chapterNumber), series.volume_size)
  const path = (v: number) => join(series.dir, volumeName(series.title, v))
  const drop = new Set(removed.map(r => chapterDir(r.number)))
  const targets = new Set(volumeOf.values())
  if (!fresh) {
    for (const v of new Set(removed.map(r => r.volume))) {
      if (existsSync(path(v)) && (await cbzEntries(path(v))).some(n => drop.has(n.split('/')[0]!))) targets.add(v)
    }
  }
  if (targets.size === 0) return touch(db, series.id)
  for (const v of targets) {
    if (!fresh && kept.some(r => r.volume === v) && !existsSync(path(v))) {
      throw new Error(`${path(v)} not found. If the series was moved, update the path on the series page.`)
    }
  }

  // Keyed by id under the library root, so changing the series' path doesn't orphan staged pages.
  const stage = join(libraryDir, '.mangarr-tmp', `series-${series.id}`)
  const add = new Map<number, AddFile[]>()
  const newCounts = new Map<number, number>()
  for (const ch of todo) {
    const dir = join(stage, chapterDir(ch.chapterNumber))
    if (!existsSync(join(dir, '.done'))) {
      const paths = await sw.pages(ch.id)
      // Pages already staged by an earlier, failed attempt are kept, so flaky CDNs converge over retries.
      // Only while the page list is the same one: some sites serve a different list per request (locked previews).
      const listFile = join(dir, '.pages')
      if (existsSync(listFile) && readFileSync(listFile, 'utf8') !== JSON.stringify(paths)) rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      writeFileSync(listFile, JSON.stringify(paths))
      const staged = new Set(readdirSync(dir).filter(f => !f.startsWith('.') && !f.endsWith('.part')).map(f => f.split('.')[0]))
      for (const [i, path] of paths.entries()) {
        if (staged.has(String(i + 1).padStart(3, '0'))) continue
        const { data, ext } = await sw.image(path)
        const file = join(stage, pageName(ch.chapterNumber, i, ext))
        writeFileSync(file + '.part', data)
        renameSync(file + '.part', file) // a crash mid-write never leaves a truncated page that looks staged
      }
      writeFileSync(join(dir, '.done'), '')
    }
    const pages = readdirSync(dir).filter(f => !f.startsWith('.') && !f.endsWith('.part'))
    const v = volumeOf.get(ch.chapterNumber)!
    add.set(v, [...(add.get(v) ?? []), ...pages.map(f => ({ name: `${chapterDir(ch.chapterNumber)}/${f}`, path: join(dir, f) }))])
    newCounts.set(ch.chapterNumber, pages.length)
  }
  // Every volume carries the series cover, so BookOrbit doesn't pick a random first page.
  const needsCover = [...targets].filter(v => fresh || !existsSync(path(v)))
  if (needsCover.length && manga.thumbnailUrl) {
    const { data, ext } = await sw.image(manga.thumbnailUrl)
    writeFileSync(join(stage, `0000-cover.${ext}`), data)
    for (const v of needsCover) add.set(v, [...(add.get(v) ?? []), { name: `0000-cover.${ext}`, path: join(stage, `0000-cover.${ext}`) }])
  }

  const warnings = pageCountWarnings(base.flatMap(r => (r.pages === null ? [] : [r.pages])), newCounts)
  const after = [...base, ...todo.map(c => ({ number: c.chapterNumber, volume: volumeOf.get(c.chapterNumber)! }))]
  // Series title from our record, not the source: a source switch must not split the series in BookOrbit.
  const info = { series: series.title, summary: manga.description, writer: manga.author, genre: manga.genre, web: manga.realUrl }
  mkdirSync(series.dir, { recursive: true })
  for (const v of [...targets].sort((a, b) => a - b)) {
    const title = `Vol. ${v} (${range(after.filter(c => c.volume === v).map(c => c.number))})`
    await writeCbz(path(v), add.get(v) ?? [], { ...info, number: v, title }, { fresh, drop })
  }
  if (fresh) {
    // Volumes past the new last one (the source has fewer chapters now) are gone; their replacements exist.
    const lastVolume = Math.max(...targets)
    const prefix = `${safeName(series.title)} Vol. `
    for (const f of readdirSync(series.dir)) {
      if (f.startsWith(prefix) && f.endsWith('.cbz') && Number(f.slice(prefix.length, -4)) > lastVolume) rmSync(join(series.dir, f))
    }
  }
  // Recorded after the renames: a crash in between re-adds the same staged entries next time, which is harmless.
  db.exec('begin')
  try {
    if (fresh) {
      db.prepare(`delete from chapters where series_id = ? and removed = 0`).run(series.id)
      db.prepare(`update series set resume_after = null where id = ?`).run(series.id)
    }
    const ins = db.prepare(`insert or ignore into chapters (series_id, number, title, suwayomi_chapter_id, warning, volume, pages) values (?, ?, ?, ?, ?, ?, ?)`)
    for (const ch of todo) {
      const n = ch.chapterNumber
      ins.run(series.id, n, ch.name, ch.id, warnings.get(n) ?? null, volumeOf.get(n)!, newCounts.get(n)!)
    }
    db.exec('commit')
  } catch (e) {
    db.exec('rollback')
    throw e
  }
  rmSync(stage, { recursive: true, force: true })
  touch(db, series.id)
  if (warnings.size) {
    const lines = [...warnings].map(([n, w]) => `Chapter ${n}: ${w}`)
    await notify(`Mangarr: check ${series.title}`, `${lines.join('\n')}\nIf it's junk, remove it on the series page.`)
  }
}

const volumeFile = (series: Series, v: number) => join(series.dir, volumeName(series.title, v))

/**
 * Makes the volume files match chapters.volume: after the user moved a boundary, changed the size,
 * or when a v0.1 single CBZ (legacy_file) has to be split. Pages are copied from wherever they are
 * now, found by reading the files rather than trusting the DB, so a restructure that died halfway
 * can simply run again. Nothing is re-downloaded.
 *
 * Every rewritten volume is built before any is renamed into place, and a volume that gains
 * chapters is renamed before the one that loses them: a crash between renames can duplicate a
 * chapter, never lose one. Files that end up unused (the legacy CBZ, volumes past the last) are
 * deleted only after that.
 */
async function restructure({ db, sw }: Ctx, series: Series) {
  const rows = db.prepare(`select number, volume from chapters where series_id = ? and removed = 0 order by number`).all(series.id) as { number: number; volume: number | null }[]
  // Chapters from a legacy CBZ have no volume yet: split them by size.
  if (rows.some(r => r.volume === null)) {
    const vol = assignVolumes([], rows.map(r => r.number), series.volume_size)
    for (const r of rows) r.volume = vol.get(r.number)!
  }
  const prefix = `${safeName(series.title)} Vol. `
  const isVolume = (f: string) => f.startsWith(prefix) && f.endsWith('.cbz') && /^\d+$/.test(f.slice(prefix.length, -4))
  const files = [
    ...(series.legacy_file && existsSync(series.legacy_file) ? [series.legacy_file] : []),
    ...(existsSync(series.dir) ? readdirSync(series.dir).filter(isVolume).map(f => join(series.dir, f)) : []),
  ]

  // Where each chapter's pages are now, and what each file holds (chapter dir → page count).
  const where = new Map<string, string>()
  const content = new Map<string, Map<string, number>>()
  for (const f of files) {
    const counts = new Map<string, number>()
    for (const n of await cbzEntries(f)) {
      if (!n.includes('/')) continue
      const d = n.split('/')[0]!
      counts.set(d, (counts.get(d) ?? 0) + 1)
      if (!where.has(d)) where.set(d, f)
    }
    content.set(f, counts)
  }
  const missing = rows.filter(r => !where.has(chapterDir(r.number)))
  if (missing.length) {
    const place = series.legacy_file ?? series.dir
    throw new Error(`chapter${missing.length > 1 ? 's' : ''} ${missing.map(r => r.number).join(', ')} not found in ${place}. If it was moved, update the path; otherwise use Redownload all.`)
  }

  const want = new Map<number, string[]>()
  for (const r of rows) want.set(r.volume!, [...(want.get(r.volume!) ?? []), chapterDir(r.number)])
  const unchanged = (file: string, dirs: string[]) => content.get(file)?.size === dirs.length && dirs.every(d => content.get(file)!.has(d))
  const rewrite = [...want].filter(([v, dirs]) => !unchanged(volumeFile(series, v), dirs))

  // Metadata is nice to have; a source that's down must not block a restructure.
  const meta = await sw.manga(series.suwayomi_manga_id).then(
    ({ manga }) => ({ summary: manga.description, writer: manga.author, genre: manga.genre, web: manga.realUrl }),
    () => ({}),
  )
  const built = new Map<string, string>() // target → temp file
  const readsFrom = new Map<string, Set<string>>()
  try {
    for (const [v, dirs] of rewrite) {
      const target = volumeFile(series, v)
      const mine = new Set(dirs)
      const from = [...new Set(dirs.map(d => where.get(d)!))]
      readsFrom.set(target, new Set(from))
      const numbers = rows.filter(r => r.volume === v).map(r => r.number)
      mkdirSync(series.dir, { recursive: true })
      const info = { series: series.title, ...meta, number: v, title: `Vol. ${v} (${range(numbers)})` }
      built.set(target, await buildCbz(target, [], info, { fresh: true, from: from.map(path => ({ path, keep: (d: string) => mine.has(d) })) }))
    }
    const pending = new Set(built.keys())
    while (pending.size) {
      // Rename a volume only once every volume taking chapters from it is in place.
      const ready = [...pending].filter(t => ![...pending].some(u => u !== t && readsFrom.get(u)!.has(t)))
      for (const t of ready.length ? ready : [...pending]) {
        renameSync(built.get(t)!, t)
        pending.delete(t)
      }
    }
  } finally {
    for (const t of built.keys()) cleanTmp(t)
  }
  if (rows.length) {
    const used = new Set([...want.keys()].map(v => volumeFile(series, v)))
    for (const f of files) if (!used.has(f)) rmSync(f)
  }

  db.exec('begin')
  try {
    const upd = db.prepare(`update chapters set volume = ?, pages = ? where series_id = ? and number = ?`)
    for (const r of rows) upd.run(r.volume, content.get(where.get(chapterDir(r.number))!)!.get(chapterDir(r.number))!, series.id, r.number)
    db.prepare(`update series set legacy_file = null, volumes_dirty = 0 where id = ?`).run(series.id)
    db.exec('commit')
  } catch (e) {
    db.exec('rollback')
    throw e
  }
}

const touch = (db: DatabaseSync, id: number) =>
  db.prepare(`update series set status = 'ok', last_checked_at = datetime('now'), last_error = null where id = ?`).run(id)

/** Runs the oldest queued job. Returns false when the queue is empty. */
export async function runNext(ctx: Ctx) {
  const job = ctx.db.prepare(`select id, series_id, kind from jobs where state = 'queued' order by id limit 1`).get() as
    | { id: number; series_id: number; kind: JobKind }
    | undefined
  if (!job) return false
  ctx.db.prepare(`update jobs set state = 'running' where id = ?`).run(job.id)
  try {
    const get = () => ctx.db.prepare(`select * from series where id = ?`).get(job.series_id) as Series
    // Files first match the volumes the DB says, so a download never appends to a volume that's about to move.
    if (job.kind === 'restructure' || get().volumes_dirty) await restructure(ctx, get())
    // 'check' and 'download' are the same work: diff against the source, fetch what's missing.
    if (job.kind !== 'restructure') await download(ctx, get(), job.kind === 'rebuild')
    ctx.db.prepare(`update jobs set state = 'done', finished_at = datetime('now') where id = ?`).run(job.id)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    ctx.db.prepare(`update jobs set state = 'failed', error = ?, finished_at = datetime('now') where id = ?`).run(msg, job.id)
    const series = ctx.db.prepare(`select title, source_name, status from series where id = ?`).get(job.series_id) as Series
    ctx.db.prepare(`update series set status = 'failing', last_error = ? where id = ?`).run(msg, job.series_id)
    // Only on the ok → failing edge: a dead source retried every hour must not notify every hour.
    if (series.status === 'ok') await ctx.notify(`Mangarr: ${series.title} is failing`, `${series.source_name}: ${msg}\nPick another source on the series page if it doesn't recover.`)
  }
  return true
}

/** Queues a check for every series not checked successfully within `hours`. Failing series stay due, so they retry each tick. */
export function scheduleChecks(db: DatabaseSync, hours: number) {
  db.exec(`delete from jobs where state in ('done', 'failed') and finished_at < datetime('now', '-30 days')`)
  const due = db
    .prepare(`select id from series where last_checked_at is null or last_checked_at <= datetime('now', ?)`)
    .all(`-${hours} hours`) as { id: number }[]
  for (const { id } of due) enqueue(db, id, 'check')
  return due.length
}

export async function start(ctx: Ctx, checkIntervalHours: number) {
  // A job that was running when the pod died starts over; download() skips what's already recorded.
  ctx.db.exec(`update jobs set state = 'queued' where state = 'running'`)
  // v0.1 single CBZs (and any restructure a crash interrupted) are split right away, not at the next check.
  for (const { id } of ctx.db.prepare(`select id from series where volumes_dirty = 1`).all() as { id: number }[]) enqueue(ctx.db, id, 'restructure')
  scheduleChecks(ctx.db, checkIntervalHours)
  setInterval(() => scheduleChecks(ctx.db, checkIntervalHours), 60 * 60 * 1000)
  for (;;) if (!(await runNext(ctx))) await sleep(5000)
}
