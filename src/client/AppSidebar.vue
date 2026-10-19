<script setup lang="ts">
import { useRoute } from 'vue-router'
import { Activity, BookOpen, Search } from '@lucide/vue'
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarMenu,
  SidebarMenuButton, SidebarMenuItem, SidebarTrigger, useSidebar,
} from '@/components/ui/sidebar'

const route = useRoute()
const { isMobile } = useSidebar()

const nav = [
  { to: '/', label: 'Library', icon: BookOpen },
  { to: '/search', label: 'Add series', icon: Search },
  { to: '/activity', label: 'Activity', icon: Activity },
]
const isActive = (to: string) => (to === '/' ? route.path === '/' || route.path.startsWith('/series') : route.path.startsWith(to))

// Same row styling as BookOrbit's SidebarNavItem: 28px row, accent bar + tint when active.
const buttonClass = [
  'group/item h-7 w-full min-w-0 gap-2 rounded-md px-2 font-normal',
  'before:absolute before:left-0 before:top-1/2 before:h-4 before:w-[2px] before:-translate-y-1/2 before:rounded-full before:bg-primary',
  'before:opacity-0 before:transition-opacity before:duration-150',
  'data-[active=true]:bg-(--sidebar-active-bg) data-[active=true]:[font-weight:var(--sidebar-active-weight)] data-[active=true]:before:opacity-100',
].join(' ')
</script>

<template>
  <Sidebar variant="floating" collapsible="icon">
    <SidebarHeader class="border-b border-sidebar-border px-4 py-2.5 group-data-[collapsible=icon]:px-2">
      <div class="flex min-w-0 items-center gap-1.5 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-1.5">
        <RouterLink
          to="/"
          class="flex h-9 min-w-0 flex-1 items-center gap-3 rounded-(--shell-radius) outline-hidden group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          aria-label="Library"
        >
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-(--shell-radius) bg-primary ring-1 ring-(--shell-accent-line)" aria-hidden="true">
            <BookOpen :size="20" class="text-primary-foreground" />
          </div>
          <span class="truncate font-serif text-[18px] font-semibold leading-none text-sidebar-foreground group-data-[collapsible=icon]:hidden">
            Mang<span class="text-primary">arr</span>
          </span>
        </RouterLink>
        <SidebarTrigger
          v-if="!isMobile"
          class="-me-1.5 size-7 shrink-0 rounded-md text-sidebar-foreground hover:bg-(--shell-accent-wash) group-data-[collapsible=icon]:me-0"
        />
      </div>
    </SidebarHeader>
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem v-for="item in nav" :key="item.to">
              <SidebarMenuButton as-child :is-active="isActive(item.to)" :tooltip="item.label" :class="buttonClass">
                <RouterLink :to="item.to">
                  <span class="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                    <component :is="item.icon" :size="17" class="text-sidebar-foreground transition-colors duration-150 group-data-[active=true]/item:text-primary" />
                  </span>
                  <span class="min-w-0 flex-1 truncate text-[14px] text-sidebar-foreground transition-colors duration-150 group-data-[active=true]/item:text-primary group-data-[collapsible=icon]:hidden">
                    {{ item.label }}
                  </span>
                </RouterLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  </Sidebar>
</template>
