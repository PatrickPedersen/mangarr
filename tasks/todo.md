# Mangarr Tasks

Verification commands: `pnpm test`, `pnpm build`.

## Phase 1: De-risk

- [x] **T0: BookOrbit in-place swap test (manual, you)**
  - Acceptance: Put `test.cbz` in `books/manhwa` and read 3 pages in the web reader. Then `mv bigger.cbz` over it on the NFS share. After BookOrbit rescans, it's the same book entry, it has the new page count, and progress is still on page 3.
  - Verify: Look at it in the BookOrbit UI. If it fails, stop and revisit the spec.
  - Deps: none · Size: XS

- [x] **T1: Deploy headless Suwayomi to home-ops**
  - Acceptance: A `kubernetes/apps/media/suwayomi/` app-template HelmRelease in the same style as bookorbit: uid 100000, openebs-hostpath PVC with volsync, no route, FlareSolverr pointed at `flaresolverr.media.svc`. Install the extension repo and 2 or more scanlation extensions plus MangaDex. A search on each returns results.
  - Verify: `flux get ks suwayomi` is Ready. `kubectl port-forward` to it, then search in its UI.
  - Files: `suwayomi/ks.yaml`, `suwayomi/app/{helmrelease,kustomization}.yaml`, `media/kustomization.yaml`
  - Deps: none · Size: S

### Checkpoint 1
- [x] T0 passed (single-CBZ design holds)
- [x] Suwayomi reachable, sources return results

## Phase 2: Foundation

- [x] **T2: Scaffold + DB**
  - Acceptance: A pnpm project with Vite + Vue + Tailwind 4 that builds to `dist/public`. `node src/server/main.ts` serves the SPA and `GET /api/health`. `db.ts` creates the 3 tables from the spec on start.
  - Verify: `pnpm build && node src/server/main.ts`, then `curl :3000/api/health` returns 200. `pnpm test` passes a db smoke test.
  - Files: `package.json`, `vite.config.ts`, `tsconfig.json`, `src/server/{main,db}.ts`, `src/client/main.ts`
  - Deps: none · Size: M

- [x] **T3: Suwayomi client**
  - Acceptance: `suwayomi.ts` exports `sources()`, `search(sourceId, q)`, `chapters(mangaId)` (which refreshes from the source), `pages(chapterId)` and `image(url)`. It's tested against GraphQL JSON fixtures recorded from T1's instance.
  - Verify: `pnpm test test/suwayomi.test.ts`
  - Files: `src/server/suwayomi.ts`, `test/suwayomi.test.ts`, `test/fixtures/*.json`
  - Deps: T1, T2 · Size: S

- [x] **T4: CBZ build and append**
  - Acceptance: `writeCbz(path, existing?, newChapters, comicInfo)` writes to `.mangarr-tmp/` and then renames over the target. Entries are named `NNNN.N/NNN.ext` and lexical order equals reading order, decimals included. ComicInfo.xml is regenerated (Series, Summary, PageCount, Web). The cover is `0000-cover.*`.
  - Verify: `pnpm test test/cbz.test.ts`. The test builds, appends, unzips, and checks entry order and ComicInfo. A second test checks that an exception mid-write leaves the original file byte-identical.
  - Files: `src/server/cbz.ts`, `test/cbz.test.ts`
  - Deps: T2 · Size: S

- [x] **T5: UI shell from BookOrbit**
  - Acceptance: Copy BookOrbit's design tokens, fonts (Inter and Fraunces), layout/sidebar and the needed `components/ui` primitives (button, input, card, dialog, badge, sonner) over from bookorbit/bookorbit `client/src`. The router has 4 empty pages: Library, Search, Series, Activity.
  - Verify: In `pnpm dev`, open it side by side with BookOrbit; it looks like the same product.
  - Files: `src/client/{App.vue,router.ts,style.css}`, `src/client/components/ui/*`, `src/client/pages/*`
  - Deps: T2 · Size: M (mostly copying)

### Checkpoint 2
- [x] `pnpm test` and `pnpm build` are green
- [x] Review the UI shell with you

## Phase 3: Core slices

- [x] **T6: Search → add → full download**
  - Acceptance: The Search page picks a source and a query, shows covers, and has an Add button. `POST /api/series` queues a download job. `worker.ts` runs jobs one at a time (on startup, `running` jobs are reset to `queued` so an interrupted job resumes), records chapters, and writes `/books/manhwa/<Title>.cbz`. The Library page shows the cover grid.
  - Verify: `pnpm test` covers worker job flow with a stubbed client. Manually add a short series against the real Suwayomi, and it appears in BookOrbit.
  - Files: `src/server/{api,worker}.ts`, `src/client/pages/{Search,Library}.vue`, `test/worker.test.ts`
  - Deps: T3, T4, T5 · Size: M

- [x] **T7: Daily check + append**
  - Acceptance: An hourly tick queues `check` for series where `last_checked_at` is more than `CHECK_INTERVAL_HOURS` ago. A check compares chapters by number, and a non-empty diff queues a download that appends. The Series page shows chapters and a "Check now" button.
  - Verify: Unit tests for `missingChapters` and the tick selection. Manually: delete the last chapter row in the DB, click Check now, and the chapter is re-appended.
  - Files: `src/server/{worker,api}.ts`, `src/client/pages/Series.vue`, `test/worker.test.ts`
  - Deps: T6 · Size: M

