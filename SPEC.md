# Spec: Mangarr

Source of intent: [docs/intent/mangarr.md](docs/intent/mangarr.md)

## Decisions

1. TypeScript for both server and client. The client has to be Vue to match BookOrbit, so one language means one toolchain and one container.
2. SQLite on a PVC, running as a single replica. One user and a few hundred series at most, so Postgres would be overkill.
3. Suwayomi (headless) handles every source-specific concern: extensions, Cloudflare via the existing `flaresolverr` in `media`, and rate limits. Mangarr never talks to a scanlation site directly.
4. Mangarr writes to the same `media` NFS PVC (RWX) that BookOrbit mounts at `/books`, using the same uid/gid (100000).
5. Notifications go to Gotify (`POST /message` with an application token). If Gotify isn't configured, they are only logged.
6. ~~Files are flat: `<library>/<Title>.cbz`.~~ Superseded by **Volumes** below: one folder per series, holding volume CBZs.
7. Mangarr is licensed AGPL-3.0, so BookOrbit's UI components and design tokens can be copied directly.
8. Reading happens only in BookOrbit's web reader. There's no KOReader or Kobo, so the file-hash progress matching doesn't apply.
9. Temp files go in `<library>/.mangarr-tmp/`. BookOrbit's scan walk and file watcher both skip any path segment that starts with `.` (`scanner/lib/walk.ts`, `scanner/file-watcher.service.ts`).

## Objective

A self-hosted, Sonarr-style service that keeps a series' CBZs in a BookOrbit library up to date. Originally one CBZ per series; since TBATE (18k pages, no chapter navigation in BookOrbit's reader) a series is split into **volumes**, see below.

User stories:
- I search across my Suwayomi sources and add a series. Mangarr downloads every chapter into `<library>/<Series Title>.cbz`.
- Every day, Mangarr checks each tracked series on its chosen source and appends any new chapters to that series' CBZ.
- When a check or download fails, I get one Gotify notification and the series shows as **failing** in the UI.
- I switch a series to another source. Mangarr resumes from the highest chapter number already in the CBZ. Separately, a **Redownload all** button rebuilds the CBZ from scratch.
- I can see what's queued, running and failed in an activity view.
- I can change a series' CBZ path (relative to the library or absolute, but inside it). If a file already exists there, for example because BookOrbit organised it into `<author>/<series>/`, Mangarr adopts it; otherwise Mangarr moves its CBZ there. A check never starts a fresh CBZ when the recorded one is missing. It fails and tells me to fix the path.

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 24 | Runs `.ts` natively (type stripping), so there's no server build step |
| HTTP | Hono + `@hono/node-server` | Small, and it serves both the API and the built SPA |
| DB | `node:sqlite` (built in) | No ORM; there are only 3 tables |
| Zip | `yazl` + `yauzl` | Streaming with zip64; series CBZs reach several GB |
| Client | Vue 3, Vite, Tailwind 4, reka-ui (shadcn-vue), `@lucide/vue`, Inter | The same libraries BookOrbit uses, to get the same look |
| Sources | Suwayomi-Server GraphQL API | Uses existing Mihon extensions |
| Tests | Vitest | Same as BookOrbit |

No job-queue library is needed. One in-process worker loop processes jobs from a `jobs` table one at a time.

## Data Model

```sql
series   (id, title, suwayomi_manga_id, source_name, cover_url, status: 'ok'|'failing',
          last_checked_at, last_error, file_path, added_at)
chapters (id, series_id, number REAL, title, suwayomi_chapter_id, downloaded_at)
jobs     (id, series_id, kind: 'check'|'download'|'rebuild', state: 'queued'|'running'|'done'|'failed',
          error, created_at, finished_at)
```

When a series switches source, its `suwayomi_manga_id` and `source_name` are updated, and only chapters whose `number` is greater than `MAX(number)` get downloaded from the new source.

## Core Flows

**Check (daily, or "Check now")**
1. Ask Suwayomi to fetch the chapter list for the series.
2. Compare it with `chapters` by `number`, and queue a `download` job for the missing chapters.
3. If the fetch throws, or returns 0 chapters when there were some before: set `status = 'failing'`. Only notify when the status changes from ok to failing, so a dead source doesn't send a notification every day.

