import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Map, MapClusterLayer, MapControls, MapPopup, useMap } from '@/components/ui/map'
import type { ErrorEvent as MapErrorEvent } from 'maplibre-gl'
import type { Facility, Point } from './types'

class MapErrorBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <MapFailure onRetry={this.props.onRetry} /> : this.props.children }
}

function MapFailure({ onRetry }: { onRetry: () => void }) {
  return <div className="map-failure"><p role="status">The map could not be loaded. You can still search and view facility details.</p><button onClick={onRetry}>Retry</button></div>
}

function MapLoadMonitor({ onLoaded, onFailure }: { onLoaded: () => void; onFailure: () => void }) {
  const { map } = useMap()
  useEffect(() => {
    if (!map) return
    const onStyleLoad = () => onLoaded()
    const onError = (event: MapErrorEvent) => { if (/worker/i.test(event.error.message)) onFailure() }
    map.on('style.load', onStyleLoad)
    map.on('error', onError)
    if (map.getStyle()?.layers) onLoaded()
    map.getCanvas().addEventListener('webglcontextlost', onFailure)
    return () => { map.off('style.load', onStyleLoad); map.off('error', onError); map.getCanvas().removeEventListener('webglcontextlost', onFailure) }
  }, [map, onLoaded, onFailure])
  return null
}

const georgiaBounds: [[number, number], [number, number]] = [[-85.61, 30.36], [-80.84, 35.0]]

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
        map.fitBounds(georgiaBounds, { padding: 20, duration: 0 })
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
export function MapView({ points, selected, onSelect, theme, detail, detailError }: { points: Point[]; selected: string | null; onSelect: (id: string | null) => void; theme: 'light' | 'dark'; detail: Facility | null; detailError: boolean }) {
  const data = useMemo<GeoJSON.FeatureCollection<GeoJSON.Point, { id: string }>>(() => ({ type: 'FeatureCollection', features: points.map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p.coordinates }, properties: { id: p.id } })) }), [points])
  const point = points.find(p => p.id === selected)
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const retry = () => { setLoaded(false); setFailed(false); setAttempt(value => value + 1) }
  useEffect(() => {
    if (loaded) return
    const timer = window.setTimeout(() => setFailed(true), 15000)
    return () => window.clearTimeout(timer)
  }, [loaded, attempt])
  return <div className="map-area"><MapErrorBoundary key={attempt} onRetry={retry}>{failed ? <MapFailure onRetry={retry} /> : <Map bounds={georgiaBounds} fitBoundsOptions={{ padding: 20 }} theme={theme} transformRequest={transformRequest}>
    <MapLoadMonitor onLoaded={() => setLoaded(true)} onFailure={() => setFailed(true)} />
    <FitGeorgia selected={selected} />
    <MapClusterLayer data={data} onPointClick={feature => onSelect(feature.properties.id)} />
    <SelectedLocation selected={selected} point={point} />
    <MapControls position="bottom-right" showZoom />
    {point && <MapPopup longitude={point.coordinates[0]} latitude={point.coordinates[1]} onClose={() => onSelect(null)} closeButton closeOnClick={false} focusAfterOpen={false}><div className="map-popup">{detail ? <><strong>{detail.name || 'Unnamed facility'}</strong><p>Inspection score: {detail.lastInspectionScore ?? 'Not available'}</p></> : <p>{detailError ? 'Facility details unavailable.' : 'Loading facility…'}</p>}</div></MapPopup>}
  </Map>}</MapErrorBoundary></div>
}
