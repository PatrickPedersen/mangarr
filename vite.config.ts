/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: 'src/client',
  plugins: [vue(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src/client', import.meta.url)) } },
  build: { outDir: '../../dist/public', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:3000' } },
  test: { root: '.', include: ['test/**/*.test.ts'] },
})