**Download / append**
1. Fetch page lists through Suwayomi and stage each image on disk in `<library>/.mangarr-tmp/series-<id>/`. A `.done` marker per chapter lets an interrupted job resume.
2. Stream the new CBZ into `<library>/.mangarr-tmp/` once per job: the existing entries, the staged chapters, and a regenerated `ComicInfo.xml`. Memory stays constant and zip64 kicks in past 4 GB.
3. Do an atomic `rename()` over the real file, so BookOrbit never sees a half-written file.
4. Record the chapters in the DB.

**CBZ layout**
```
ComicInfo.xml
0000-cover.jpg
0001.0/001.webp     ← chapter number zero-padded so lexical sort == reading order
0001.5/001.webp     ← decimal chapters supported
0012.0/014.webp
```

## Volumes (v0.2)

Why: BookOrbit's CBZ reader has no chapter navigation, so one 18,000-page book is unreadable. BookOrbit does group books by `ComicInfo.xml` `Series` + `Number` and offers "next book" in the reader, so volumes read as one series.

- **Layout:** `<library>/<Series Title>/<Series Title> Vol. 1/<Series Title> Vol. 1.cbz`, `Vol. 2`, … One folder per volume: BookOrbit treats CBZs side by side in one folder as variants of a single book.
- **Found by content, not name:** BookOrbit renames and regroups volumes inside the series folder (e.g. `01. Beginning after the End, Vol. 1 (comic) (2022)/…`). Mangarr treats any CBZ in the folder (or one folder down) whose entries are all laid out its way as one of its volumes, identifies it by ComicInfo `<Number>` and the chapters inside, and rewrites it in place under whatever name it has. New volumes get the default name. CBZs not laid out Mangarr's way are never touched.
- **ComicInfo is merged, not replaced:** a rewrite starts from the volume's existing ComicInfo.xml, so fields BookOrbit wrote survive. Mangarr always sets `Number` and `PageCount`, sets `Title` only while it's still a generated one, fills other fields only when missing, and drops `<Pages>` (page indexes shift). The series' path setting now points at the folder; moving it moves every volume. Inside each volume the CBZ layout is unchanged.
- **ComicInfo + cover:** `Series` = series title, `Number` = volume number, `Title` = `Vol. N (Ch. a–b)`. Every volume carries the series cover as `0000-cover`, so BookOrbit shows it instead of a random first page.
- **Assignment:** every chapter row has a `volume`. A new chapter goes into the last volume while it holds fewer than `volume_size` chapters (default **25**, per series), otherwise it starts the next volume.
- **Boundaries:** on the series page, chapters are grouped by volume. Any chapter can **start a volume here**; the first chapter of a volume can **merge into the previous**. **Re-split** reassigns every chapter by the current `volume_size`. Changes queue a `restructure` job.
- **Restructure:** the new volume files are streamed straight from the old CBZs' entries (no re-download, no extraction to disk), each via temp file + rename. Old files that no longer correspond to a volume are deleted only after every new volume has been written. Peak extra disk = the size of the rewritten volumes.
- **Removing a chapter** queues a restructure too, so it's dropped from its volume without contacting the source.
- **Migration:** existing single-CBZ series are restructured into volumes on first start of v0.2, the same way. The old single file is deleted after its volumes exist.
- **BookOrbit effects:** a migrated series appears as new books (progress on the old single book is lost). A volume rewritten by a boundary change keeps its path, so BookOrbit keeps the book, but page positions shift.

Data model changes: `series.dir` (replaces `file_path`), `series.volume_size integer default 25`, `chapters.volume integer`, job kind `restructure`.

## Commands

```
Install:  pnpm install
Dev:      pnpm dev          # vite (client) + node --watch src/server/main.ts
Test:     pnpm test         # vitest run
Build:    pnpm build        # vite build → dist/public (server needs no build)
Start:    node src/server/main.ts
Image:    docker build -t mangarr .
```

Configuration (env): `SUWAYOMI_URL`, `LIBRARY_DIR`, `DATA_DIR`, `GOTIFY_URL`, `GOTIFY_TOKEN`, `CHECK_INTERVAL_HOURS` (default 24; an hourly tick queues checks for series older than this, no cron lib).

## Project Structure

