import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * Dev-server-only demo: when LOCAL_DEMO_XLSX points at a workbook on this machine,
 * it is served at /__local-demo.xlsx so `?demo=local` can auto-load it. The file is
 * never copied into the repo, public assets, or production builds.
 */
function localDemo(): Plugin {
  const file = process.env.LOCAL_DEMO_XLSX
  return {
    name: 'local-demo-workbook',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__local-demo.xlsx', async (_req, res) => {
        if (!file) {
          res.statusCode = 404
          res.end('LOCAL_DEMO_XLSX is not set')
          return
        }
        try {
          const body = await readFile(file)
          res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
          res.setHeader('X-Filename', encodeURIComponent(basename(file)))
          res.setHeader('Cache-Control', 'no-store')
          res.end(body)
        } catch {
          res.statusCode = 404
          res.end('Demo workbook not found')
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), localDemo()],
  build: {
    // SheetJS + Recharts make a ~1 MB (≈300 KB gzip) single bundle; acceptable for a local tool.
    chunkSizeWarningLimit: 1200,
  },
})
