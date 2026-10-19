import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { DatabaseSync } from 'node:sqlite'
import * as suwayomi from './suwayomi.ts'
import type { Notify } from './notify.ts'
import { cbzEntries, chapterDir, pageName, writeCbz, type AddFile } from './cbz.ts'

export type Ctx = { db: DatabaseSync; sw: Pick<typeof suwayomi, 'manga' | 'pages' | 'image'>; libraryDir: string; notify: Notify }
type Series = {
  id: number; title: string; source_name: string; status: 'ok' | 'failing'; suwayomi_manga_id: number; file_path: string
  resume_after: number | null
}
type JobKind = 'check' | 'download' | 'rebuild'

export function enqueue(db: DatabaseSync, seriesId: number, kind: JobKind) {
  // A series never needs two pending jobs; the queued one will see everything.
  const pending = db.prepare(`select id from jobs where series_id = ? and state = 'queued'`).get(seriesId) as { id: number } | undefined
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
 * Pages are staged on disk (in the library's dot-dir, which BookOrbit ignores) and the CBZ is
 * rebuilt once at the end. A chapter counts as staged once its `.done` marker exists, so a job
 * that dies halfway resumes without re-fetching, and memory never holds more than one page.
 * `fresh` (Redownload all) ignores what we have and replaces the CBZ wholesale.
 * Chapters marked removed are dropped from the CBZ here and never fetched again, not even by `fresh`.
 */
async function download({ db, sw, libraryDir, notify }: Ctx, series: Series, fresh: boolean) {
  const { manga, chapters } = await sw.manga(series.suwayomi_manga_id)
  const rows = db.prepare(`select number, removed from chapters where series_id = ?`).all(series.id) as { number: number; removed: number }[]
  const removed = rows.filter(r => r.removed).map(r => r.number)
  const kept = rows.filter(r => !r.removed)
  const have = new Set(fresh ? removed : rows.map(r => r.number))
  // Never start a fresh CBZ for a series that already has one: it was moved (e.g. by BookOrbit) or deleted.
  if (!fresh && kept.length > 0 && !existsSync(series.file_path)) {
    throw new Error(`CBZ not found at ${series.file_path}. If it was moved, update the path on the series page.`)
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

  const drop = new Set(removed.map(chapterDir))
  const existing = !fresh && existsSync(series.file_path) ? await cbzEntries(series.file_path) : []
  const needsDrop = existing.some(n => drop.has(n.split('/')[0]!))
  if (todo.length === 0 && !needsDrop) return touch(db, series.id)

  // Keyed by id under the library root, so changing the series' path doesn't orphan staged pages.
  const stage = join(libraryDir, '.mangarr-tmp', `series-${series.id}`)
  const add: AddFile[] = []
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
    for (const f of pages) add.push({ name: `${chapterDir(ch.chapterNumber)}/${f}`, path: join(dir, f) })
    newCounts.set(ch.chapterNumber, pages.length)
  }
  if ((fresh || kept.length === 0) && manga.thumbnailUrl) {
    const { data, ext } = await sw.image(manga.thumbnailUrl)
    writeFileSync(join(stage, `0000-cover.${ext}`), data)
    add.push({ name: `0000-cover.${ext}`, path: join(stage, `0000-cover.${ext}`) })
  }

  // Baseline = pages per chapter already in the CBZ (minus removed ones).
  const perDir = new Map<string, number>()
  for (const n of existing) if (n.includes('/') && !drop.has(n.split('/')[0]!)) perDir.set(n.split('/')[0]!, (perDir.get(n.split('/')[0]!) ?? 0) + 1)
  const warnings = pageCountWarnings([...perDir.values()], newCounts)

  const info = { series: manga.title, summary: manga.description, writer: manga.author, genre: manga.genre, web: manga.realUrl }
  await writeCbz(series.file_path, add, info, { fresh, drop })
  // Recorded after the rename: a crash in between re-adds the same staged entries next time, which is harmless.
  db.exec('begin')
  try {
    if (fresh) {
      db.prepare(`delete from chapters where series_id = ? and removed = 0`).run(series.id)
      db.prepare(`update series set resume_after = null where id = ?`).run(series.id)
    }
    const ins = db.prepare(`insert or ignore into chapters (series_id, number, title, suwayomi_chapter_id, warning) values (?, ?, ?, ?, ?)`)
    for (const ch of todo) ins.run(series.id, ch.chapterNumber, ch.name, ch.id, warnings.get(ch.chapterNumber) ?? null)
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
    const series = ctx.db.prepare(`select * from series where id = ?`).get(job.series_id) as Series
    // 'check' and 'download' are the same work: diff against the source, fetch what's missing.
    await download(ctx, series, job.kind === 'rebuild')
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
  scheduleChecks(ctx.db, checkIntervalHours)
  setInterval(() => scheduleChecks(ctx.db, checkIntervalHours), 60 * 60 * 1000)
  for (;;) if (!(await runNext(ctx))) await sleep(5000)
}
