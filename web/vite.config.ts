import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { copyFileSync, createReadStream, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const workerFiles = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']
const workerSource = (name: string) => fileURLToPath(new URL(`./node_modules/maplibre-gl/dist/${name}`, import.meta.url))
const mapWorker = {
  name: 'maplibre-worker',
  configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use((req, res, next) => {
      const name = req.url?.slice(1).split('?')[0]
      if (!name || !workerFiles.includes(name)) return next()
      res.setHeader('Content-Type', 'text/javascript')
      createReadStream(workerSource(name)).pipe(res)
    })
  },
  writeBundle(options: { dir?: string }) {
    const dir = resolve(options.dir || 'dist')
    mkdirSync(dir, { recursive: true })
    for (const name of workerFiles) copyFileSync(workerSource(name), resolve(dir, name))
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss(), mapWorker],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { proxy: { '/api': 'http://127.0.0.1:8090' } },
})