```
src/server/       → main.ts, api.ts (Hono routes), db.ts, suwayomi.ts, worker.ts, cbz.ts, notify.ts
src/client/       → Vue SPA: pages/ (Library, Search, Series, Activity), components/ui/ (shadcn-vue)
test/             → *.test.ts for cbz, chapter diff, numbering
Dockerfile        → multi-stage: vite build, then node:24-slim running src/server
docs/intent/      → confirmed intent
```

## Deployment (home-ops, Flux)

Deployment manifests go in `~/Code/home-ops`. Mangarr's repo has only the Dockerfile.

```
kubernetes/apps/media/suwayomi/{ks.yaml, app/{helmrelease.yaml, kustomization.yaml}}
kubernetes/apps/media/mangarr/{ks.yaml, app/{helmrelease.yaml, kustomization.yaml}}
```

- Both use app-template HelmReleases in the same style as `bookorbit`: non-root uid 100000, read-only root filesystem, and `reloader` annotation.
- **Mangarr:** a `config` PVC (openebs-hostpath, RWO, plus the volsync component) at `/data`, the `media` PVC at `/books` with `subPath: books`, and `LIBRARY_DIR=/books/manhwa`. The route goes on `envoy-external`, and the HTTPRoute is added to `forward-auth.yaml`.
- **Suwayomi:** internal only, with no route. Its UI is reachable through `kubectl port-forward` when you need to install extensions. It gets an openebs-hostpath PVC for extensions and its database, and its FlareSolverr setting points at `flaresolverr.media.svc`.
- **Image:** `ghcr.io/<you>/mangarr`, built by a GitHub Actions workflow.

## Code Style

The code style is plain functions, with no classes and no DI. SQL is written inline, and every module exports what it does.

```ts
// src/server/cbz.ts
export const entryDir = (n: number) => n.toFixed(1).padStart(6, '0') // 1.5 → "0001.5"

export function missingChapters(remote: Chapter[], have: Set<number>): Chapter[] {
  return remote.filter(c => !have.has(c.number)).sort((a, b) => a.number - b.number)
}
```

- Prettier defaults, single quotes, no semicolons.
- Vue uses `<script setup lang="ts">` single-file components.
- Comments explain *why*, never *what*.

## Testing Strategy

- **Unit (Vitest):** chapter diffing, entry naming/sorting, building a CBZ and appending to it (round-trip the zip and assert entry order and ComicInfo), and the ok→failing notification rule.
- **Suwayomi client:** tested against recorded GraphQL JSON fixtures, not a live server.
- **Manual end-to-end:** run against a real Suwayomi in the cluster with one short series, then confirm the series shows up in BookOrbit.
- There's no coverage target. Every branch in `cbz.ts` and `worker.ts` needs a test.

## Boundaries

- **Always:** write CBZs via temp file + atomic rename; run `pnpm test` before commit; validate API input at the route.
- **Ask first:** adding dependencies, changing the DB schema, changing the CBZ layout once real files exist, and talking to sources without going through Suwayomi.
- **Never:** delete or overwrite a CBZ without first producing the replacement; commit secrets; write to the library without uid/gid 100000.

## Success Criteria

1. Adding a 50-chapter series produces volume CBZs (2 at the default size) that BookOrbit imports as one series, in order, with title and cover.
2. When a new chapter shows up on the source, the next check appends it. BookOrbit shows the updated page count, keeps the same book entry, and keeps web-reader progress.
3. Killing the pod mid-download leaves the previous CBZ intact, and the job retries on restart.
4. A source that errors marks the series as failing and sends exactly one Gotify message.
5. Switching sources downloads only chapters numbered above the current max.
6. The UI matches BookOrbit visually: same fonts, palette, cover grid and sidebar layout.
7. Setting a volume boundary on the series page rewrites only the affected volumes, and BookOrbit shows the new split. Migrating TBATE's single 5.5GB CBZ produces its volumes without re-downloading.

## Open Questions

1. **Does replacing a file keep the book (verify first)?** BookOrbit knows when a file was modified (its `file_modified` handling exists), but I haven't confirmed that renaming a new file over the old path keeps the same book ID and its progress. Test it by hand: drop a CBZ in, read a few pages, swap in a bigger CBZ the same way Mangarr will (`mv` over the old file), and check the result.

Resolved: the library is `books/manhwa` (`LIBRARY_DIR=/books/manhwa`). The image is built by GitHub Actions and pushed to GHCR.
