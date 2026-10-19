# Mangarr — Statement of Intent

Confirmed 2026-10-19.

- **Outcome:** Mangarr — self-hosted Sonarr-style tracker+downloader for manhwa/manga that maintains **one CBZ per series**, growing over time.
- **User:** Patrick, running it in his k8s cluster. Auth handled by ingress.
- **Flow:** Search sources → add series → full download into one CBZ → daily check → append new chapters → BookOrbit picks it up automatically from a shared volume.
- **Sources:** Scanlation sites primarily, plus MangaDex, via a headless Suwayomi instance. Fallback: own scrapers, one per site theme (Madara, MangaThemesia, …).
- **Per series:** One active source. Failed check/download → notification (Gotify) → manual source switch. Switch resumes from highest chapter in the CBZ; full redownload as a manual option.
- **UI:** BookOrbit look & feel — library grid, search/add, series page (chapters, switch source, check now), activity/failures view.
- **Success:** Add a series once, new chapters appear in BookOrbit; only intervene when a source dies.
- **Out of scope:** In-app reader, user accounts, auto-switching/merging sources, per-chapter/per-volume CBZs, BookOrbit code integration.
- **Risk to test first:** Does BookOrbit keep reading progress when a CBZ is rewritten with appended chapters?
