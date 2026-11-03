import { useEffect, useMemo, useRef } from 'react'
import { Map, MapClusterLayer, MapControls, MapPopup, useMap } from '@/components/ui/map'
import type { Point } from './types'

function SelectedLocation({ selected, point }: { selected: string | null; point: Point | undefined }) {
  const { map, isLoaded } = useMap()
  const selection = useRef<{ id: string | null; moved: boolean }>({ id: null, moved: false })
  const longitude = point?.coordinates[0]
  const latitude = point?.coordinates[1]
  useEffect(() => {
    if (selection.current.id !== selected) selection.current = { id: selected, moved: false }
    if (selected && !selection.current.moved && map && isLoaded && longitude !== undefined && latitude !== undefined) {
      selection.current.moved = true
      map.easeTo({ center: [longitude, latitude], zoom: Math.max(map.getZoom(), 12), duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 700 })
    }
  }, [selected, map, isLoaded, longitude, latitude])
  return null
}

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
    <SelectedLocation selected={selected} point={point} />
    <MapControls position="bottom-right" showZoom />
    {point && <MapPopup longitude={point.coordinates[0]} latitude={point.coordinates[1]} onClose={() => onSelect(null)} closeButton><div className="map-popup"><strong>{point.name || 'Unnamed facility'}</strong><p>Inspection score: {point.score ?? 'Not available'}</p></div></MapPopup>}
  </Map></div>
}
