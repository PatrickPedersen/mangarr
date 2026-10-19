<script setup lang="ts">
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'
import AppSidebar from './AppSidebar.vue'
</script>

<!-- BookOrbit's AppLayout shell, minus its feature widgets. -->
<template>
  <SidebarProvider class="app-shell min-h-svh pattern-vinyl">
    <AppSidebar />
    <SidebarInset class="app-shell-inset flex flex-col h-svh overflow-hidden relative bg-transparent pb-(--shell-gap)">
      <div aria-hidden="true" class="shell-glow" />
      <div class="md:hidden flex items-center gap-2 px-3 pt-3">
        <SidebarTrigger />
        <span class="font-serif font-semibold">Mang<span class="text-primary">arr</span></span>
      </div>
      <div class="app-shell-scroll ps-(--shell-content-gutter) pe-(--shell-gap) pt-(--shell-gap) flex-1 overflow-y-auto overflow-x-hidden relative bg-transparent">
        <router-view v-slot="{ Component }">
          <Transition name="page" mode="out-in">
            <component :is="Component" :key="$route.path" />
          </Transition>
        </router-view>
      </div>
    </SidebarInset>
    <Toaster />
  </SidebarProvider>
</template>
