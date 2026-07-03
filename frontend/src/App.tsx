import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { FeatureCollection, Point } from 'geojson'
import type { Map as MapLibreMap } from 'maplibre-gl'
import {
  Activity,
  AlertTriangle,
  Building2,
  ChevronUp,
  List,
  LocateFixed,
  Navigation,
  Search,
  Utensils,
  X,
} from 'lucide-react'
import { Map, MapClusterLayer, MapControls, MapPopup } from '@/components/ui/map'

type Establishment = {
  id: number
  name: string
  address: string | null
  city: string | null
  county: string | null
  zip_code: string | null
  phone: string | null
  permit_type: string | null
  last_score: number | null
  last_inspection_date: string | null
}

type ApiResponse = {
  data: Establishment[]
  meta: {
    total: number
    page: number
    limit: number
  }
}

type EstablishmentPoint = Establishment & {
  longitude: number
  latitude: number
  scoreBand: 'great' | 'ok' | 'watch' | 'unknown'
}

type PointProperties = EstablishmentPoint

type AreaBounds = {
  west: number
  east: number
  south: number
  north: number
}

const API_BASE = import.meta.env.VITE_GA_HEALTH_API_BASE ?? '/ga-api/api/v1'

const cityCenters: Record<string, [number, number]> = {
  ACWORTH: [-84.6769, 34.0659],
  ALBANY: [-84.1557, 31.5785],
  ALPHARETTA: [-84.2941, 34.0754],
  ATHENS: [-83.3779, 33.9519],
  ATLANTA: [-84.388, 33.749],
  AUGUSTA: [-81.9748, 33.4735],
  AUSTELL: [-84.6344, 33.8126],
  BUFORD: [-84.0044, 34.1207],
  CANTON: [-84.49, 34.2368],
  COLUMBUS: [-84.9877, 32.4609],
  CUMMING: [-84.1402, 34.2073],
  DALTON: [-84.9702, 34.7698],
  DECATUR: [-84.2963, 33.7748],
  DULUTH: [-84.1446, 34.0029],
  GAINESVILLE: [-83.8241, 34.2979],
  KENNESAW: [-84.6155, 34.0234],
  LAWRENCEVILLE: [-83.9879, 33.9562],
  'LITHIA SPRINGS': [-84.6605, 33.7939],
  MACON: [-83.6324, 32.8407],
  MARIETTA: [-84.5499, 33.9526],
  NORCROSS: [-84.2135, 33.9412],
  ROME: [-85.1647, 34.257],
  ROSWELL: [-84.3616, 34.0232],
  SAVANNAH: [-81.0912, 32.0809],
  SNELLVILLE: [-84.0199, 33.8573],
  'STONE MOUNTAIN': [-84.1702, 33.8082],
  SUWANEE: [-84.0713, 34.0515],
  TUCKER: [-84.2171, 33.8545],
  VALDOSTA: [-83.2785, 30.8327],
}

const permitColors: Record<string, string> = {
  'Food Service': '#58c783',
  'Swimming Pool': '#5ca8e8',
  Tourist: '#d9709d',
}

const scoreOptions = [
  { value: 'all', label: 'All' },
  { value: 'great', label: '90+' },
  { value: 'watch', label: '<80' },
  { value: 'unknown', label: 'No score' },
] as const

function hashNumber(input: string) {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash >>> 0)
}

function jitteredCoordinates(place: Establishment): [number, number] {
  const cityKey = place.city?.trim().toUpperCase() ?? ''
  const base = cityCenters[cityKey] ?? [-83.5, 32.9]
  const hash = hashNumber(`${place.id}-${place.address ?? ''}`)
  const angle = (hash % 360) * (Math.PI / 180)
  const distance = ((hash % 1000) / 1000) * 0.12
  return [base[0] + Math.cos(angle) * distance, base[1] + Math.sin(angle) * distance]
}

