import { Component, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import type { RecordModel } from 'pocketbase'
import { LocateFixed, MapPinned, Moon, Search, Sun } from 'lucide-react'
import { LIST_LIMIT, useNearby } from './useNearby'
import { pb, getPoints, getDetail, search, refreshAuth } from './api'
import { MapFailure } from './MapFailure'
import { FacilityList } from './FacilityList'
import { FacilityDetail } from './FacilityDetail'
import { AuthPanel } from './AuthPanel'
import { AccountLink } from './AccountLink'
import type { Detail, Facility, MapArea, Snapshot } from './types'

const createMapView = () => lazy(async () => {
  const { setWorkerUrl } = await import('maplibre-gl')
  setWorkerUrl(workerUrl)
  const { MapView } = await import('./MapView')
  return { default: MapView }
})

class MapImportBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <MapFailure onRetry={this.props.onRetry} /> : this.props.children }
}

function selectedFromURL() {
  const match = location.pathname.match(/^\/facilities\/(.+)$/)
  try { return match ? decodeURIComponent(match[1]) : null } catch { return null }
}

function useMapData() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [mapMessage, setMapMessage] = useState('')
  const [pointsVersion, setPointsVersion] = useState(0)
  const [pointsLoading, setPointsLoading] = useState(true)

  useEffect(() => {
    setPointsLoading(true)
    getPoints().then(({ snapshot: data, stale }) => {
      setSnapshot(data)
      const generated = data.generatedAt && !Number.isNaN(Date.parse(data.generatedAt)) ? ` from ${new Date(data.generatedAt).toLocaleString()}` : ''
      setMapMessage(stale ? `Showing an older map snapshot${generated} because the inspection source is unavailable.` : '')
    }).catch(error => setMapMessage(error.message)).finally(() => setPointsLoading(false))
  }, [pointsVersion])
  return { snapshot, mapMessage, pointsLoading, retryPoints: () => setPointsVersion(v => v + 1) }
}

