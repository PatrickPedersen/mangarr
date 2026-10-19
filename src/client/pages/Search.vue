<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { Loader2, Plus, Search } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import CoverCard from '@/components/CoverCard.vue'
import { api, type MangaHit, type Source } from '@/lib/api'

const router = useRouter()
const sources = ref<Source[]>([])
const source = ref('')
const query = ref('')
const results = ref<MangaHit[] | null>(null)
const searching = ref(false)
const adding = ref<number | null>(null)

onMounted(async () => {
  try {
    sources.value = await api.get<Source[]>('/sources')
    let last: string | null = null
    try { last = localStorage.getItem('mangarr:source') } catch {}
    source.value = sources.value.find(s => s.id === last)?.id ?? sources.value[0]?.id ?? ''
  } catch (e) {
    toast.error(`Couldn't load sources: ${(e as Error).message}`)
  }
})
watch(source, s => { try { localStorage.setItem('mangarr:source', s) } catch {} })

async function search() {
  if (!source.value || !query.value.trim()) return
  searching.value = true
  try {
    results.value = await api.get<MangaHit[]>(`/search?source=${source.value}&q=${encodeURIComponent(query.value)}`)
  } catch (e) {
    toast.error(`Search failed: ${(e as Error).message}`)
  } finally {
    searching.value = false
  }
}

async function add(hit: MangaHit) {
  adding.value = hit.id
  try {
    await api.post('/series', { mangaId: hit.id })
    toast.success(`Added ${hit.title}. Downloading now.`)
    router.push('/')
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    adding.value = null
  }
}
</script>

<template>
  <section class="space-y-5">
    <h1 class="font-serif text-2xl font-semibold">Add series</h1>
    <form class="flex flex-col gap-2 sm:flex-row" @submit.prevent="search">
      <select
        v-model="source"
        aria-label="Source"
        class="border-input dark:bg-input/30 h-9 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:w-56"
      >
        <option v-for="s in sources" :key="s.id" :value="s.id">{{ s.displayName }}</option>
      </select>
      <Input v-model="query" placeholder="Search titles…" aria-label="Title" class="flex-1" />
      <Button type="submit" :disabled="searching || !query.trim()">
        <Loader2 v-if="searching" class="animate-spin" /><Search v-else /> Search
      </Button>
    </form>

    <p v-if="results && !results.length" class="text-muted-foreground">No results on this source.</p>
    <div v-if="results?.length" class="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-4">
      <CoverCard v-for="hit in results" :key="hit.id" :manga-id="hit.id" :title="hit.title">
        <Button size="sm" class="w-full" :disabled="adding !== null" @click="add(hit)">
          <Loader2 v-if="adding === hit.id" class="animate-spin" /><Plus v-else /> Add
        </Button>
      </CoverCard>
    </div>
  </section>
</template>
