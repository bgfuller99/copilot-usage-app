import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // SheetJS + Recharts make a ~1 MB (≈300 KB gzip) single bundle; acceptable for a local tool.
    chunkSizeWarningLimit: 1200,
  },
})