function scoreBand(score: number | null): EstablishmentPoint['scoreBand'] {
  if (score === null) return 'unknown'
  if (score >= 90) return 'great'
  if (score >= 80) return 'ok'
  return 'watch'
}

function scoreLabel(score: number | null) {
  return score === null ? 'No score' : `${score}`
}

function formatDate(date: string | null) {
  if (!date) return 'No recent inspection'
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(date))
}

function toPoint(record: Establishment): EstablishmentPoint {
  const [longitude, latitude] = jitteredCoordinates(record)
  return {
    ...record,
    longitude,
    latitude,
    scoreBand: scoreBand(record.last_score),
  }
}

function toFeatureCollection(points: EstablishmentPoint[]): FeatureCollection<Point, PointProperties> {
  return {
    type: 'FeatureCollection',
    features: points.map((point) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [point.longitude, point.latitude],
      },
      properties: point,
    })),
  }
}

function uniquePermits(points: EstablishmentPoint[]) {
  return [...new Set(points.map((point) => point.permit_type).filter(Boolean) as string[])].slice(0, 5)
}

function readMapBounds(map: MapLibreMap): AreaBounds {
  const bounds = map.getBounds()
  return {
    west: bounds.getWest(),
    east: bounds.getEast(),
    south: bounds.getSouth(),
    north: bounds.getNorth(),
  }
}

function pointInBounds(point: EstablishmentPoint, bounds: AreaBounds) {
  const fitsLatitude = point.latitude >= bounds.south && point.latitude <= bounds.north
  const fitsLongitude =
    bounds.west <= bounds.east
      ? point.longitude >= bounds.west && point.longitude <= bounds.east
      : point.longitude >= bounds.west || point.longitude <= bounds.east
  return fitsLatitude && fitsLongitude
}

