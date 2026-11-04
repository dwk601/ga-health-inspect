import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import type { RecordModel } from 'pocketbase'
import { MapPinned, Moon, Sun } from 'lucide-react'
import { pb, getPoints, getDetail, search, refreshAuth } from './api'
import { MapFailure } from './MapFailure'
import { FacilityList } from './FacilityList'
import { FacilityDetail } from './FacilityDetail'
import { AuthPanel } from './AuthPanel'
import { AccountLink } from './AccountLink'
import type { Detail, Facility, Snapshot } from './types'

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

function useInspectionData(query: string, permit: string) {
  const [facilities, setFacilities] = useState<Facility[]>([])
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [mapMessage, setMapMessage] = useState('')
  const [searchMessage, setSearchMessage] = useState('')

  useEffect(() => {
    getPoints().then(({ snapshot: data, stale }) => {
      setSnapshot(data)
      const generated = data.generatedAt && !Number.isNaN(Date.parse(data.generatedAt)) ? ` from ${new Date(data.generatedAt).toLocaleString()}` : ''
      setMapMessage(stale ? `Showing an older map snapshot${generated} because the inspection source is unavailable.` : '')
    }).catch(error => setMapMessage(error.message))
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      search(query, permit, controller.signal).then(data => {
        setFacilities(data.facilities)
        setSearchMessage('')
      }).catch(error => { if (error.name !== 'AbortError') setSearchMessage(error.message) })
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, permit])

  const points = useMemo(() => (snapshot?.points || []).filter(p => !permit || p.permitType === permit), [snapshot, permit])
  return { facilities, snapshot, points, mapMessage, searchMessage }
}

function Header({ theme, toggleTheme, user, auth, setAuth, home, accountRef }: {
  theme: 'light' | 'dark'; toggleTheme: () => void; user: RecordModel | null
  auth: boolean; setAuth: (value: boolean) => void; home: () => void; accountRef: React.RefObject<HTMLButtonElement | null>
}) {
  return <header className="topbar">
    <a href="/" className="brand" onClick={e => { e.preventDefault(); home() }}>
      <span className="brand-icon"><MapPinned size={21} /></span>
      <span>Georgia <b>Inspection Map</b><small>Explore local health inspections</small></span>
    </a>
    <div className="header-actions">
      <button className="icon-button" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>{theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}</button>
      {user ? <><span className="user-name">{user.name}</span><button ref={accountRef} onClick={() => pb.authStore.clear()}>Sign out</button></> : <button onClick={() => setAuth(!auth)}>{auth ? 'Close' : 'Sign in'}</button>}
    </div>
  </header>
}

function Directory({ query, setQuery, permit, setPermit, snapshot, facilities, searchMessage, restoreId, select }: {
  query: string; setQuery: (value: string) => void; permit: string; setPermit: (value: string) => void
  snapshot: Snapshot | null; facilities: Facility[]; searchMessage: string; restoreId: string | null; select: (id: string) => void
}) {
  return <>
    <div className="search-header">
      <h1>Find a facility</h1><p>Explore inspection records across Georgia.</p>
      <label htmlFor="search">Search by name, address, or ID<input id="search" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search facilities" /></label>
      <label htmlFor="permit">Permit type<select id="permit" value={permit} onChange={e => setPermit(e.target.value)}><option value="">All permit types</option>{snapshot?.permitChoices.map(p => <option key={p}>{p}</option>)}</select></label>
    </div>
    <div className="results-heading"><strong>Facilities</strong><span>Up to 100 results</span></div>
    {searchMessage ? <p className="empty" role="status">{searchMessage}</p> : <FacilityList facilities={facilities} restoreId={restoreId} onSelect={select} />}
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
  const { facilities, snapshot, points, mapMessage, searchMessage } = useInspectionData(query, permit)
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
  const [mapAttempt, setMapAttempt] = useState(0)
  const [LazyMapView, setLazyMapView] = useState(createMapView)
  const mapRef = useRef<HTMLDivElement>(null)
  const accountRef = useRef<HTMLButtonElement>(null)
  const retryMapImport = () => { mapRef.current?.focus(); setLazyMapView(createMapView()); setMapAttempt(n => n + 1) }
  const signedIn = () => { setAuth(false); requestAnimationFrame(() => accountRef.current?.focus()) }
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
  useEffect(() => { document.documentElement.classList.toggle('dark', theme === 'dark'); document.documentElement.style.colorScheme = theme }, [theme])
  useEffect(() => {
    const handler = () => {
      setPath(location.pathname)
      const next = selectedFromURL()
      if (!next && selected) setRestoreId(selected)
      else if (next) setRestoreId(null)
      setSelected(next)
      if (next) setMobileMap(false)
    }
    addEventListener('popstate', handler)
    return () => removeEventListener('popstate', handler)
  }, [selected])

  function select(id: string | null) {
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
    <Header theme={theme} toggleTheme={toggleTheme} user={user} auth={auth} setAuth={setAuth} home={() => select(null)} accountRef={accountRef} />
    {auth && <AuthPanel initialRecovery={initialRecovery} onClose={() => setAuth(false)} onSignedIn={signedIn} />}
    <main className="workspace">
      <div className="mobile-switch"><button aria-pressed={!mobileMap} onClick={() => setMobileMap(false)}>List</button><button aria-pressed={mobileMap} onClick={() => setMobileMap(true)}>Map</button></div>
      <aside className={`sidebar ${mobileMap ? 'mobile-hidden' : ''}`}>
        {selected ? <FacilityDetail key={selected} id={selected} onClose={() => select(null)} user={user} detail={currentDetail?.detail ?? null} error={currentDetail?.error ?? ''} load={loadDetail} /> :
          <Directory query={query} setQuery={setQuery} permit={permit} setPermit={setPermit} snapshot={snapshot} facilities={facilities} searchMessage={searchMessage} restoreId={restoreId} select={select} />}
      </aside>
      <div ref={mapRef} tabIndex={-1} className={`map-panel ${mobileMap ? '' : 'mobile-hidden'}`}>
        {mapMessage && <p className="map-message" role="status">{mapMessage}</p>}
        <MapImportBoundary key={mapAttempt} onRetry={retryMapImport}><Suspense fallback={<div className="map-failure">Loading map…</div>}><LazyMapView points={points} selected={selected} onSelect={select} theme={theme} detail={currentDetail?.detail?.facility ?? null} detailError={!!currentDetail?.error} /></Suspense></MapImportBoundary>
      </div>
    </main>
  </>
}
