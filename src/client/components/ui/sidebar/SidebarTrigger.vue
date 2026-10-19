<script setup lang="ts">
import { computed, type HTMLAttributes } from 'vue'
import { PanelLeft } from '@lucide/vue'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSidebar } from './utils'

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()

const { isMobile, openMobile, state, toggleSidebar } = useSidebar()

const actionLabel = computed(() => {
  if (isMobile.value) {
    return openMobile.value ? 'Close sidebar' : 'Open sidebar'
  }
  return state.value === 'expanded' ? 'Collapse sidebar' : 'Expand sidebar'
})
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <Button
        data-sidebar="trigger"
        data-slot="sidebar-trigger"
        variant="ghost"
        size="icon"
        :class="cn('h-7 w-7', props.class)"
        :aria-label="actionLabel"
        @click="toggleSidebar"
      >
        <PanelLeft aria-hidden="true" />
      </Button>
    </TooltipTrigger>
    <TooltipContent>{{ actionLabel }}</TooltipContent>
  </Tooltip>
</template>
