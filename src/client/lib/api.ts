async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`)
  return data as T
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown) => request<T>('POST', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
}

export type Source = { id: string; displayName: string }
export type MangaHit = { id: number; title: string }
export type Series = {
  id: number
  title: string
  suwayomi_manga_id: number
  source_name: string
  status: 'ok' | 'failing'
  last_checked_at: string | null
  last_error: string | null
  chapter_count: number
  volume_count: number
  latest_chapter: number | null
  job_state: 'queued' | 'running' | 'done' | 'failed' | null
}

export type Job = { id: number; kind: string; state: 'queued' | 'running' | 'done' | 'failed'; error: string | null; created_at: string; finished_at: string | null }
export type Chapter = { number: number; title: string | null; downloaded_at: string; removed: number; warning: string | null; volume: number | null; pages: number | null }
export type SeriesDetail = Omit<Series, 'chapter_count' | 'volume_count' | 'latest_chapter' | 'job_state'> & {
  dir: string
  volume_size: number
  added_at: string
  chapters: Chapter[]
  jobs: Job[]
}

// SQLite datetimes are UTC without a zone marker.
export const fromDb = (s: string) => new Date(s.replace(' ', 'T') + 'Z')
export function ago(s: string | null) {
  if (!s) return 'never'
  const mins = Math.round((Date.now() - fromDb(s).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`
  return `${Math.round(mins / 1440)} days ago`
}
export type ActivityJob = Job & { series_id: number; title: string }