function App() {
  const [points, setPoints] = useState<EstablishmentPoint[]>([])
  const [total, setTotal] = useState(0)
  const [loadedCount, setLoadedCount] = useState(0)
  const [query, setQuery] = useState('')
  const [permit, setPermit] = useState('All')
  const [scoreFilter, setScoreFilter] = useState<'all' | 'great' | 'watch' | 'unknown'>('all')
  const [selected, setSelected] = useState<EstablishmentPoint | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const [areaBounds, setAreaBounds] = useState<AreaBounds | null>(null)
  const [areaDirty, setAreaDirty] = useState(false)
  const [isLocating, setIsLocating] = useState(false)
  const [locationError, setLocationError] = useState<string | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const mapReadyRef = useRef(false)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    document.documentElement.classList.add('dark')
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    async function fetchPage(page: number, limit: number) {
      const response = await fetch(`${API_BASE}/establishments?limit=${limit}&page=${page}`, {
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`API returned ${response.status}`)
      return (await response.json()) as ApiResponse
    }

    async function fetchEstablishments() {
      setIsLoading(true)
      setError(null)
      setLoadedCount(0)
      try {
        const pageSize = 100
        const firstPage = await fetchPage(1, pageSize)
        const totalAvailable = firstPage.meta.total
        const pageCount = Math.ceil(totalAvailable / pageSize)
        const allPoints = firstPage.data.map(toPoint)

        setTotal(totalAvailable)
        setPoints(allPoints)
        setLoadedCount(allPoints.length)

        const chunkSize = 10
        for (let startPage = 2; startPage <= pageCount; startPage += chunkSize) {
          const chunkPages = Array.from(
            { length: Math.min(chunkSize, pageCount - startPage + 1) },
            (_, index) => startPage + index,
          )
          const pages = await Promise.all(chunkPages.map((page) => fetchPage(page, pageSize)))
          if (controller.signal.aborted) return
          allPoints.push(...pages.flatMap((page) => page.data.map(toPoint)))
          setPoints([...allPoints])
          setLoadedCount(allPoints.length)
        }
      } catch (fetchError) {
        if (fetchError instanceof DOMException && fetchError.name === 'AbortError') return
        setError(fetchError instanceof Error ? fetchError.message : 'Unable to load GA Health records')
      } finally {
        if (!controller.signal.aborted) setIsLoading(false)
      }
    }

    fetchEstablishments()
    return () => controller.abort()
  }, [])

  const permits = useMemo(() => uniquePermits(points), [points])

  const baseFilteredPoints = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return points.filter((point) => {
      const matchesQuery =
        !normalizedQuery ||
        [point.name, point.address, point.city, point.county, point.zip_code]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(normalizedQuery))
      const matchesPermit = permit === 'All' || point.permit_type === permit
      const matchesScore = scoreFilter === 'all' || point.scoreBand === scoreFilter
      return matchesQuery && matchesPermit && matchesScore
    })
  }, [points, permit, query, scoreFilter])

  const filteredPoints = useMemo(
    () => (areaBounds ? baseFilteredPoints.filter((point) => pointInBounds(point, areaBounds)) : baseFilteredPoints),
    [areaBounds, baseFilteredPoints],
  )

  const refreshArea = () => {
    if (!mapRef.current) return
    setAreaBounds(readMapBounds(mapRef.current))
    setAreaDirty(false)
    setSelected(null)
  }

  const handleViewportChange = () => {
    if (!mapReadyRef.current) {
      mapReadyRef.current = true
      return
    }
    setAreaDirty((dirty) => (dirty ? dirty : true))
  }

  const featureCollection = useMemo(() => toFeatureCollection(filteredPoints), [filteredPoints])
  const watchCount = useMemo(() => filteredPoints.filter((point) => point.scoreBand === 'watch').length, [filteredPoints])
  const listPoints = useMemo(() => filteredPoints.slice(0, 200), [filteredPoints])
  const hiddenListCount = Math.max(filteredPoints.length - listPoints.length, 0)
  const mapStatus = isLoading
    ? `Loading ${loadedCount.toLocaleString()} map points`
    : areaDirty
      ? 'Map moved. Refresh to update results'
      : areaBounds
        ? `${filteredPoints.length.toLocaleString()} points in this area`
        : `${filteredPoints.length.toLocaleString()} points on map`

  const focusPoint = (point: EstablishmentPoint) => {
    setSelected(point)
    setListOpen(false)
    mapRef.current?.flyTo({
      center: [point.longitude, point.latitude],
      zoom: Math.max(mapRef.current.getZoom(), 12),
      duration: 650,
    })
  }

  const useCurrentLocation = () => {
    if (!navigator.geolocation) {
      setLocationError('Location is not available in this browser')
      return
    }

    setIsLocating(true)
    setLocationError(null)
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const map = mapRef.current
        if (!map) {
          setIsLocating(false)
          return
        }

        const center: [number, number] = [coords.longitude, coords.latitude]
        const applyNearbyBounds = () => {
          setAreaBounds(readMapBounds(map))
          setAreaDirty(false)
          setSelected(null)
          setListOpen(false)
          setIsLocating(false)
        }

        map.once('moveend', applyNearbyBounds)
        map.flyTo({ center, zoom: 13, duration: 900 })
      },
      () => {
        setIsLocating(false)
        setLocationError('Allow location to show nearby points')
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    )
  }

  return (
    <main className="relative h-[100dvh] overflow-hidden bg-[#070b0a] text-[#eef4ed]">
      <Map
        ref={(map) => {
          mapRef.current = map
        }}
        center={[-83.7, 32.9]}
        zoom={6.05}
        theme="dark"
        fadeDuration={0}
        loading={isLoading}
        onViewportChange={handleViewportChange}
        className="absolute inset-0 h-full w-full"
      >
        <MapClusterLayer<PointProperties>
          data={featureCollection}
          clusterRadius={62}
          clusterMaxZoom={12}
          clusterColors={['#58c783', '#5ca8e8', '#d9709d']}
          clusterThresholds={[30, 140]}
          pointColor="#58c783"
          onPointClick={(feature, coordinates) => {
            setSelected({ ...feature.properties, longitude: coordinates[0], latitude: coordinates[1] })
          }}
        />
        <MapControls position="bottom-right" />
        {selected && (
          <MapPopup
            longitude={selected.longitude}
            latitude={selected.latitude}
            closeButton
            onClose={() => setSelected(null)}
            className="w-[min(320px,calc(100vw-32px))] rounded-[1.35rem] border-white/10 bg-[#111816]/96 p-0 text-[#eef4ed] shadow-[0_30px_90px_rgba(0,0,0,.48)]"
          >
            <div className="overflow-hidden rounded-[1.35rem]">
              <div className="border-b border-white/8 bg-[linear-gradient(135deg,rgba(88,199,131,.16),rgba(255,255,255,.04))] p-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <span
                    className="rounded-full px-3 py-1 text-[11px] font-semibold text-[#101512]"
                    style={{ background: permitColors[selected.permit_type ?? ''] ?? '#eef4ed' }}
                  >
                    {selected.permit_type ?? 'Permit'}
                  </span>
                  <span className="rounded-full border border-white/10 bg-white/[.055] px-3 py-1 text-[11px] font-medium text-[#dce7dd]">
                    Score {scoreLabel(selected.last_score)}
                  </span>
                </div>
                <h2 className="text-base font-semibold leading-tight tracking-[-.035em]">{selected.name}</h2>
                <p className="mt-2 text-xs leading-5 text-[#aebcaf]">{selected.address ?? 'Address unavailable'}</p>
              </div>
              <div className="grid grid-cols-2 gap-2 p-4 text-xs text-[#9baa9f]">
                <Detail label="City" value={selected.city ?? 'No data'} />
                <Detail label="County" value={selected.county ?? 'No data'} />
                <Detail label="Inspected" value={formatDate(selected.last_inspection_date)} wide />
                <Detail label="Phone" value={selected.phone ?? 'No data'} wide />
              </div>
            </div>
          </MapPopup>
        )}
      </Map>

      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_24%_8%,rgba(88,199,131,.22),transparent_26%),linear-gradient(180deg,rgba(7,11,10,.74)_0%,rgba(7,11,10,.08)_28%,rgba(7,11,10,.52)_100%)]" />

      {areaDirty && (
        <div className="absolute left-1/2 top-[45%] z-30 -translate-x-1/2 sm:top-24 lg:top-7">
          <button
            type="button"
            onClick={refreshArea}
            className="rounded-full border border-[#58c783]/35 bg-[#101512]/88 px-4 py-2 text-xs font-semibold text-[#d9ffe4] shadow-[0_18px_60px_rgba(0,0,0,.34)] backdrop-blur-xl transition hover:bg-[#17211d] active:scale-[.98]"
          >
            Refresh this area
          </button>
        </div>
      )}

      <header className="pointer-events-none absolute left-0 right-0 top-0 z-20 p-4 pt-[max(1rem,env(safe-area-inset-top))] sm:p-5 lg:left-5 lg:right-auto lg:top-5 lg:w-[380px] lg:p-0">
        <div className="pointer-events-auto rounded-[1.6rem] border border-white/10 bg-[#101512]/76 p-4 shadow-[0_24px_80px_rgba(0,0,0,.34)] backdrop-blur-xl lg:p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="grid size-10 place-items-center rounded-2xl bg-[#eef4ed] text-[#101512]">
                <Activity size={20} strokeWidth={1.7} />
              </div>
              <div>
                <p className="text-[11px] font-medium text-[#9baa9f]">Georgia public health</p>
                <h1 className="text-lg font-semibold tracking-[-.045em]">Inspection Atlas</h1>
              </div>
            </div>
            <Pill>{filteredPoints.length.toLocaleString()}</Pill>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Metric label="Shown" value={filteredPoints.length.toLocaleString()} />
            <Metric label="Watch" value={watchCount.toLocaleString()} tone="warn" />
            <Metric label="Total" value={total ? `${Math.round(total / 1000)}k` : '—'} />
          </div>
        </div>
      </header>

      <section className="absolute bottom-0 left-0 right-0 z-20 p-3 pb-[max(.75rem,env(safe-area-inset-bottom))] lg:bottom-5 lg:left-5 lg:right-auto lg:w-[380px] lg:p-0">
        <div className="rounded-[1.8rem] border border-white/10 bg-[#101512]/86 p-3 shadow-[0_-20px_80px_rgba(0,0,0,.38)] backdrop-blur-2xl lg:p-4">
          <button
            type="button"
            onClick={() => setSheetOpen((open) => !open)}
            className="mx-auto mb-3 flex h-8 w-full items-center justify-center gap-2 rounded-full text-xs font-medium text-[#9baa9f] lg:hidden"
            aria-expanded={sheetOpen}
          >
            <span className="h-1.5 w-12 rounded-full bg-white/24" />
            <ChevronUp className={`transition ${sheetOpen ? 'rotate-180' : ''}`} size={15} />
          </button>

          <label className="relative block">
            <Search className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#7f9186]" size={18} strokeWidth={1.7} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search place or city"
              className="h-13 w-full rounded-[1.25rem] border border-white/8 bg-[#0b100e] pl-11 pr-4 text-base text-[#eef4ed] outline-none transition placeholder:text-[#728278] focus:border-[#58c783]/50 focus:shadow-[0_0_0_4px_rgba(88,199,131,.12)]"
            />
          </label>

          <div className={`${sheetOpen ? 'mt-3 max-h-80 opacity-100' : 'mt-0 max-h-0 opacity-0'} overflow-hidden transition-all duration-300 lg:mt-3 lg:max-h-none lg:opacity-100`}>
            <FilterRow label="Score">
              {scoreOptions.map(({ value, label }) => (
                <FilterChip key={value} active={scoreFilter === value} onClick={() => setScoreFilter(value)}>
                  {label}
                </FilterChip>
              ))}
            </FilterRow>

            <FilterRow label="Type">
              {['All', ...permits].map((option) => (
                <FilterChip key={option} active={permit === option} onClick={() => setPermit(option)}>
                  {option}
                </FilterChip>
              ))}
            </FilterRow>

            <div className="mt-3 flex items-center gap-2 text-[11px] text-[#9baa9f]">
              <LocateFixed size={14} strokeWidth={1.7} />
              Approximate city placement
            </div>

            <button
              type="button"
              onClick={() => setListOpen(true)}
              className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-full border border-white/8 bg-white/[.06] text-sm font-semibold text-[#eef4ed] transition hover:bg-white/[.10] active:scale-[.98]"
            >
              <List size={16} strokeWidth={1.8} />
              View list
            </button>

            <button
              type="button"
              onClick={useCurrentLocation}
              disabled={isLocating}
              className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-full bg-[#eef4ed] text-sm font-semibold text-[#101512] transition hover:bg-white active:scale-[.98] disabled:opacity-55"
            >
              <Navigation size={16} strokeWidth={1.8} />
              {isLocating ? 'Finding location' : 'Near me'}
            </button>

            {locationError && <p className="mt-2 text-center text-xs text-[#ffc07a]">{locationError}</p>}

            {error && (
              <div className="mt-3 flex gap-2 rounded-2xl border border-[#d9709d]/30 bg-[#d9709d]/10 p-3 text-xs text-[#ffd1df]">
                <AlertTriangle className="mt-0.5 shrink-0" size={15} strokeWidth={1.7} />
                <span>{error}</span>
              </div>
            )}

            {filteredPoints.length === 0 && !isLoading && !error && (
              <div className="mt-3 flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[.04] p-3 text-sm text-[#dce7dd]">
                <Utensils className="text-[#9baa9f]" size={18} strokeWidth={1.6} />
                No matches. Try a wider filter.
              </div>
            )}

            <div className="mt-3 rounded-2xl border border-white/8 bg-white/[.04] px-3 py-2 text-center text-xs text-[#9baa9f]">
              {mapStatus}
            </div>
          </div>
        </div>
      </section>

      {listOpen && (
        <section className="absolute inset-x-3 bottom-3 top-[18dvh] z-40 overflow-hidden rounded-[1.8rem] border border-white/10 bg-[#101512]/94 shadow-[0_28px_100px_rgba(0,0,0,.52)] backdrop-blur-2xl lg:bottom-5 lg:left-auto lg:right-5 lg:top-5 lg:w-[390px]">
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between gap-3 border-b border-white/8 p-4">
              <div>
                <p className="text-[11px] font-medium text-[#9baa9f]">Current map results</p>
                <h2 className="text-lg font-semibold tracking-[-.04em]">{filteredPoints.length.toLocaleString()} places</h2>
              </div>
              <button
                type="button"
                onClick={() => setListOpen(false)}
                className="grid size-10 place-items-center rounded-full border border-white/8 bg-white/[.05] text-[#dce7dd] transition hover:bg-white/[.10]"
                aria-label="Close list"
              >
                <X size={17} strokeWidth={1.8} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {listPoints.length > 0 ? (
                <div className="grid gap-1">
                  {listPoints.map((point) => (
                    <button
                      key={point.id}
                      type="button"
                      onClick={() => focusPoint(point)}
                      className="rounded-2xl border border-transparent p-3 text-left transition hover:border-[#58c783]/25 hover:bg-white/[.055] focus:border-[#58c783]/40 focus:bg-white/[.06] focus:outline-none"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-[#eef4ed]">{point.name}</p>
                          <p className="mt-1 truncate text-xs text-[#9baa9f]">{point.city ?? 'Unknown city'}{point.county ? ` · ${point.county}` : ''}</p>
                        </div>
                        <span className="shrink-0 rounded-full border border-white/8 bg-white/[.05] px-2.5 py-1 text-[11px] font-medium text-[#dce7dd]">
                          {scoreLabel(point.last_score)}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="grid h-full place-items-center p-8 text-center text-sm text-[#9baa9f]">
                  No places in this view.
                </div>
              )}
            </div>

            {hiddenListCount > 0 && (
              <div className="border-t border-white/8 px-4 py-3 text-center text-xs text-[#9baa9f]">
                Showing first 200. Zoom or refresh area to narrow the list.
              </div>
            )}
          </div>
        </section>
      )}
    </main>
  )
}

function Metric({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'warn' }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[.055] px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-[.12em] text-[#7f9186]">{label}</p>
      <p className={`mt-0.5 truncate text-lg font-semibold tracking-[-.045em] ${tone === 'warn' ? 'text-[#ffc07a]' : 'text-[#eef4ed]'}`}>{value}</p>
    </div>
  )
}

function Pill({ children }: { children: ReactNode }) {
  return <span className="rounded-full border border-[#58c783]/25 bg-[#58c783]/12 px-3 py-1.5 text-xs font-medium text-[#a7e6be]">{children}</span>
}

function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[#9baa9f]">
        <Building2 size={14} strokeWidth={1.7} />
        {label}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{children}</div>
    </div>
  )
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-full border px-3.5 py-2 text-xs font-medium transition active:scale-[.98] ${
        active
          ? 'border-[#58c783]/45 bg-[#58c783]/16 text-[#b9efcb]'
          : 'border-white/8 bg-white/[.05] text-[#9baa9f] hover:text-[#eef4ed]'
      }`}
    >
      {children}
    </button>
  )
}

function Detail({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2' : ''}>
      <p className="text-[10px] font-medium uppercase tracking-[.14em] text-[#728278]">{label}</p>
      <p className="mt-1 text-[#eef4ed]">{value}</p>
    </div>
  )
}

export default App
