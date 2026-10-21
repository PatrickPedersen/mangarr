import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import { text } from 'node:stream/consumers'
import yauzl from 'yauzl'
import yazl from 'yazl'

/** A new archive entry whose bytes are in a file on disk (staged pages, cover). */
export type AddFile = { name: string; path: string }
export type ComicInfo = { series: string; number?: number; title?: string; summary?: string | null; writer?: string | null; genre?: string[]; web?: string | null }

// 1 → "0001.0", 12.5 → "0012.5": lexical order == reading order. Extra decimals (10.25) keep their digits.
export const chapterDir = (n: number) => {
  const [int, frac = '0'] = String(n).split('.')
  return `${int!.padStart(4, '0')}.${frac}`
}
export const pageName = (chapter: number, index: number, ext: string) => `${chapterDir(chapter)}/${String(index + 1).padStart(3, '0')}.${ext}`

const isPage = (name: string) => /^\d{4}\.\d+\/\d{3}\.\w+$/.test(name)
const isCover = (name: string) => name.startsWith('0000-cover.')

const esc = (s: string) => s.replace(/[<>&'"]/g, c => `&#${c.charCodeAt(0)};`)

function comicInfoXml(info: ComicInfo, pageCount: number) {
  const tags: [string, string | null | undefined][] = [
    ['Series', info.series], ['Number', info.number?.toString()], ['Title', info.title ?? info.series], ['Summary', info.summary], ['Writer', info.writer],
    ['Genre', info.genre?.join(', ')], ['Web', info.web], ['PageCount', String(pageCount)], ['Manga', 'YesAndRightToLeft'],
  ]
  const body = tags.filter(([, v]) => v).map(([k, v]) => `  <${k}>${esc(v!)}</${k}>`).join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo>\n${body}\n</ComicInfo>\n`
}

const openZip = (path: string) =>
  new Promise<yauzl.ZipFile>((ok, fail) => yauzl.open(path, { lazyEntries: true, autoClose: false }, (e, z) => (e ? fail(e) : ok(z))))

function listEntries(zip: yauzl.ZipFile) {
  return new Promise<yauzl.Entry[]>((ok, fail) => {
    const all: yauzl.Entry[] = []
    zip.on('entry', (e: yauzl.Entry) => (all.push(e), zip.readEntry()))
    zip.on('end', () => ok(all))
    zip.on('error', fail)
    zip.readEntry()
  })
}

/** Pages to copy from another CBZ: entries whose chapter dir passes `keep`. */
export type Source = { path: string; keep: (chapterDir: string) => boolean }

/**
 * Rewrites `target` as its existing pages + `add` and a fresh ComicInfo.xml, streaming entry by
 * entry (constant memory, zip64 past 4 GB). Built in a dot-directory beside it and renamed over it:
 * BookOrbit ignores dot paths and never sees a partial file, and a crash leaves the old CBZ intact.
 */
export async function writeCbz(target: string, add: AddFile[], info: ComicInfo, opts: BuildOptions = {}) {
  const tmp = await buildCbz(target, add, info, opts)
  try {
    renameSync(tmp, target)
  } finally {
    cleanTmp(target)
  }
}

type BuildOptions = { fresh?: boolean; drop?: Set<string>; from?: Source[] }

/**
 * The first half of writeCbz: builds the new archive and returns its temp path without touching
 * `target`, so several volumes can be built before any is replaced. The caller renames it, then cleanTmp().
 * fresh: don't start from `target`'s own entries. drop: chapter dirs (e.g. "0041.0") to leave out.
 * from: other CBZs to copy pages from; the first cover found is kept if `add` has none.
 */
export async function buildCbz(target: string, add: AddFile[], info: ComicInfo, { fresh = false, drop = new Set<string>(), from = [] }: BuildOptions = {}) {
  const sources: Source[] = [...(!fresh && existsSync(target) ? [{ path: target, keep: () => true }] : []), ...from]
  const zips: yauzl.ZipFile[] = []
  try {
    const taken = new Set(add.map(a => a.name))
    let hasCover = add.some(a => isCover(a.name))
    // pipe() doesn't forward input errors to yazl; without this a failing read (e.g. an NFS hiccup) hangs forever.
    let abort = (_e: Error) => {}
    const guard = (s: Readable) => s.on('error', e => abort(e))
    type Item = { name: string; size: number; open: () => Promise<Readable> }
    const items: Item[] = add.map(a => ({ name: a.name, size: statSync(a.path).size, open: async () => guard(createReadStream(a.path)) }))
    for (const src of sources) {
      const zip = await openZip(src.path)
      zips.push(zip)
      for (const e of await listEntries(zip)) {
        const name = e.fileName
        const ok = isCover(name) ? !hasCover : isPage(name) && !taken.has(name) && !drop.has(name.split('/')[0]!) && src.keep(name.split('/')[0]!)
        if (!ok) continue
        if (isCover(name)) hasCover = true
        taken.add(name) // a chapter found in two sources (after an interrupted restructure) is copied once
        items.push({ name, size: e.uncompressedSize, open: () => new Promise<Readable>((res, fail) => zip.openReadStream(e, (err, st) => (err ? fail(err) : res(guard(st))))) })
      }
    }
    items.sort((a, b) => (a.name < b.name ? -1 : 1))

    const zip = new yazl.ZipFile()
    zip.addBuffer(Buffer.from(comicInfoXml(info, items.filter(i => isPage(i.name)).length)), 'ComicInfo.xml', { compress: false })
    // Images are already compressed: store them (no CPU, seek-friendly for readers).
    for (const item of items) {
      zip.addReadStreamLazy(item.name, { compress: false, size: item.size }, cb => item.open().then(s => cb(null, s), e => cb(e, undefined as never)))
    }
    zip.end()

    const tmpDir = join(dirname(target), '.mangarr-tmp')
    mkdirSync(tmpDir, { recursive: true })
    const tmp = join(tmpDir, basename(target))
    try {
      await new Promise<void>((ok, fail) => {
        const out = zip.outputStream as Readable
        abort = e => {
          out.destroy(e)
          fail(e)
        }
        zip.on('error', abort)
        pipeline(out, createWriteStream(tmp)).then(ok, fail)
      })
    } catch (e) {
      cleanTmp(target)
      throw e
    }
    return tmp
  } finally {
    for (const z of zips) z.close()
  }
}

/** Removes target's temp file (if a build or rename failed) and the dot-dir once it's empty. */
export function cleanTmp(target: string) {
  const tmpDir = join(dirname(target), '.mangarr-tmp')
  rmSync(join(tmpDir, basename(target)), { force: true })
  // Don't leave empty dot-dirs inside folders BookOrbit organises; fails harmlessly while other temp files remain.
  try { rmdirSync(tmpDir) } catch {}
}

/** The <Title> in a CBZ's ComicInfo.xml, or null. */
export async function comicInfoTitle(path: string) {
  const zip = await openZip(path)
  try {
    const entry = (await listEntries(zip)).find(e => e.fileName === 'ComicInfo.xml')
    if (!entry) return null
    const xml = await new Promise<string>((ok, fail) => zip.openReadStream(entry, (e, s) => (e ? fail(e) : text(s).then(ok, fail))))
    const title = xml.match(/<Title>(.*?)<\/Title>/s)?.[1]
    return title === undefined ? null : title.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  } finally {
    zip.close()
  }
}

/** Entry names currently in a CBZ (used to verify and in tests). */
export async function cbzEntries(path: string) {
  const zip = await openZip(path)
  try {
    return (await listEntries(zip)).map(e => e.fileName)
  } finally {
    zip.close()
  }
}

// Filesystem-safe and stable, so the same title always maps to the same folder and files.
export const safeName = (title: string) => title.replace(/[\/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim()
// Each volume gets its own folder: BookOrbit treats CBZs side by side in one folder as variants of one book.
export const volumeName = (title: string, volume: number) => `${safeName(title)} Vol. ${volume}/${safeName(title)} Vol. ${volume}.cbz`
