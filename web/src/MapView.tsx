import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Map, MapClusterLayer, MapControls, MapMarker, MarkerContent, MapPopup, useMap } from '@/components/ui/map'
import type { ErrorEvent as MapErrorEvent } from 'maplibre-gl'
import type { Facility, MapArea, Point } from './types'
import type { Origin } from './useNearby'
import { MapFailure } from './MapFailure'
import { facilityTitle, officialName } from './facilityName'

class MapErrorBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <MapFailure onRetry={this.props.onRetry} /> : this.props.children }
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

function FitView({ selected, nearby, origin, fitPoints, ready, area, reset }: { selected: string | null; nearby: boolean; origin: Origin | null; fitPoints: Point[]; ready: boolean; area: boolean; reset: number }) {
  const { map, isLoaded } = useMap()
  const fitted = useRef('')
  const fittedReset = useRef(reset)
  useEffect(() => {
    if (!map || !isLoaded) return
    const fit = () => {
      const container = map.getContainer()
      if (!container.clientWidth || !container.clientHeight) return
      map.resize()
      if (area) return
      if (!nearby && reset !== fittedReset.current) {
        fittedReset.current = reset
        fitted.current = `georgia-${reset}`
        map.fitBounds(georgiaBounds, { padding: 20, duration: 0 })
        return
      }
      if (selected && !nearby) return
      const target = nearby ? origin && ready ? `nearby-${origin.sequence}-${JSON.stringify(fitPoints.map(p => [p.id, ...p.coordinates]))}` : '' : `georgia-${reset}`
      if (!target || fitted.current === target) return
      fitted.current = target
      if (!nearby || !origin) map.fitBounds(georgiaBounds, { padding: 20, duration: 0 })
      else {
        const coordinates = [origin.coordinates, ...fitPoints.map(p => p.coordinates)]
        const lons = coordinates.map(c => c[0]); const lats = coordinates.map(c => c[1])
        map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: { top: 76, right: 60, bottom: 60, left: 60 }, maxZoom: 13, duration: 0 })
      }
    }
    const observer = new ResizeObserver(fit)
    observer.observe(map.getContainer()); fit()
    return () => observer.disconnect()
  }, [map, isLoaded, selected, nearby, origin, fitPoints, ready, area, reset])
  return null
}

function AreaMovement({ onArea, cancelKey }: { onArea: (area: MapArea) => void; cancelKey: string }) {
  const { map } = useMap()
  useEffect(() => {
    if (!map) return
    let timer: number | undefined
    const cancel = () => { clearTimeout(timer); timer = undefined }
    const onMoveEnd = (event: { originalEvent?: unknown; user?: boolean }) => {
      cancel()
      if (!event.originalEvent && !event.user) return
      const container = map.getContainer()
      if (!container.clientWidth || !container.clientHeight) return
      timer = window.setTimeout(() => {
        if (!container.clientWidth || !container.clientHeight) return
        const bounds = map.getBounds(); const center = map.getCenter()
        onArea({ bounds: [[bounds.getWest(), bounds.getSouth()], [bounds.getEast(), bounds.getNorth()]], center: [center.lng, center.lat] })
      }, 300)
    }
    map.on('movestart', cancel); map.on('moveend', onMoveEnd)
    return () => { cancel(); map.off('movestart', cancel); map.off('moveend', onMoveEnd) }
  }, [map, onArea, cancelKey])
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

const clusterColors: Record<'light' | 'dark', [string, string, string]> = { light: ['#404040', '#2b2b2b', '#171717'], dark: ['#5c5c5c', '#646464', '#6b6b6b'] }
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
export function MapView({ filtered, selectedPoint: point, statewidePoints, fitPoints, ready, origin, nearby, selected, onSelect, theme, detail, detailError, area, reset, onArea, cancelKey }: { filtered: boolean; selectedPoint: Point | undefined; statewidePoints: Point[]; fitPoints: Point[]; ready: boolean; origin: Origin | null; nearby: boolean; selected: string | null; onSelect: (id: string | null) => void; theme: 'light' | 'dark'; detail: Facility | null; detailError: boolean; area: boolean; reset: number; onArea: (area: MapArea) => void; cancelKey: string }) {
  const data = useMemo<GeoJSON.FeatureCollection<GeoJSON.Point, { id: string }>>(() => ({ type: 'FeatureCollection', features: statewidePoints.map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p.coordinates }, properties: { id: p.id } })) }), [statewidePoints])
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const mapRegion = useRef<HTMLElement>(null)
  const onLoaded = useCallback(() => setLoaded(true), [])
  const onFailure = useCallback(() => setFailed(true), [])
  const retry = () => { mapRegion.current?.focus(); setLoaded(false); setFailed(false); setAttempt(value => value + 1) }
  useEffect(() => {
    if (loaded) return
    const timer = window.setTimeout(() => setFailed(true), 15000)
    return () => window.clearTimeout(timer)
  }, [loaded, attempt])
  return <section ref={mapRegion} className="map-area" aria-label={filtered ? 'Map of shown search results' : 'Facility map'} tabIndex={-1}><MapErrorBoundary key={attempt} onRetry={retry}>{failed ? <MapFailure onRetry={retry} /> : <Map bounds={georgiaBounds} fitBoundsOptions={{ padding: 20 }} theme={theme} transformRequest={transformRequest}>
    <MapLoadMonitor onLoaded={onLoaded} onFailure={onFailure} />
    <AreaMovement onArea={onArea} cancelKey={cancelKey} />
    <FitView selected={selected} nearby={nearby} origin={origin} fitPoints={fitPoints} ready={ready} area={area} reset={reset} />
    <MapClusterLayer data={data} clusterColors={clusterColors[theme]} pointColor={theme === 'dark' ? '#fafafa' : '#171717'} onPointClick={feature => onSelect(feature.properties.id)} />
    {nearby && origin && <MapMarker longitude={origin.coordinates[0]} latitude={origin.coordinates[1]}><MarkerContent className="origin-marker-container"><span className="origin-marker" role="img" aria-label="Your location"><span aria-hidden="true">◆</span> You</span></MarkerContent></MapMarker>}
    <SelectedLocation selected={selected} point={point} />
    <MapControls position="bottom-right" showZoom />
    {point && <MapPopup longitude={point.coordinates[0]} latitude={point.coordinates[1]} onClose={() => onSelect(null)} closeButton closeOnClick={false} focusAfterOpen={false}><div className="map-popup">{detail ? <><strong>{facilityTitle(detail)}</strong>{officialName(detail) && <p>Listed as {officialName(detail)}</p>}<p>Inspection score: {detail.lastInspectionScore ?? 'Not available'}</p></> : <p>{detailError ? 'Facility details unavailable.' : 'Loading facility…'}</p>}</div></MapPopup>}
  </Map>}</MapErrorBoundary></section>
}
