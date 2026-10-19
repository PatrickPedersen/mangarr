import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./pages/Library.vue') },
    { path: '/search', component: () => import('./pages/Search.vue') },
    { path: '/series/:id', component: () => import('./pages/Series.vue') },
    { path: '/activity', component: () => import('./pages/Activity.vue') },
  ],
})