function useStatewideSearch(query: string, permit: string, paused: boolean) {
  const [facilities, setFacilities] = useState<Facility[]>([])
  const [searchMessage, setSearchMessage] = useState('')
  const [searching, setSearching] = useState(true)
  useEffect(() => {
    if (paused) return
    const controller = new AbortController()
    setSearching(true)
    const timer = setTimeout(() => {
      search(query, permit, controller.signal).then(data => {
        setFacilities(data.facilities)
        setSearchMessage('')
        setSearching(false)
      }).catch(error => {
        if (error.name === 'AbortError') return
        setSearchMessage(error.message)
        setSearching(false)
      })
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, permit, paused])

  return { facilities, searchMessage, searching }
}

function Header({ theme, toggleTheme, user, auth, setAuth, home, accountRef }: {
  theme: 'light' | 'dark'; toggleTheme: () => void; user: RecordModel | null
  auth: boolean; setAuth: (value: boolean) => void; home: () => void; accountRef: React.RefObject<HTMLButtonElement | null>
}) {
  return <header className="topbar">
    <a href="/" className="brand" onClick={e => { e.preventDefault(); home() }}>
      <span className="brand-icon"><MapPinned size={21} /></span>
      <span>Georgia <b>Inspection Map</b><small>Health inspections and visitor reviews</small></span>
    </a>
    <div className="header-actions">
      <button className="icon-button" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button>
      {user ? <><span className="user-name">{user.name}</span><button ref={accountRef} onClick={() => pb.authStore.clear()}>Sign out</button></> : <button ref={accountRef} className="primary" aria-expanded={auth} onClick={() => setAuth(!auth)}>Sign in</button>}
    </div>
  </header>
}

const RESULT_LIMIT = 100

function resultSummary(count: number, searching: boolean) {
  if (searching) return 'Searching…'
  if (count >= RESULT_LIMIT) return `First ${RESULT_LIMIT} facilities, refine to narrow`
  return `${count} ${count === 1 ? 'facility' : 'facilities'}`
}

type Nearby = ReturnType<typeof useNearby>

function nearbyStatus(nearby: Nearby, snapshot: Snapshot | null, pointsLoading: boolean, permit: string, area: MapArea | null) {
  const accuracy = nearby.origin && nearby.origin.accuracy > 1000 ? ' Your location is approximate; results may be less precise.' : ''
  if (nearby.locating) return { text: 'Finding your location…', error: false }
  if (nearby.error) return { text: nearby.error, error: true }
  if (!snapshot) return { text: pointsLoading ? 'Loading map data…' : 'Map data is unavailable.', error: !pointsLoading }
  if (nearby.loading) return { text: `Loading place details…${accuracy}`, error: false }
  if (nearby.lookupError) return { text: `${nearby.lookupError}${accuracy}`, error: true }
  if (area) {
    const missing = nearby.missing ? ` ${nearby.missing} ${nearby.missing === 1 ? 'place is' : 'places are'} missing details.` : ''
    return { text: nearby.areaCount > LIST_LIMIT ? `Showing ${LIST_LIMIT} of ${nearby.areaCount} places spread across this area. Zoom in or select a cluster to see others.${missing}` : nearby.areaCount ? `${nearby.areaCount} ${nearby.areaCount === 1 ? 'place' : 'places'} in this area.${missing}` : 'No places in this map area.', error: false }
  }
  if (!nearby.candidates.length) return { text: `No places found within 25 miles${permit ? ' for this type' : ''}.${accuracy}`, error: false }
  const missing = nearby.missing ? ` ${nearby.missing} nearby ${nearby.missing === 1 ? 'place is' : 'places are'} missing details and not shown.` : ''
  return { text: `${nearby.facilities.length} nearby ${nearby.facilities.length === 1 ? 'place' : 'places'} shown.${missing}${accuracy}`, error: false }
}

function NearbyStatus({ status }: { status: ReturnType<typeof nearbyStatus> }) {
  return <p>{status.text}</p>
}

function NearbyResults({ nearby, snapshot, pointsLoading, status, restoreId, onRestored, select, startNearby, leave, retryPoints, focusNear, area }: {
  nearby: Nearby; snapshot: Snapshot | null; pointsLoading: boolean; status: ReturnType<typeof nearbyStatus>; area: boolean
  restoreId: string | null; onRestored: () => void; select: (id: string) => void; startNearby: () => void; leave: () => void; retryPoints: () => void; focusNear: () => void
}) {
  const retry = (action: () => void) => { focusNear(); action() }
  function results() {
    if (nearby.error) return <div className="empty">{nearby.canLocate && <button onClick={() => retry(startNearby)}>Try again</button>} <button onClick={leave}>Browse all Georgia</button></div>
    if (!nearby.locating && !snapshot && !pointsLoading) return <div className="empty"><button onClick={() => retry(retryPoints)}>Retry map data</button></div>
    if (nearby.loading) return <div className="nearby-loading">{nearby.candidates.map(c => <div key={c.point.id} className="loading-row" aria-hidden="true" />)}</div>
    if (nearby.lookupError) return <div className="empty"><button onClick={() => retry(nearby.retry)}>Try again</button></div>
    if (snapshot && !nearby.locating && !nearby.candidates.length) return <div className="empty"><button onClick={leave}>Search all Georgia</button></div>
    if (nearby.facilities.length) return <FacilityList facilities={nearby.facilities} distances={nearby.origin ? nearby.distances : undefined} restoreId={restoreId} onRestored={onRestored} onSelect={select} />
    return null
  }
  return <>
    <p className="nearby-description">{area ? 'Places visible in the map area. Distances are straight-line, not travel distances.' : `Within 25 miles, up to ${LIST_LIMIT} places. Distances are straight-line, not travel distances.`}</p>
    <div className="nearby-status"><NearbyStatus status={status} /></div>
    {results()}
  </>
}

function Directory({ query, setQuery, permit, setPermit, snapshot, facilities, searchMessage, searching, restoreId, onRestored, select, nearby, startNearby, mapMessage, pointsLoading, retryPoints, status, area, leaveArea }: {
  query: string; setQuery: (value: string) => void; permit: string; setPermit: (value: string) => void
  snapshot: Snapshot | null; facilities: Facility[]; searchMessage: string; searching: boolean; restoreId: string | null; onRestored: () => void; select: (id: string) => void
  nearby: Nearby; startNearby: () => void; mapMessage: string; pointsLoading: boolean; retryPoints: () => void; status: ReturnType<typeof nearbyStatus>; area: boolean; leaveArea: () => void
}) {
  const nearButton = useRef<HTMLButtonElement>(null)
  const focusNear = () => nearButton.current?.focus()
  const leave = () => { focusNear(); leaveArea() }
  const hasList = nearby.active || area ? nearby.facilities.length > 0 && !nearby.loading && !nearby.error && !nearby.lookupError : !searchMessage && (!searching || facilities.length > 0)
  useLayoutEffect(() => {
    if (restoreId && !hasList) {
      document.querySelector<HTMLInputElement>('#search')?.focus()
      onRestored()
    }
  }, [restoreId, hasList, onRestored])
  return <>
    <div className="directory-head">
      <div className="search-header">
        <h1>Find a place</h1>
        <p className="discovery-intro">Explore inspections and hear from visitors.</p>
        <div className="search-field">
          <Search size={18} aria-hidden />
          <input id="search" type="search" aria-label="Search by name, address, or ID" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search all Georgia" autoComplete="off" />
        </div>
        <div className="discovery-actions"><button ref={nearButton} className="primary near-button" onClick={nearby.locating ? nearby.exit : startNearby}><LocateFixed size={17} aria-hidden />{nearby.locating ? 'Cancel locating' : 'Near me'}</button>{(nearby.active || area) && <button onClick={leave}>All Georgia</button>}</div>
      </div>
    </div>
    <div className="permit-chips" role="group" aria-label="Permit type">{['', ...(snapshot?.permitChoices ?? [])].map(p => <button key={p} aria-pressed={permit === p} onClick={() => setPermit(p)}>{p || 'All types'}</button>)}</div>
    <div className="results-heading"><span role={nearby.active || area ? undefined : 'status'}>{area ? 'Places in this map area' : nearby.active ? 'Nearby places' : searchMessage ? 'Search unavailable' : resultSummary(facilities.length, searching)}</span><span aria-hidden>Inspection score</span></div>
    {(nearby.active || area) && snapshot && mapMessage && <p className="directory-notice">{mapMessage}</p>}
    {nearby.active || area ? <NearbyResults area={area} nearby={nearby} snapshot={snapshot} pointsLoading={pointsLoading} status={status} restoreId={restoreId} onRestored={onRestored} select={select} startNearby={startNearby} leave={leave} retryPoints={retryPoints} focusNear={focusNear} /> : searchMessage ? <p className="empty" role="alert">{searchMessage}</p> : searching && !facilities.length ? null : <FacilityList facilities={facilities} restoreId={restoreId} onRestored={onRestored} onSelect={select} />}
  </>
}

export default function App() {
  const [path, setPath] = useState(location.pathname)
  const [selected, setSelected] = useState<string | null>(selectedFromURL)
  const [restoreId, setRestoreId] = useState<string | null>(null)
  const [detailState, setDetailState] = useState<{ id: string; detail: Detail | null; error: string } | null>(null)
  const [detailVersion, setDetailVersion] = useState(0)
  const loadDetail = useCallback(() => setDetailVersion(v => v + 1), [])
  useEffect(() => {
    if (!selected) return
    let active = true
    getDetail(selected).then(detail => { if (active) setDetailState({ id: selected, detail, error: '' }) }).catch(error => { if (active) setDetailState({ id: selected, detail: null, error: error.message }) })
    return () => { active = false }
  }, [selected, detailVersion])
  const currentDetail = detailState?.id === selected ? detailState : null
  const [query, setQuery] = useState('')
  const [permit, setPermit] = useState('')
  const { snapshot, mapMessage, pointsLoading, retryPoints } = useMapData()
  const [area, setArea] = useState<MapArea | null>(null)
  const [reset, setReset] = useState(0)
  const [movementVersion, setMovementVersion] = useState(0)
  const nearby = useNearby(snapshot, permit, area)
  const { facilities, searchMessage, searching } = useStatewideSearch(query, permit, nearby.active || !!area)
  const points = useMemo(() => (snapshot?.points || []).filter(p => !permit || p.permitType === permit), [snapshot, permit])
  const fitPoints = useMemo(() => nearby.fitCandidates.map(c => c.point), [nearby.fitCandidates])
  const clearArea = () => { setArea(null); setMovementVersion(v => v + 1) }
  const leaveArea = () => { clearArea(); if (area || nearby.active) setReset(v => v + 1); nearby.exit() }
  const startNearby = () => { clearArea(); setRestoreId(null); setQuery(''); nearby.locate() }
  const updateQuery = (value: string) => { clearArea(); if (nearby.active) nearby.exit(); setQuery(value) }
  const onArea = useCallback((next: MapArea) => { if (!query.trim() && !nearby.locating && (!nearby.active || nearby.origin)) setArea(next) }, [query, nearby.locating, nearby.active, nearby.origin])
  const onRestored = useCallback(() => setRestoreId(null), [])
  const status = nearbyStatus(nearby, snapshot, pointsLoading, permit, area)
  const [user, setUser] = useState<RecordModel | null>(pb.authStore.record)
  const [initialRecovery, setInitialRecovery] = useState(() => new URLSearchParams(location.search).get('resend') === 'verification')
  const [auth, setAuth] = useState(initialRecovery)
  useEffect(() => {
    if (!initialRecovery) return
    const url = new URL(location.href)
    url.searchParams.delete('resend')
    history.replaceState(history.state, '', url)
  }, [initialRecovery])
  const [mobileMap, setMobileMap] = useState(false)
  const [isMobile, setIsMobile] = useState(() => matchMedia('(max-width: 720px)').matches)
  useEffect(() => {
    const media = matchMedia('(max-width: 720px)')
    const update = () => setIsMobile(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const mapSurface = !!selected || (isMobile && mobileMap)
  const showMapStatus = (nearby.active || !!area) && mapSurface && (!!area || nearby.locating || !!nearby.error || !snapshot || nearby.loading || !!nearby.lookupError || !nearby.candidates.length || !!nearby.missing || (nearby.origin?.accuracy ?? 0) > 1000)
  const [mapAttempt, setMapAttempt] = useState(0)
  const [LazyMapView, setLazyMapView] = useState(createMapView)
  const mapRef = useRef<HTMLDivElement>(null)
  const mapNearRef = useRef<HTMLButtonElement>(null)
  const accountRef = useRef<HTMLButtonElement>(null)
  const retryMapImport = () => { mapRef.current?.focus(); setLazyMapView(createMapView()); setMapAttempt(n => n + 1) }
  const closeAuth = () => { setAuth(false); requestAnimationFrame(() => accountRef.current?.focus()) }
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const stored = localStorage.getItem('theme')
    return stored === 'light' || stored === 'dark' ? stored : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  useEffect(() => {
    const unsubscribe = pb.authStore.onChange(() => setUser(pb.authStore.record))
    void refreshAuth()
    const onFocus = () => { if (pb.authStore.token) void refreshAuth() }
    window.addEventListener('focus', onFocus)
    return () => { unsubscribe(); window.removeEventListener('focus', onFocus) }
  }, [])
  useEffect(() => { if (!auth) setInitialRecovery(false) }, [auth])
  useEffect(() => {
    if (!auth) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeAuth() }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [auth])
  useEffect(() => { document.documentElement.classList.toggle('dark', theme === 'dark'); document.documentElement.style.colorScheme = theme }, [theme])
  useEffect(() => {
    const handler = () => {
      if (nearby.locating) nearby.exit()
      setPath(location.pathname)
      const next = selectedFromURL()
      if (!next && selected) setRestoreId(selected)
      else if (next) setRestoreId(null)
      setSelected(next)
      if (next) setMobileMap(false)
    }
    addEventListener('popstate', handler)
    return () => removeEventListener('popstate', handler)
  }, [selected, nearby.locating, nearby.exit])

  function select(id: string | null) {
    if (nearby.locating) nearby.exit()
    setRestoreId(id ? null : selected)
    history.pushState(null, '', id ? `/facilities/${encodeURIComponent(id)}` : '/')
    setPath(location.pathname)
    setSelected(id)
    if (id) setMobileMap(false)
  }
  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('theme', next)
  }
  const accountRoute = path.match(/^\/(verify|reset-password)\/([^/]+)\/?$/)
  if (accountRoute) return <AccountLink key={path} kind={accountRoute[1] as 'verify' | 'reset-password'} token={accountRoute[2]} />

  return <>
    <div className="sr-only" role="status" aria-atomic="true">{(nearby.active || area) && !status.error ? status.text : ''}</div>
    <div className="sr-only" role="alert" aria-atomic="true">{(nearby.active || area) && status.error ? status.text : ''}</div>
    <Header theme={theme} toggleTheme={toggleTheme} user={user} auth={auth} setAuth={setAuth} home={() => select(null)} accountRef={accountRef} />
    {auth && <AuthPanel initialRecovery={initialRecovery} onClose={closeAuth} onSignedIn={closeAuth} />}
    <main className="workspace">
      <aside className={`sidebar ${mobileMap ? 'mobile-hidden' : ''}`}>
        {selected ? <FacilityDetail key={selected} id={selected} mapped={snapshot ? snapshot.points.some(p => p.id === selected) : undefined} coordinates={snapshot ? snapshot.points.find(p => p.id === selected)?.coordinates ?? null : undefined} origin={nearby.origin} retryMap={!snapshot && !pointsLoading ? retryPoints : null} nearby={nearby.active} onClose={() => select(null)} user={user} detail={currentDetail?.detail ?? null} error={currentDetail?.error ?? ''} load={loadDetail} onSignIn={() => setAuth(true)} /> :
          <Directory area={!!area} leaveArea={leaveArea} query={query} setQuery={updateQuery} permit={permit} setPermit={setPermit} snapshot={snapshot} facilities={facilities} searchMessage={searchMessage} searching={searching} restoreId={restoreId} onRestored={onRestored} select={select} nearby={nearby} startNearby={startNearby} mapMessage={mapMessage} pointsLoading={pointsLoading} retryPoints={retryPoints} status={status} />}
      </aside>
      <div ref={mapRef} tabIndex={-1} className={`map-panel ${mobileMap ? '' : 'mobile-hidden'}`}>
        {mapMessage && (!nearby.active || (!!snapshot && mapSurface)) && <div className="map-notices"><p className="map-message" role="status">{mapMessage}</p></div>}
        {showMapStatus && <div className="map-message nearby-map-status">
          <NearbyStatus status={status} />
          {!nearby.locating && !nearby.error && !snapshot && !pointsLoading && <button onClick={() => { mapNearRef.current?.focus(); retryPoints() }}>Retry map data</button>}
          {nearby.lookupError && <button onClick={() => { mapNearRef.current?.focus(); nearby.retry() }}>Try again</button>}
          <button onClick={() => { mapNearRef.current?.focus(); leaveArea() }}>All Georgia</button>
        </div>}
        <button ref={mapNearRef} className="map-near" onClick={nearby.locating ? nearby.exit : startNearby}><LocateFixed size={17} aria-hidden /> {nearby.locating ? 'Cancel locating' : 'Near me'}</button>
        <MapImportBoundary key={mapAttempt} onRetry={retryMapImport}><Suspense fallback={<div className="map-failure">Loading map…</div>}><LazyMapView selectedPoint={snapshot?.points.find(p => p.id === selected)} statewidePoints={points} fitPoints={fitPoints} ready={!!snapshot} origin={nearby.origin} nearby={nearby.active} selected={selected} onSelect={select} theme={theme} detail={currentDetail?.detail?.facility ?? null} detailError={!!currentDetail?.error} area={!!area} reset={reset} onArea={onArea} cancelKey={`${movementVersion}-${permit}-${mobileMap}-${selected}`} /></Suspense></MapImportBoundary>
      </div>
      <div className="mobile-switch" role="group" aria-label="View"><button aria-pressed={!mobileMap} onClick={() => setMobileMap(false)}>List</button><button aria-pressed={mobileMap} onClick={() => setMobileMap(true)}>Map</button></div>
    </main>
  </>
}
