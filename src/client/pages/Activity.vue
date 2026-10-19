<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { AlertCircle, Check, Clock, Loader2 } from '@lucide/vue'
import { ago, api, fromDb, type ActivityJob } from '@/lib/api'

const jobs = ref<ActivityJob[] | null>(null)
const error = ref('')
const filter = ref<'all' | 'failed'>('all')
const shown = computed(() => (filter.value === 'failed' ? jobs.value?.filter(j => j.state === 'failed') : jobs.value) ?? [])

async function load() {
  try {
    jobs.value = await api.get<ActivityJob[]>('/jobs')
    error.value = ''
  } catch (e) {
    error.value = (e as Error).message
  }
}

let timer: ReturnType<typeof setInterval>
onMounted(() => {
  load()
  timer = setInterval(load, 5000)
})
onUnmounted(() => clearInterval(timer))

const icon = { queued: Clock, running: Loader2, done: Check, failed: AlertCircle }
const tone = {
  queued: 'text-muted-foreground',
  running: 'text-primary',
  done: 'text-success',
  failed: 'text-destructive',
}
</script>

<template>
  <section class="space-y-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="font-serif text-2xl font-semibold">Activity</h1>
      <div class="inline-flex rounded-md border border-border p-0.5 text-sm" role="group" aria-label="Filter">
        <button
          v-for="f in (['all', 'failed'] as const)"
          :key="f"
          type="button"
          class="rounded px-3 py-1 capitalize"
          :class="filter === f ? 'bg-(--sidebar-active-bg) text-primary' : 'text-muted-foreground hover:text-foreground'"
          :aria-pressed="filter === f"
          @click="filter = f"
        >
          {{ f }}
        </button>
      </div>
    </div>
    <p v-if="error" class="text-destructive">{{ error }}</p>

    <div class="overflow-hidden rounded-xl border border-border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">Status</th>
            <th class="px-4 py-2 font-medium">Series</th>
            <th class="px-4 py-2 font-medium max-sm:hidden">Job</th>
            <th class="px-4 py-2 font-medium">When</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="j in shown" :key="j.id" class="border-b border-border align-top last:border-0" :class="j.state === 'failed' && 'bg-destructive/5'">
            <td class="px-4 py-2 whitespace-nowrap">
              <span class="inline-flex items-center gap-1.5 capitalize" :class="tone[j.state]">
                <component :is="icon[j.state]" :size="14" :class="j.state === 'running' && 'animate-spin'" /> {{ j.state }}
              </span>
            </td>
            <td class="px-4 py-2 min-w-0">
              <RouterLink :to="`/series/${j.series_id}`" class="wrap-anywhere hover:text-primary">{{ j.title }}</RouterLink>
              <p v-if="j.error" :title="j.error" class="mt-0.5 line-clamp-3 wrap-anywhere text-xs text-destructive">{{ j.error }}</p>
            </td>
            <td class="px-4 py-2 capitalize text-muted-foreground max-sm:hidden">{{ j.kind }}</td>
            <td class="px-4 py-2 whitespace-nowrap text-muted-foreground" :title="fromDb(j.finished_at ?? j.created_at).toLocaleString()">
              {{ ago(j.finished_at ?? j.created_at) }}
            </td>
          </tr>
          <tr v-if="jobs && !shown.length">
            <td colspan="4" class="px-4 py-6 text-center text-muted-foreground">{{ filter === 'failed' ? 'No failures.' : 'Nothing has run yet.' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
