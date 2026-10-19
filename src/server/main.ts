import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { openDb } from './db.ts'
import { api } from './api.ts'
import * as suwayomi from './suwayomi.ts'
import * as worker from './worker.ts'
import { notify } from './notify.ts'

const dataDir = process.env.DATA_DIR ?? './data'
const libraryDir = resolve(process.env.LIBRARY_DIR ?? './data/library')
const port = Number(process.env.PORT ?? 3000)
const checkIntervalHours = Number(process.env.CHECK_INTERVAL_HOURS ?? 24)
if (!(checkIntervalHours > 0)) throw new Error(`CHECK_INTERVAL_HOURS must be a positive number`)

mkdirSync(dataDir, { recursive: true })
mkdirSync(libraryDir, { recursive: true })
const db = openDb(join(dataDir, 'mangarr.db'))

const app = new Hono()
app.get('/api/health', c => c.json({ ok: true }))
app.route('/api', api(db, libraryDir))
app.use('/*', serveStatic({ root: './dist/public' }))
// SPA fallback: client-side routes like /series/3 load index.html.
app.get('*', serveStatic({ path: './dist/public/index.html' }))

serve({ fetch: app.fetch, port }, () => console.log(`mangarr listening on :${port}, library ${libraryDir}`))
worker.start({ db, sw: suwayomi, libraryDir, notify }, checkIntervalHours)
