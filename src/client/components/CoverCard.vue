<script setup lang="ts">
import { ref } from 'vue'
import { ImageOff } from '@lucide/vue'

defineProps<{ mangaId: number; title: string; subtitle?: string }>()
const broken = ref(false)
</script>

<!-- BookOrbit's series-card chrome around a single 2:3 cover. -->
<template>
  <article class="group flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-[border-color,box-shadow] duration-150 hover:border-ring hover:shadow-lg">
    <div class="relative bg-linear-to-b from-surface-2 to-card px-2.5 pt-2.5">
      <div class="relative aspect-2/3 w-full overflow-hidden rounded-[3px] bg-surface-3">
        <img
          v-if="!broken"
          :src="`/api/cover/${mangaId}`"
          alt=""
          loading="lazy"
          decoding="async"
          class="h-full w-full object-cover"
          @error="broken = true"
        />
        <div v-else class="flex h-full items-center justify-center text-muted-foreground"><ImageOff :size="28" /></div>
        <slot name="overlay" />
      </div>
    </div>
    <div class="flex min-w-0 flex-1 flex-col gap-0.5 border-t border-border px-3 pb-2.5 pt-2.5 mt-2.5">
      <h3 :title="title" class="line-clamp-2 wrap-anywhere text-[14.5px] font-semibold leading-snug tracking-[-0.014em] text-foreground">{{ title }}</h3>
      <p v-if="subtitle" :title="subtitle" class="truncate text-[12.5px] text-muted-foreground">{{ subtitle }}</p>
      <div class="mt-auto pt-2"><slot /></div>
    </div>
  </article>
</template>
