import { readFileSync } from 'node:fs'
import { afterEach, expect, test, vi } from 'vitest'
import * as suwayomi from '../src/server/suwayomi.ts'

// Recorded from Suwayomi v2.4.2366 against Asura Scans.
const fixture = (name: string) => JSON.parse(readFileSync(`test/fixtures/${name}.json`, 'utf8'))

function respond(body: unknown, init: ResponseInit = {}) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(typeof body === 'string' ? body : JSON.stringify(body), init))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => vi.unstubAllGlobals())

test('search returns hits and sends source + query as variables', async () => {
  const fetch = respond(fixture('search'))
  expect(await suwayomi.search('6247824327199706550', 'nano machine')).toEqual([
    { id: 419, title: 'Nano Machine', thumbnailUrl: '/api/v1/manga/419/thumbnail' },
  ])
  const sent = JSON.parse(fetch.mock.calls[0]![1]!.body as string)
  expect(sent.variables).toEqual({ source: '6247824327199706550', query: 'nano machine' })
})

test('manga returns details and every chapter', async () => {
  respond(fixture('manga'))
  const { manga, chapters } = await suwayomi.manga(419)
  expect(manga.title).toBe('Nano Machine')
  expect(manga.source.displayName).toBe('Asura Scans (EN)')
  expect(chapters).toHaveLength(334)
  expect(chapters[0]).toMatchObject({ id: 6, chapterNumber: 1 })
})

test('pages returns server-relative page paths', async () => {
  respond(fixture('pages'))
  const pages = await suwayomi.pages(6)
  expect(pages[0]).toBe('/api/v1/manga/419/chapter/1/page/0')
})

test('graphql errors throw with the source message', async () => {
  respond({ data: null, errors: [{ message: 'HTTP error 503' }] })
  await expect(suwayomi.manga(419)).rejects.toThrow('HTTP error 503')
})

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap(p => (typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : p)))
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0])
const WEBP = bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')

test('sniffExt recognises the formats sources serve', () => {
  expect(suwayomi.sniffExt(JPEG)).toBe('jpg')
  expect(suwayomi.sniffExt(bytes([0x89], 'PNG\r\n'))).toBe('png')
  expect(suwayomi.sniffExt(bytes('GIF89a'))).toBe('gif')
  expect(suwayomi.sniffExt(WEBP)).toBe('webp')
  expect(suwayomi.sniffExt(bytes([0, 0, 0, 0x1c], 'ftypavif'))).toBe('avif')
  expect(suwayomi.sniffExt(bytes('<html>'))).toBeNull()
})

test('image uses the bytes, not the content-type, and rejects non-images', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JPEG, { headers: { 'content-type': 'image/jpg' } })))
  expect((await suwayomi.image('/p')).ext).toBe('jpg')
  respond('<html>blocked</html>', { headers: { 'content-type': 'image/webp' } })
  await expect(suwayomi.image('/p')).rejects.toThrow('not an image')
})

test('sources lists only English sources', async () => {
  respond({ data: { sources: { nodes: [
    { id: '0', displayName: 'Local source', lang: 'localsourcelang' },
    { id: '1', displayName: 'MangaDex (EN)', lang: 'en' },
    { id: '2', displayName: 'MangaDex (DE)', lang: 'de' },
  ] } } })
  expect((await suwayomi.sources()).map(s => s.id)).toEqual(['1'])
})

test('graphql errors drop the JVM stack trace and wrapper text', async () => {
  respond({ data: null, errors: [{ message: 'Exception while fetching data (/fetchMangaAndChapters) : HTTP error 403\n\njava.io.IOException: HTTP error 403\n\tat eu.kanade...' }] })
  await expect(suwayomi.manga(419)).rejects.toThrow(/^HTTP error 403$/)
})

test('image retries 5xx and network errors, but not 4xx', async () => {
  suwayomi.retry.delayMs = 0
  const fetch = vi.fn<(url: string) => Promise<Response>>()
    .mockResolvedValueOnce(new Response('', { status: 500 }))
    .mockRejectedValueOnce(new Error('ECONNRESET'))
    .mockResolvedValueOnce(new Response(JPEG))
  vi.stubGlobal('fetch', fetch)
  expect((await suwayomi.image('/p')).ext).toBe('jpg')
  expect(fetch).toHaveBeenCalledTimes(3)

  fetch.mockReset().mockResolvedValue(new Response('', { status: 404 }))
  await expect(suwayomi.image('/p')).rejects.toThrow('404')
  expect(fetch).toHaveBeenCalledTimes(1)

  fetch.mockReset().mockImplementation(async () => new Response('', { status: 503 }))
  await expect(suwayomi.image('/p')).rejects.toThrow('503')
  expect(fetch).toHaveBeenCalledTimes(suwayomi.retry.attempts)
})
