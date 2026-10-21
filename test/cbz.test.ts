import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { text } from 'node:stream/consumers'
import yauzl from 'yauzl'
import yazl from 'yazl'
import { createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import { expect, test } from 'vitest'
import { cbzEntries, chapterDir, pageName, volumeName, writeCbz, type AddFile } from '../src/server/cbz.ts'

const lib = () => mkdtempSync(join(tmpdir(), 'mangarr-'))

// Stages fake pages on disk the way the worker does and returns them as AddFiles.
function stage(dir: string, chapters: [number, number][], cover?: string): AddFile[] {
  const out: AddFile[] = []
  for (const [n, count] of chapters) {
    mkdirSync(join(dir, chapterDir(n)), { recursive: true })
    for (let i = 0; i < count; i++) {
      const name = pageName(n, i, 'webp')
      writeFileSync(join(dir, name), `c${n}p${i}`)
      out.push({ name, path: join(dir, name) })
    }
  }
  if (cover) {
    writeFileSync(join(dir, '0000-cover.webp'), cover)
    out.push({ name: '0000-cover.webp', path: join(dir, '0000-cover.webp') })
  }
  return out
}

function read(path: string, name: string) {
  return new Promise<string>((ok, fail) =>
    yauzl.open(path, { lazyEntries: true }, (e, z) => {
      if (e) return fail(e)
      z.on('entry', (entry: yauzl.Entry) =>
        entry.fileName === name ? z.openReadStream(entry, (err, s) => (err ? fail(err) : text(s).then(ok, fail))) : z.readEntry(),
      )
      z.on('end', () => fail(new Error(`${name} not found`)))
      z.readEntry()
    }),
  )
}

test('chapterDir pads and sorts in reading order', () => {
  expect(chapterDir(1)).toBe('0001.0')
  expect(chapterDir(12.5)).toBe('0012.5')
  expect([10, 2, 1.5, 100, 1].map(chapterDir).sort()).toEqual(['0001.0', '0001.5', '0002.0', '0010.0', '0100.0'])
})

test('creates a CBZ with ComicInfo first, then cover and pages in reading order', async () => {
  const dir = lib()
  const target = join(dir, 'Nano Machine.cbz')
  await writeCbz(target, stage(join(dir, 's'), [[2, 2], [1, 3]], 'cover'), { series: 'Nano Machine', genre: ['Action', 'Martial Arts'] })
  expect(await cbzEntries(target)).toEqual([
    'ComicInfo.xml', '0000-cover.webp', '0001.0/001.webp', '0001.0/002.webp', '0001.0/003.webp', '0002.0/001.webp', '0002.0/002.webp',
  ])
  const xml = await read(target, 'ComicInfo.xml')
  expect(xml).toContain('<Series>Nano Machine</Series>')
  expect(xml).toContain('<PageCount>5</PageCount>')
  expect(xml).toContain('<Genre>Action, Martial Arts</Genre>')
})

test('append keeps existing pages and cover, adds new ones, updates PageCount', async () => {
  const dir = lib()
  const target = join(dir, 'S.cbz')
  await writeCbz(target, stage(join(dir, 'a'), [[1, 2]], 'cover'), { series: 'S' })
  await writeCbz(target, stage(join(dir, 'b'), [[1.5, 1], [2, 2]]), { series: 'S' })
  expect(await read(target, '0001.0/002.webp')).toBe('c1p1')
  expect(await read(target, '0000-cover.webp')).toBe('cover')
  expect((await cbzEntries(target)).filter(n => n.includes('/'))).toEqual([
    '0001.0/001.webp', '0001.0/002.webp', '0001.5/001.webp', '0002.0/001.webp', '0002.0/002.webp',
  ])
  expect(await read(target, 'ComicInfo.xml')).toContain('<PageCount>5</PageCount>')
})

test('re-adding an existing entry replaces it instead of duplicating', async () => {
  const dir = lib()
  const target = join(dir, 'S.cbz')
  await writeCbz(target, stage(join(dir, 'a'), [[1, 1]]), { series: 'S' })
  const again = stage(join(dir, 'b'), [[1, 1]])
  writeFileSync(again[0]!.path, 'new')
  await writeCbz(target, again, { series: 'S' })
  expect(await cbzEntries(target)).toEqual(['ComicInfo.xml', '0001.0/001.webp'])
  expect(await read(target, '0001.0/001.webp')).toBe('new')
})

test('escapes XML in metadata', async () => {
  const dir = lib()
  const target = join(dir, 'S.cbz')
  await writeCbz(target, stage(join(dir, 'a'), [[1, 1]]), { series: 'A & B <1>' })
  expect(await read(target, 'ComicInfo.xml')).toContain('<Series>A &#38; B &#60;1&#62;</Series>')
})

test('a failed write leaves the original byte-identical and no temp file behind', async () => {
  const dir = lib()
  const target = join(dir, 'S.cbz')
  await writeCbz(target, stage(join(dir, 'a'), [[1, 2]]), { series: 'S' })
  const before = readFileSync(target)
  expect(existsSync(join(dir, '.mangarr-tmp'))).toBe(false) // cleaned up after a successful write
  // A directory passes stat() but fails once the zip stream reads it: a mid-write failure, even as root.
  const broken = [...stage(join(dir, 'b'), [[2, 1]]), { name: '0002.0/002.webp', path: join(dir, 'b') }]
  await expect(writeCbz(target, broken, { series: 'S' })).rejects.toThrow()
  expect(readFileSync(target).equals(before)).toBe(true)
  expect(existsSync(join(dir, '.mangarr-tmp', 'S.cbz'))).toBe(false)
})

test('volumeName gives each volume its own folder and strips reserved characters', () => {
  expect(volumeName('Solo Leveling: Ragnarok / Part 2?', 3)).toBe('Solo Leveling Ragnarok Part 2 Vol. 3/Solo Leveling Ragnarok Part 2 Vol. 3.cbz')
})

test('ComicInfo carries the volume number and title so BookOrbit orders volumes as one series', async () => {
  const dir = lib()
  const target = join(dir, 'S Vol. 02.cbz')
  await writeCbz(target, stage(join(dir, 'a'), [[26, 1]]), { series: 'S', number: 2, title: 'Vol. 2 (Ch. 26–50)' })
  const xml = await read(target, 'ComicInfo.xml')
  expect(xml).toContain('<Series>S</Series>')
  expect(xml).toContain('<Number>2</Number>')
  expect(xml).toContain('<Title>Vol. 2 (Ch. 26–50)</Title>')
})

// A CBZ as BookOrbit leaves it after editing metadata: its fields in ComicInfo.xml, written in place.
async function bookOrbitCbz(path: string, xml: string) {
  const zip = new yazl.ZipFile()
  zip.addBuffer(Buffer.from(xml), 'ComicInfo.xml')
  zip.addBuffer(Buffer.from('c1p0'), '0001.0/001.webp')
  zip.end()
  await finished(zip.outputStream.pipe(createWriteStream(path)))
}
const edited = (title: string) => `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo>
  <Title>${title}</Title>
  <Series>S</Series>
  <Number>1</Number>
  <Summary>My own summary &amp; notes</Summary>
  <Tags>favourite, reread</Tags>
  <CommunityRating>4.5</CommunityRating>
  <Notes>[BookOrbit]
hardcoverId: 123</Notes>
  <PageCount>1</PageCount>
  <Pages>
    <Page Image="0" Type="FrontCover" />
  </Pages>
</ComicInfo>
`

test("a rewrite keeps what BookOrbit wrote into ComicInfo.xml and only updates Mangarr's own fields", async () => {
  const dir = lib()
  const target = join(dir, 'S Vol. 1.cbz')
  await bookOrbitCbz(target, edited('My favourite arc'))
  await writeCbz(target, stage(join(dir, 'a'), [[2, 2]]), { series: 'Other', number: 1, title: 'S Vol. 1 (Ch. 1–2)', summary: 'From the source', genre: ['Action'] })
  const xml = await read(target, 'ComicInfo.xml')
  expect(xml).toContain('<Title>My favourite arc</Title>') // set by hand: kept
  expect(xml).toContain('<Series>S</Series>') // present: kept
  expect(xml).toContain('<Summary>My own summary &amp; notes</Summary>')
  expect(xml).toContain('<Tags>favourite, reread</Tags>')
  expect(xml).toContain('<CommunityRating>4.5</CommunityRating>')
  expect(xml).toContain('hardcoverId: 123')
  expect(xml).toContain('<PageCount>3</PageCount>') // always follows the pages
  expect(xml).toContain('<Genre>Action</Genre>') // missing: added
  expect(xml).not.toContain('<Pages>') // page indexes no longer valid
  expect(xml.match(/<Title>/g)).toHaveLength(1)
})

test('a generated title is still updated', async () => {
  const dir = lib()
  const target = join(dir, 'S Vol. 1.cbz')
  await bookOrbitCbz(target, edited('Vol. 1 (Ch. 1)'))
  await writeCbz(target, [], { series: 'S', number: 1, title: 'S Vol. 1 (Ch. 1)' })
  const xml = await read(target, 'ComicInfo.xml')
  expect(xml).toContain('<Title>S Vol. 1 (Ch. 1)</Title>')
  expect(xml).toContain('<Tags>favourite, reread</Tags>')
})
