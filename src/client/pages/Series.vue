<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { toast } from 'vue-sonner'
import { AlertCircle, AlertTriangle, ArrowLeft, ArrowRightLeft, Download, ImageOff, Layers, Loader2, Pencil, RefreshCw, Trash2, Undo2 } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import SourceSwitcher from '@/components/SourceSwitcher.vue'
import VolumeEditor from '@/components/VolumeEditor.vue'
import { firstChapter, lastChapter } from '../../server/chapterOrder'
import { ago, api, fromDb, type Chapter, type SeriesDetail } from '@/lib/api'

const route = useRoute()
const series = ref<SeriesDetail | null>(null)
const error = ref('')
const coverBroken = ref(false)
const activeJob = computed(() => series.value?.jobs.find(j => j.state === 'queued' || j.state === 'running'))

async function load() {
  try {
    series.value = await api.get<SeriesDetail>(`/series/${route.params.id}`)
    error.value = ''
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function checkNow() {
  try {
    await api.post(`/series/${route.params.id}/check`, {})
    toast.success('Check queued')
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  }
}

const editingPath = ref<string | null>(null)
const savingPath = ref(false)
async function savePath() {
  if (editingPath.value === null) return
  savingPath.value = true
  try {
    const res = await api.patch<{ dir: string; moved?: boolean }>(`/series/${route.params.id}`, { dir: editingPath.value })
    toast.success(res.moved ? 'Folder moved' : 'Path updated')
    editingPath.value = null
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    savingPath.value = false
  }
}

const switching = ref(false)
async function onSwitched() {
  switching.value = false
  coverBroken.value = false
  await load()
}

const confirmRebuild = ref(false)
const rebuilding = ref(false)
async function rebuild() {
  rebuilding.value = true
  try {
    await api.post(`/series/${route.params.id}/rebuild`, {})
    toast.success('Redownload queued')
    confirmRebuild.value = false
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    rebuilding.value = false
  }
}

const removing = ref<number | null>(null)
const removeBusy = ref(false)
async function removeChapter() {
  if (removing.value === null) return
  removeBusy.value = true
  try {
    await api.post(`/series/${route.params.id}/chapters/${removing.value}/remove`, {})
    toast.success(`Chapter ${removing.value} will be removed from its volume`)
    removing.value = null
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    removeBusy.value = false
  }
}
async function restoreChapter(number: number) {
  try {
    await api.post(`/series/${route.params.id}/chapters/${number}/restore`, {})
    toast.success(`Chapter ${number} will be downloaded again`)
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  }
}

// Newest volume first, like the chapters. Volume 0 = chapters not split into volumes yet (v0.1 series).
const volumes = computed(() => {
  const groups = new Map<number, Chapter[]>()
  for (const c of series.value?.chapters ?? []) {
    const v = c.volume ?? 0
    groups.set(v, [...(groups.get(v) ?? []), c])
  }
  return [...groups]
    .sort((a, b) => (a[0] === 0 ? 1 : b[0] === 0 ? -1 : b[0] - a[0]))
    .map(([volume, chapters]) => {
      const kept = chapters.filter(c => !c.removed)
      const numbers = kept.map(c => c.number)
      return {
        volume,
        chapters,
        first: numbers.length ? firstChapter(numbers) : NaN,
        last: numbers.length ? lastChapter(numbers) : NaN,
        count: kept.length,
        pages: kept.reduce((n, c) => n + (c.pages ?? 0), 0),
      }
    })
})
const starts = computed(() => volumes.value.filter(g => g.volume > 0 && g.count).map(g => g.first))
const pending = computed(() => activeJob.value?.kind === 'restructure' || volumes.value.some(g => g.volume === 0 && g.count))

const editingVolumes = ref(false)
const savingVolumes = ref(false)
async function saveVolumes(next: number[], size: number) {
  savingVolumes.value = true
  try {
    if (size !== series.value!.volume_size) await api.put(`/series/${route.params.id}/volumes`, { size })
    if (next.join() !== starts.value.slice(1).join()) await api.put(`/series/${route.params.id}/volumes`, { starts: next })
    toast.success('Volumes saved; changed volumes are being rewritten')
    editingVolumes.value = false
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    savingVolumes.value = false
  }
}
const chRange = (g: { first: number; last: number }) => (g.first === g.last ? `Ch. ${g.first}` : `Ch. ${g.first}–${g.last}`)

let timer: ReturnType<typeof setInterval>
onMounted(() => {
  load()
  timer = setInterval(() => activeJob.value && load(), 3000)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <section class="space-y-6">
    <RouterLink to="/" class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft :size="15" /> Library</RouterLink>
    <p v-if="error" class="text-destructive">{{ error }}</p>

    <template v-if="series">
      <div class="flex flex-col gap-5 sm:flex-row">
        <div class="w-40 shrink-0 self-start overflow-hidden rounded-[3px] bg-surface-3 shadow-lg">
          <img v-if="!coverBroken" :src="`/api/cover/${series.suwayomi_manga_id}`" alt="" class="aspect-2/3 w-full object-cover" @error="coverBroken = true" />
          <div v-else class="flex aspect-2/3 items-center justify-center text-muted-foreground"><ImageOff :size="28" /></div>
        </div>
        <div class="min-w-0 flex-1 space-y-3">
          <h1 class="wrap-anywhere font-serif text-2xl font-semibold">{{ series.title }}</h1>
          <div class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="secondary">{{ series.source_name }}</Badge>
            <Badge v-if="series.status === 'failing'" variant="destructive">Failing</Badge>
            <span>{{ series.chapters.length }} chapters</span>
            <span>·</span>
            <span :title="series.last_checked_at ? fromDb(series.last_checked_at).toLocaleString() : undefined">checked {{ ago(series.last_checked_at) }}</span>
          </div>
          <form v-if="editingPath !== null" class="flex max-w-2xl flex-col gap-2 sm:flex-row" @submit.prevent="savePath">
            <Input v-model="editingPath" aria-label="Series folder" class="flex-1 font-mono text-xs" autofocus @keydown.esc="editingPath = null" />
            <div class="flex gap-2">
              <Button type="submit" size="sm" :disabled="savingPath"><Loader2 v-if="savingPath" class="animate-spin" />Save</Button>
              <Button type="button" size="sm" variant="ghost" @click="editingPath = null">Cancel</Button>
            </div>
          </form>
          <div v-else class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span class="wrap-anywhere font-mono" :title="series.dir">{{ series.dir }}</span>
            <button
              type="button"
              class="shrink-0 rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
              title="Change path. If the folder is already there, Mangarr uses it; otherwise it moves the series folder."
              aria-label="Change series folder"
              :disabled="!!activeJob"
              @click="editingPath = series.dir"
            >
              <Pencil :size="13" />
            </button>
          </div>
          <div v-if="series.last_error" class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle :size="16" class="mt-0.5 shrink-0" /> <span class="wrap-anywhere">{{ series.last_error }}</span>
          </div>
          <div class="flex flex-wrap gap-2">
            <Button size="sm" :disabled="!!activeJob" @click="checkNow">
              <Loader2 v-if="activeJob" class="animate-spin" /><RefreshCw v-else />
              {{ activeJob ? (activeJob.state === 'queued' ? 'Queued…' : activeJob.kind === 'restructure' ? 'Rewriting volumes…' : 'Downloading…') : 'Check now' }}
            </Button>
            <Button size="sm" variant="outline" :disabled="!!activeJob || switching" @click="switching = true"><ArrowRightLeft /> Switch source</Button>
            <Button size="sm" variant="outline" :disabled="!!activeJob" @click="confirmRebuild = true"><Download /> Redownload all</Button>
          </div>
        </div>
      </div>

      <SourceSwitcher
        v-if="switching"
        :series-id="series.id"
        :title="series.title"
        :current-manga-id="series.suwayomi_manga_id"
        :current-source="series.source_name"
        @switched="onSwitched"
        @close="switching = false"
      />

      <ConfirmDialog
        :open="confirmRebuild"
        title="Redownload all chapters?"
        :description="`Every chapter is downloaded again from ${series.source_name} and every volume is rebuilt from scratch, re-split by volume size. The current files stay in place until their replacements are complete. For a long series this can take a while.`"
        confirm-label="Redownload"
        :busy="rebuilding"
        :destructive="false"
        @confirm="rebuild"
        @cancel="confirmRebuild = false"
      />

      <ConfirmDialog
        :open="removing !== null"
        :title="`Remove chapter ${removing}?`"
        description="It's taken out of its volume and won't be downloaded again, not even by Redownload all, until you restore it."
        confirm-label="Remove"
        :busy="removeBusy"
        @confirm="removeChapter"
        @cancel="removing = null"
      />

      <VolumeEditor
        v-if="editingVolumes"
        :chapters="series.chapters"
        :volume-size="series.volume_size"
        :busy="savingVolumes"
        @save="saveVolumes"
        @cancel="editingVolumes = false"
      />
      <div v-else class="flex flex-wrap items-center gap-2 text-sm">
        <Button size="sm" variant="outline" :disabled="!!activeJob || pending || !series.chapters.some(c => !c.removed)" @click="editingVolumes = true">
          <Layers /> Edit volumes
        </Button>
        <span v-if="pending" class="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 :size="13" class="animate-spin" /> Volume files are being updated</span>
      </div>

      <div class="overflow-hidden rounded-xl border border-border bg-card">
        <table class="w-full text-sm">
          <thead class="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th class="px-4 py-2 font-medium">#</th><th class="px-4 py-2 font-medium">Title</th><th class="px-4 py-2 font-medium">Downloaded</th>
              <th class="w-0 px-2 py-2"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody v-for="g in volumes" :key="g.volume">
            <tr class="border-b border-border bg-surface-2/60">
              <th colspan="3" scope="rowgroup" class="px-4 py-2 text-left font-medium">
                <template v-if="g.volume">
                  Vol. {{ g.volume }}
                  <span v-if="g.count" class="ms-2 text-xs font-normal text-muted-foreground">
                    {{ chRange(g) }} · {{ g.count }} chapters<template v-if="g.pages"> · {{ g.pages.toLocaleString() }} pages</template>
                  </span>
                </template>
                <template v-else>Not split into volumes yet</template>
              </th>
              <td></td>
            </tr>
            <tr
              v-for="c in g.chapters"
              :key="c.number"
              class="border-b border-border last:border-0"
              :class="c.removed ? 'text-muted-foreground' : c.warning ? 'bg-warning/10' : ''"
            >
              <td class="px-4 py-2 tabular-nums" :class="{ 'line-through': c.removed }">{{ c.number }}</td>
              <td class="px-4 py-2">
                <span class="wrap-anywhere" :class="{ 'line-through': c.removed }">{{ c.title }}</span>
                <span v-if="c.removed" class="ms-2 text-xs">removed</span>
                <p v-else-if="c.warning" class="mt-0.5 flex items-center gap-1 text-xs text-warning">
                  <AlertTriangle :size="12" class="shrink-0" /> {{ c.warning }}
                </p>
              </td>
              <td class="px-4 py-2 whitespace-nowrap text-muted-foreground" :title="fromDb(c.downloaded_at).toLocaleString()">{{ ago(c.downloaded_at) }}</td>
              <td class="px-2 py-1.5 text-right whitespace-nowrap">
                <button
                  v-if="c.removed"
                  type="button"
                  class="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                  :title="`Restore chapter ${c.number} (downloads it again)`"
                  :aria-label="`Restore chapter ${c.number}`"
                  :disabled="!!activeJob"
                  @click="restoreChapter(c.number)"
                >
                  <Undo2 :size="15" />
                </button>
                <button
                  v-else
                  type="button"
                  class="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                  :title="`Remove chapter ${c.number} from its volume`"
                  :aria-label="`Remove chapter ${c.number}`"
                  :disabled="!!activeJob"
                  @click="removing = c.number"
                >
                  <Trash2 :size="15" />
                </button>
              </td>
            </tr>
          </tbody>
          <tbody v-if="!series.chapters.length">
            <tr><td colspan="4" class="px-4 py-6 text-center text-muted-foreground">No chapters downloaded yet.</td></tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>
