<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDown, ChevronUp, Loader2, Scissors, SplitSquareVertical, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Chapter } from '@/lib/api'

const props = defineProps<{ chapters: Chapter[]; volumeSize: number; busy: boolean }>()
const emit = defineEmits<{ save: [starts: number[], size: number]; cancel: [] }>()

// Downloaded chapters in reading order; the draft is the index where each volume starts (first is always 0).
const list = computed(() => props.chapters.filter(c => !c.removed).sort((a, b) => a.number - b.number))
const initial = () => list.value.flatMap((c, i) => (i === 0 || c.volume !== list.value[i - 1]!.volume ? [i] : []))
const draft = ref(initial())
const size = ref(props.volumeSize)

const volumes = computed(() =>
  draft.value.map((from, j) => {
    const to = (draft.value[j + 1] ?? list.value.length) - 1
    const chapters = list.value.slice(from, to + 1)
    return { from, to, first: chapters[0]!.number, last: chapters.at(-1)!.number, count: chapters.length, pages: chapters.reduce((n, c) => n + (c.pages ?? 0), 0) }
  }),
)
const changed = computed(() => draft.value.join() !== initial().join() || size.value !== props.volumeSize)
const sizeValid = computed(() => Number.isInteger(size.value) && size.value >= 1 && size.value <= 1000)

// Boundary j sits between volume j-1 and volume j; it can move as long as neither volume ends up empty.
const setStart = (j: number, i: number) => {
  if (i > draft.value[j - 1]! && i < (draft.value[j + 1] ?? list.value.length)) draft.value[j] = i
}
const remove = (j: number) => draft.value.splice(j === 0 ? 1 : j, 1)
const split = (j: number) => {
  const v = volumes.value[j]!
  draft.value.splice(j + 1, 0, v.from + Math.ceil(v.count / 2))
}
const splitBySize = () => (draft.value = list.value.flatMap((_, i) => (i % size.value === 0 ? [i] : [])))
const range = (v: { first: number; last: number }) => (v.first === v.last ? `Ch. ${v.first}` : `Ch. ${v.first}–${v.last}`)
const save = () => emit('save', draft.value.slice(1).map(i => list.value[i]!.number), size.value)
</script>

<template>
  <div class="space-y-4 rounded-xl border border-border bg-card p-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="font-medium">Edit volumes</h2>
      <div class="flex gap-2">
        <Button size="sm" variant="ghost" :disabled="busy" @click="emit('cancel')">Cancel</Button>
        <Button size="sm" :disabled="!changed || !sizeValid || busy" @click="save"><Loader2 v-if="busy" class="animate-spin" />Save</Button>
      </div>
    </div>

    <form class="flex flex-wrap items-center gap-2 text-sm" @submit.prevent="splitBySize">
      <label for="volume-size" class="text-muted-foreground">Chapters per volume</label>
      <Input id="volume-size" v-model.number="size" type="number" min="1" max="1000" class="h-8 w-20 tabular-nums" />
      <Button type="submit" size="sm" variant="outline" :disabled="!sizeValid"><Scissors /> Split all by size</Button>
      <span class="text-xs text-muted-foreground">New chapters also fill volumes up to this size.</span>
    </form>

    <ol class="overflow-hidden rounded-lg border border-border">
      <template v-for="(v, j) in volumes" :key="j">
        <li v-if="j > 0" class="flex flex-wrap items-center gap-2 border-y border-dashed border-border bg-surface-2/60 px-3 py-1.5 text-xs text-muted-foreground">
          <button
            type="button"
            class="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-40"
            :disabled="volumes[j - 1]!.count < 2"
            :title="`Move ch. ${volumes[j - 1]!.last} into Vol. ${j + 1}`"
            :aria-label="`Move chapter ${volumes[j - 1]!.last} into volume ${j + 1}`"
            @click="setStart(j, v.from - 1)"
          >
            <ChevronUp :size="15" />
          </button>
          <label class="flex items-center gap-1.5">
            Vol. {{ j + 1 }} starts at
            <select
              class="rounded border border-input bg-background px-1.5 py-0.5 text-foreground tabular-nums"
              :value="v.from"
              @change="setStart(j, Number(($event.target as HTMLSelectElement).value))"
            >
              <option v-for="i in volumes[j - 1]!.count + v.count - 1" :key="i" :value="volumes[j - 1]!.from + i">
                Ch. {{ list[volumes[j - 1]!.from + i]!.number }}
              </option>
            </select>
          </label>
          <button
            type="button"
            class="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-40"
            :disabled="v.count < 2"
            :title="`Move ch. ${v.first} into Vol. ${j}`"
            :aria-label="`Move chapter ${v.first} into volume ${j}`"
            @click="setStart(j, v.from + 1)"
          >
            <ChevronDown :size="15" />
          </button>
        </li>
        <li class="flex items-center gap-3 px-3 py-2.5 text-sm">
          <span class="w-14 shrink-0 font-medium">Vol. {{ j + 1 }}</span>
          <span class="min-w-0 flex-1 tabular-nums">
            {{ range(v) }}
            <span class="ms-1.5 text-xs text-muted-foreground">{{ v.count }} ch<template v-if="v.pages"> · {{ v.pages.toLocaleString() }} p</template></span>
          </span>
          <button
            type="button"
            class="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
            :disabled="v.count < 2"
            :title="`Split Vol. ${j + 1} in two`"
            :aria-label="`Split volume ${j + 1} in two`"
            @click="split(j)"
          >
            <SplitSquareVertical :size="15" />
          </button>
          <button
            type="button"
            class="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
            :disabled="volumes.length < 2"
            :title="j === 0 ? 'Remove Vol. 1 (its chapters join Vol. 2)' : `Remove Vol. ${j + 1} (its chapters join Vol. ${j})`"
            :aria-label="`Remove volume ${j + 1}`"
            @click="remove(j)"
          >
            <X :size="15" />
          </button>
        </li>
      </template>
    </ol>
    <p class="text-xs text-muted-foreground">
      Saving rewrites only the volumes that changed, from pages already downloaded. Your place in a changed book shifts in BookOrbit.
    </p>
  </div>
</template>
