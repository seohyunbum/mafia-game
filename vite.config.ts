import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    // 링크 하나로 보낼 수 있게 전부 인라인한다 (scripts/bundle-single.mjs 가 마무리).
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
})