- [x] **T8: Failures + Gotify + Activity**
  - Acceptance: The series becomes `failing` when a check throws or 0 chapters come back where there were some before. Gotify is notified only on the ok→failing transition. The status goes back to ok on the next success. The Activity page lists jobs, with failed ones highlighted and their error shown.
  - Verify: Unit test the transition rule (a notification fires exactly once over 3 failing checks). Manually: point a series at a bogus manga ID and get one Gotify message.
  - Files: `src/server/{worker,notify}.ts`, `src/client/pages/Activity.vue`, `test/worker.test.ts`
  - Deps: T7 · Size: S

- [x] **T9: Switch source + Redownload all**
  - Acceptance: On the Series page, Switch source opens a search, prefilled with the title, across other sources. Picking one updates the series, and the next check downloads only chapters numbered above the current max. Redownload all rebuilds the CBZ from scratch, after a confirmation dialog.
  - Verify: Unit test the resume filter. Manually switch a series and confirm no duplicate chapter folders appear in the CBZ.
  - Files: `src/server/{api,worker}.ts`, `src/client/pages/Series.vue`, `test/worker.test.ts`
  - Deps: T8 · Size: M

### Checkpoint 3
- [ ] Spec Success Criteria 1, 2, 4 and 5 pass against the real Suwayomi and BookOrbit
- [ ] Review with you

## Phase 4: Ship

- [x] **T10: Dockerfile + GHCR workflow**
  - Acceptance: A multi-stage image (vite build, then `node:24-slim`) that runs as uid 100000 and works with a read-only root filesystem (temp files on `/data` or emptyDir). The GH Action builds and pushes `ghcr.io/<you>/mangarr` on tags and main.
  - Verify: `docker build . && docker run --read-only -u 100000 ...` serves `/api/health`. The workflow run is green.
  - Files: `Dockerfile`, `.dockerignore`, `.github/workflows/image.yaml`
  - Deps: T9 · Size: S

- [x] **T11: Deploy Mangarr to home-ops**
  - Acceptance: `kubernetes/apps/media/mangarr/` set up as in the spec: config PVC with volsync, the `media` PVC at `/books` with subPath books, `LIBRARY_DIR=/books/manhwa`, `SUWAYOMI_URL` in-cluster, `GOTIFY_URL` + `GOTIFY_TOKEN` from ExternalSecret (1Password item `kubernetes/mangarr`, fields GOTIFY_URL / GOTIFY_TOKEN), a route on envoy-external, and the HTTPRoute added to `forward-auth.yaml`. The image is pinned by digest.
  - Verify: `flux get ks mangarr` is Ready. Opening the hostname goes through Authentik. Add a series, and it shows up in BookOrbit. Success Criterion 3: kill the pod mid-download, the old CBZ is intact, and the job resumes.
  - Files: `mangarr/ks.yaml`, `mangarr/app/{helmrelease,externalsecret,kustomization}.yaml`, `media/kustomization.yaml`, `media/forward-auth.yaml`
  - Deps: T10 · Size: S

### Phase 5: Volumes (v0.2)

- [x] **T12: Volume CBZs**
  - Acceptance: schema gets `series.dir`, `series.volume_size` (default 25), `chapters.volume`. Downloads assign chapters to volumes and write `<dir>/<Title> Vol. NN.cbz` with ComicInfo `Series`/`Number`/`Title`. Only volumes that got new chapters (or dropped removed ones) are rewritten. Rebuild writes all volumes fresh.
  - Verify: worker + cbz tests (assignment incl. auto-start at size, append to last volume, removed chapters), `pnpm test`, manual add of a 30-chapter series → Vol. 01 (25) + Vol. 02 (5).
  - Files: `db.ts`, `worker.ts`, `cbz.ts`, tests · Size: M

- [ ] **T13: Restructure + migration**
  - Acceptance: `writeCbz` can take entries from several source CBZs. A `restructure` job rewrites volumes whose chapter set changed, streaming from the old files, then deletes obsolete files. On start, single-file series are migrated (old file deleted only after all volumes exist). API: `PUT /series/:id/volumes` (`{ starts: number[] }` or `{ size }` + re-split), validated; path change moves the folder.
  - Verify: tests for split/merge/migrate (original intact on failure, no entry lost or duplicated), `pnpm test`; manual: migrate a dev copy of VS, then TBATE in the cluster.
  - Files: `cbz.ts`, `worker.ts`, `api.ts`, `main.ts`, tests · Size: M

- [ ] **T14: Volume UI**
  - Acceptance: series page groups chapters by volume (header: volume, chapter range, page count), per-row "Start volume here", per-volume "Merge into previous", volume size input + "Re-split", library card shows volume count.
  - Verify: `pnpm typecheck`, `pnpm build`, manual check in the browser.
  - Files: `pages/Series.vue`, `lib/api.ts`, `pages/Library.vue` · Size: S

### Checkpoint: Complete
- [ ] All 7 spec Success Criteria met
