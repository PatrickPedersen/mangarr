const base = process.env.SUWAYOMI_URL ?? 'http://localhost:4567'

export type Source = { id: string; displayName: string; lang: string }
export type MangaHit = { id: number; title: string; thumbnailUrl: string | null }
export type Manga = MangaHit & {
  description: string | null
  author: string | null
  artist: string | null
  genre: string[]
  status: string
  realUrl: string | null
  source: { displayName: string }
}
export type Chapter = { id: number; name: string; chapterNumber: number; sourceOrder: number }

// Suwayomi appends the JVM stack trace and wraps the real reason; keep just the reason.
export const cleanError = (msg: string) =>
  msg.split('\n')[0]!.replace(/^Exception while fetching data \([^)]*\)\s*:\s*/, '').trim()

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${base}/api/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    // Generous: fetching from a source can go through FlareSolverr. Without a limit, one hung call stalls the queue.
    signal: AbortSignal.timeout(5 * 60_000),
  })
  if (!res.ok) throw new Error(`suwayomi ${res.status}: ${await res.text()}`)
  const body = await res.json()
  // Source failures (site down, Cloudflare, parse errors) arrive here, not as HTTP errors.
  if (body.errors?.length) throw new Error(body.errors.map((e: { message: string }) => cleanError(e.message)).join('; '))
  return body.data
}

export async function sources(): Promise<Source[]> {
  const d = await gql<{ sources: { nodes: Source[] } }>(`{ sources { nodes { id displayName lang } } }`)
  // Multi-language extensions (MangaDex, Webtoons) register one source per language; we only read English.
  return d.sources.nodes.filter(s => s.lang === 'en')
}

export async function search(source: string, query: string): Promise<MangaHit[]> {
  const d = await gql<{ fetchSourceManga: { mangas: MangaHit[] } }>(
    `mutation($source: LongString!, $query: String!) {
      fetchSourceManga(input: {source: $source, type: SEARCH, query: $query, page: 1}) { mangas { id title thumbnailUrl } }
    }`,
    { source, query },
  )
  return d.fetchSourceManga.mangas
}

// Always hits the source, so this doubles as the daily check.
export async function manga(id: number): Promise<{ manga: Manga; chapters: Chapter[] }> {
  const d = await gql<{ fetchMangaAndChapters: { manga: Manga; chapters: Chapter[] } }>(
    `mutation($id: Int!) {
      fetchMangaAndChapters(input: {id: $id, fetchManga: true, fetchChapters: true}) {
        manga { id title description author artist genre status realUrl thumbnailUrl source { displayName } }
        chapters { id name chapterNumber sourceOrder }
      }
    }`,
    { id },
  )
  return d.fetchMangaAndChapters
}

export async function pages(chapterId: number): Promise<string[]> {
  const d = await gql<{ fetchChapterPages: { pages: string[] } }>(
    `mutation($id: Int!) { fetchChapterPages(input: {chapterId: $id}) { pages } }`,
    { id: chapterId },
  )
  return d.fetchChapterPages.pages
}

// Detected from the bytes, not the content-type: Suwayomi serves cached pages as "image/jpg",
// and a block page served as an image must not end up in a CBZ.
export function sniffExt(b: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to))
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png'
  if (ascii(0, 4) === 'GIF8') return 'gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp'
  if (ascii(4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(8, 12))) return 'avif'
  return null
}

export const retry = { attempts: 4, delayMs: 2000 }

// Scanlation CDNs hiccup; one flaky page shouldn't fail a 40-chapter job. Retries 5xx and network errors only.
async function fetchRetrying(url: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2 * 60_000) })
      if (res.status < 500 || attempt >= retry.attempts) return res
    } catch (e) {
      if (attempt >= retry.attempts) throw e
    }
    await new Promise(r => setTimeout(r, retry.delayMs * attempt))
  }
}

// `path` is what pages()/thumbnailUrl return: a server-relative /api/v1/... URL.
export async function image(path: string): Promise<{ data: Uint8Array; ext: string }> {
  const res = await fetchRetrying(base + path)
  if (!res.ok) throw new Error(`suwayomi image ${res.status}: ${path}`)
  const data = new Uint8Array(await res.arrayBuffer())
  const ext = sniffExt(data)
  if (!ext) throw new Error(`not an image (content-type "${res.headers.get('content-type')}"): ${path}`)
  return { data, ext }
}
