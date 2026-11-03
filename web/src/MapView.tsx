import { useEffect, useMemo, useRef, useState } from 'react'
import { Map, MapClusterLayer, MapControls, MapPopup, useMap } from '@/components/ui/map'
import { getDetail } from './api'
import type { Facility, Point } from './types'

function FitGeorgia({ selected }: { selected: string | null }) {
  const { map, isLoaded } = useMap()
  const fitted = useRef(false)
  useEffect(() => {
    if (!map || !isLoaded || selected || fitted.current) return
    const fit = () => {
      const container = map.getContainer()
      if (!fitted.current && container.clientWidth && container.clientHeight) {
        fitted.current = true
        map.resize()
        map.fitBounds([[-85.61, 30.36], [-80.84, 35.0]], { padding: 20, duration: 0 })
      }
    }
    const observer = new ResizeObserver(fit)
    observer.observe(map.getContainer())
    fit()
    return () => observer.disconnect()
  }, [map, isLoaded, selected])
  return null
}

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
  const [detail, setDetail] = useState<Facility | null>(null)
  const [detailError, setDetailError] = useState(false)
  useEffect(() => {
    let active = true
    setDetail(null); setDetailError(false)
    if (selected) getDetail(selected).then(result => { if (active) setDetail(result.facility) }).catch(() => { if (active) setDetailError(true) })
    return () => { active = false }
  }, [selected])
  return <div className="map-area"><Map bounds={[[-85.61, 30.36], [-80.84, 35.0]]} fitBoundsOptions={{ padding: 20 }} theme={theme} transformRequest={transformRequest}>
    <FitGeorgia selected={selected} />
    <MapClusterLayer data={data} onPointClick={feature => onSelect(feature.properties.id)} />
    <SelectedLocation selected={selected} point={point} />
    <MapControls position="bottom-right" showZoom />
    {point && <MapPopup longitude={point.coordinates[0]} latitude={point.coordinates[1]} onClose={() => onSelect(null)} closeButton closeOnClick={false}><div className="map-popup">{detail ? <><strong>{detail.name || 'Unnamed facility'}</strong><p>Inspection score: {detail.lastInspectionScore ?? 'Not available'}</p></> : <p>{detailError ? 'Facility details unavailable.' : 'Loading facility…'}</p>}</div></MapPopup>}
  </Map></div>
}
