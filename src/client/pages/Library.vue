<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { AlertCircle, Loader2, Plus } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import CoverCard from '@/components/CoverCard.vue'
import { api, type Series } from '@/lib/api'

const series = ref<Series[] | null>(null)
const error = ref('')
const busy = computed(() => series.value?.some(s => s.job_state === 'queued' || s.job_state === 'running'))

async function load() {
  try {
    series.value = await api.get<Series[]>('/series')
    error.value = ''
  } catch (e) {
    error.value = (e as Error).message
  }
}

// Poll only while something is downloading, so progress shows up without a refresh.
let timer: ReturnType<typeof setInterval>
onMounted(() => {
  load()
  timer = setInterval(() => busy.value && load(), 3000)
})
onUnmounted(() => clearInterval(timer))

const subtitle = (s: Series) =>
  s.chapter_count ? `${s.volume_count > 1 ? `${s.volume_count} vols · ` : ''}${s.chapter_count} ch · ${s.source_name}` : s.source_name
</script>

<template>
  <section class="space-y-5">
    <div class="flex items-center justify-between gap-3">
      <h1 class="font-serif text-2xl font-semibold">Library</h1>
      <Button as-child size="sm"><RouterLink to="/search"><Plus /> Add series</RouterLink></Button>
    </div>
    <p v-if="error" class="text-destructive">{{ error }}</p>
    <div v-else-if="series && !series.length" class="rounded-xl border border-dashed border-border p-10 text-center text-muted-foreground">
      Nothing tracked yet. <RouterLink to="/search" class="text-primary underline-offset-4 hover:underline">Add your first series</RouterLink>.
    </div>
    <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-4">
      <RouterLink v-for="s in series" :key="s.id" :to="`/series/${s.id}`" class="min-w-0 rounded-xl focus-visible:outline-2 focus-visible:outline-ring">
        <CoverCard :manga-id="s.suwayomi_manga_id" :title="s.title" :subtitle="subtitle(s)" class="h-full">
          <template #overlay>
            <span
              v-if="s.job_state === 'queued' || s.job_state === 'running'"
              class="absolute right-1 top-1 inline-flex h-[21px] items-center gap-1 rounded-md border border-border bg-background/85 px-1.5 text-[11.5px] font-semibold text-foreground backdrop-blur-sm"
            >
              <Loader2 :size="11" class="animate-spin" /> {{ s.job_state === 'running' ? 'Downloading' : 'Queued' }}
            </span>
            <span
              v-else-if="s.status === 'failing' || s.job_state === 'failed'"
              :title="s.last_error ?? undefined"
              class="absolute right-1 top-1 inline-flex h-[21px] items-center gap-1 rounded-md bg-destructive/90 px-1.5 text-[11.5px] font-semibold text-white"
            >
              <AlertCircle :size="11" /> Failing
            </span>
          </template>
        </CoverCard>
      </RouterLink>
    </div>
  </section>
</template>
