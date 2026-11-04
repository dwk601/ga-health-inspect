import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import './styles.css'

void import('maplibre-gl').then(({ setWorkerUrl }) => setWorkerUrl(workerUrl)).then(() => import('./App')).then(({ default: App }) => {
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
})
