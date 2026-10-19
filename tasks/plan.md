# Implementation Plan: Mangarr

Spec: [../SPEC.md](../SPEC.md). Tasks: [todo.md](todo.md).

## Overview

We build risk-first. Before writing any code, we confirm the two outside dependencies hold up: BookOrbit has to accept a CBZ being swapped in place, and Suwayomi's API has to work for the sources we need. After that, we build the app in vertical slices: add a series → daily append → failure handling → switch source. The work ends with packaging and Flux deployment.

## Architecture Decisions

- **Suwayomi is deployed first (Task 1).** Every development task after it needs a real instance to record fixtures against. During development we reach it with `kubectl port-forward`.
- **There's one job worker and no concurrency.** Jobs run sequentially, which also stops two jobs from writing the same CBZ at once. That makes it a natural rate limit, and correctness matters more than speed here.
- **Each CBZ is rebuilt in full, never patched in place.** Every append reads the old zip and writes a new one to `.mangarr-tmp/`, then renames it over the old file. Pages are staged on disk and the CBZ is streamed (yazl/yauzl, zip64) once per job, at about 110 MB peak memory regardless of size. That's O(series size) I/O per append, which means multiple GB for long manhwa. If NFS time hurts, the upgrade is to append to a copy instead of rebuilding.
- **The UI starts by copying BookOrbit's shell** (layout, sidebar, design tokens, and the `components/ui` primitives). Feature pages then use those pieces as-is, so we don't invent a look.

## Dependency Graph

```
T0 BookOrbit swap test (manual) ─┐
T1 Suwayomi in cluster ──────────┼─> T3 suwayomi.ts ─┐
T2 scaffold + db ──> T4 cbz.ts ──┘                   ├─> T6 add-series slice ─> T7 daily check ─> T8 failures/notify ─> T9 switch/redownload
                     T5 UI shell ────────────────────┘                                                                  │
                                                                         T10 Dockerfile + GHA ─> T11 home-ops mangarr ─┘
```

## Phases

1. **De-risk:** T0, T1
2. **Foundation:** T2–T5
3. **Core slices:** T6–T9
4. **Ship:** T10, T11

Each phase ends with a checkpoint (see todo.md).

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| BookOrbit treats a replaced file as a new book, so progress is lost | High: breaks the single-CBZ design | T0 is a manual test done before any code. If it fails, we go back to the spec |
| Suwayomi's GraphQL schema doesn't match what we expect, or its version changes | Med | T3 records fixtures from the deployed version, and the Suwayomi image is pinned by digest |
| Scanlation sites block Suwayomi behind Cloudflare | Med | Use the existing FlareSolverr. Fallback per the intent doc: our own theme scrapers |
| `node:sqlite` is still experimental in Node 24 | Low | 3 tables of plain SQL, so moving to `better-sqlite3` is a swap of one file |
| Chapter numbers differ between sources | Med for source switching | Resume uses `> max(number)`, and Redownload all is the manual escape hatch |

## Open Questions

None. All spec questions are resolved apart from T0, which is a test, not a question.
