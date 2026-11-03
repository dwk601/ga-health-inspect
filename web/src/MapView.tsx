import { useMemo } from 'react'
import * as maplibre from 'maplibre-gl'
import { Map, MapClusterLayer, MapControls, MapPopup } from '@/components/ui/map'
import type { Point } from './types'

// A same-origin blob module can import the registry's pinned remote worker under
// worker-src blob:; a cross-origin Worker URL itself is blocked by browsers.
const workerUrl = `https://unpkg.com/maplibre-gl@${maplibre.getVersion()}/dist/maplibre-gl-worker.mjs`
maplibre.setWorkerUrl(URL.createObjectURL(new Blob([`import ${JSON.stringify(workerUrl)};`], { type: 'text/javascript' })))

const key = import.meta.env.VITE_CARTO_KEY as string | undefined
function transformRequest(url: string) {
  if (key) {
    const parsed = new URL(url, window.location.href)
    if (parsed.hostname === 'basemaps.cartocdn.com' || parsed.hostname.endsWith('.basemaps.cartocdn.com')) {
      parsed.searchParams.set('api_key', key)
      return { url: parsed.toString() }
    }
  }
  return { url }
}
export function MapView({ points, selected, onSelect, theme }: { points: Point[]; selected: string | null; onSelect: (id: string | null) => void; theme: 'light' | 'dark' }) {
  const data = useMemo<GeoJSON.FeatureCollection<GeoJSON.Point, { id: string }>>(() => ({ type: 'FeatureCollection', features: points.map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p.coordinates }, properties: { id: p.id } })) }), [points])
  const point = points.find(p => p.id === selected)
  return <div className="map-area"><Map center={[-83.5, 32.7]} zoom={6.4} theme={theme} transformRequest={transformRequest}>
    <MapClusterLayer data={data} onPointClick={feature => onSelect(feature.properties.id)} />
    <MapControls position="bottom-right" showZoom />
    {point && <MapPopup longitude={point.coordinates[0]} latitude={point.coordinates[1]} onClose={() => onSelect(null)} closeButton><div className="map-popup"><strong>{point.name || 'Unnamed facility'}</strong><p>Inspection score: {point.score ?? 'Not available'}</p></div></MapPopup>}
  </Map></div>
}
