<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import { ArrowRightLeft, Loader2, Search } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import CoverCard from '@/components/CoverCard.vue'
import { api, type MangaHit, type Source } from '@/lib/api'

const props = defineProps<{ seriesId: number; title: string; currentMangaId: number; currentSource: string }>()
const emit = defineEmits<{ switched: []; close: [] }>()

const sources = ref<Source[]>([])
const source = ref('')
const query = ref(props.title)
const results = ref<MangaHit[] | null>(null)
const searching = ref(false)
const switching = ref<number | null>(null)

onMounted(async () => {
  try {
    sources.value = await api.get<Source[]>('/sources')
    // Start on a different source than the current one; that's the point of switching.
    source.value = sources.value.find(s => s.displayName !== props.currentSource)?.id ?? sources.value[0]?.id ?? ''
    search()
  } catch (e) {
    toast.error(`Couldn't load sources: ${(e as Error).message}`)
  }
})

async function search() {
  if (!source.value || !query.value.trim()) return
  searching.value = true
  try {
    const hits = await api.get<MangaHit[]>(`/search?source=${source.value}&q=${encodeURIComponent(query.value)}`)
    results.value = hits.filter(h => h.id !== props.currentMangaId)
  } catch (e) {
    toast.error(`Search failed: ${(e as Error).message}`)
  } finally {
    searching.value = false
  }
}

async function use(hit: MangaHit) {
  switching.value = hit.id
  try {
    const res = await api.post<{ sourceName: string }>(`/series/${props.seriesId}/source`, { mangaId: hit.id })
    toast.success(`Switched to ${res.sourceName}. Checking for new chapters.`)
    emit('switched')
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    switching.value = null
  }
}
</script>

<template>
  <div class="space-y-4 rounded-xl border border-border bg-card p-4">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h2 class="font-semibold">Switch source</h2>
        <p class="text-sm text-muted-foreground">
          Chapters already in the CBZ stay. Only chapters numbered above the current latest come from the new source.
        </p>
      </div>
      <Button size="sm" variant="ghost" @click="emit('close')">Close</Button>
    </div>
    <form class="flex flex-col gap-2 sm:flex-row" @submit.prevent="search">
      <select
        v-model="source"
        aria-label="Source"
        class="border-input dark:bg-input/30 h-9 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:w-56"
        @change="search"
      >
        <option v-for="s in sources" :key="s.id" :value="s.id">{{ s.displayName }}{{ s.displayName === currentSource ? ' (current)' : '' }}</option>
      </select>
      <Input v-model="query" aria-label="Title" class="flex-1" />
      <Button type="submit" :disabled="searching || !query.trim()"><Loader2 v-if="searching" class="animate-spin" /><Search v-else /> Search</Button>
    </form>
    <p v-if="results && !results.length" class="text-sm text-muted-foreground">No results on this source.</p>
    <div v-if="results?.length" class="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
      <CoverCard v-for="hit in results" :key="hit.id" :manga-id="hit.id" :title="hit.title">
        <Button size="sm" class="w-full" :disabled="switching !== null" @click="use(hit)">
          <Loader2 v-if="switching === hit.id" class="animate-spin" /><ArrowRightLeft v-else /> Use this
        </Button>
      </CoverCard>
    </div>
  </div>
</template>
