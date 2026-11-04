import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import type { RecordModel } from 'pocketbase'
import { MapPinned, Moon, Search, Sun } from 'lucide-react'
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
  const [searching, setSearching] = useState(true)

  useEffect(() => {
    getPoints().then(({ snapshot: data, stale }) => {
      setSnapshot(data)
      const generated = data.generatedAt && !Number.isNaN(Date.parse(data.generatedAt)) ? ` from ${new Date(data.generatedAt).toLocaleString()}` : ''
      setMapMessage(stale ? `Showing an older map snapshot${generated} because the inspection source is unavailable.` : '')
    }).catch(error => setMapMessage(error.message))
  }, [])

  useEffect(() => {
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
  }, [query, permit])

  const points = useMemo(() => (snapshot?.points || []).filter(p => !permit || p.permitType === permit), [snapshot, permit])
  return { facilities, snapshot, points, mapMessage, searchMessage, searching }
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

function Directory({ query, setQuery, permit, setPermit, snapshot, facilities, searchMessage, searching, restoreId, select }: {
  query: string; setQuery: (value: string) => void; permit: string; setPermit: (value: string) => void
  snapshot: Snapshot | null; facilities: Facility[]; searchMessage: string; searching: boolean; restoreId: string | null; select: (id: string) => void
}) {
  return <>
    <div className="directory-head">
    <div className="search-header">
      <h1>Find a facility</h1>
      <div className="search-field">
        <Search size={18} aria-hidden />
        <input id="search" type="search" aria-label="Search by name, address, or ID" value={query} onChange={e => setQuery(e.target.value)} placeholder="Name, address, or permit ID" autoComplete="off" />
      </div>
      <select id="permit" aria-label="Permit type" value={permit} onChange={e => setPermit(e.target.value)}><option value="">All permit types</option>{snapshot?.permitChoices.map(p => <option key={p}>{p}</option>)}</select>
    </div>
    <div className="results-heading"><span role="status">{searchMessage ? 'Search unavailable' : resultSummary(facilities.length, searching)}</span><span aria-hidden>Inspection score</span></div>
    </div>
    {searchMessage ? <p className="empty" role="alert">{searchMessage}</p> : searching && !facilities.length ? null : <FacilityList facilities={facilities} restoreId={restoreId} onSelect={select} />}
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
  const { facilities, snapshot, points, mapMessage, searchMessage, searching } = useInspectionData(query, permit)
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
    {auth && <AuthPanel initialRecovery={initialRecovery} onClose={closeAuth} onSignedIn={closeAuth} />}
    <main className="workspace">
      <div className="mobile-switch" role="group" aria-label="View"><button aria-pressed={!mobileMap} onClick={() => setMobileMap(false)}>List</button><button aria-pressed={mobileMap} onClick={() => setMobileMap(true)}>Map</button></div>
      <aside className={`sidebar ${mobileMap ? 'mobile-hidden' : ''}`}>
        {selected ? <FacilityDetail key={selected} id={selected} onClose={() => select(null)} user={user} detail={currentDetail?.detail ?? null} error={currentDetail?.error ?? ''} load={loadDetail} onSignIn={() => setAuth(true)} /> :
          <Directory query={query} setQuery={setQuery} permit={permit} setPermit={setPermit} snapshot={snapshot} facilities={facilities} searchMessage={searchMessage} searching={searching} restoreId={restoreId} select={select} />}
      </aside>
      <div ref={mapRef} tabIndex={-1} className={`map-panel ${mobileMap ? '' : 'mobile-hidden'}`}>
        {mapMessage && <p className="map-message" role="status">{mapMessage}</p>}
        <MapImportBoundary key={mapAttempt} onRetry={retryMapImport}><Suspense fallback={<div className="map-failure">Loading map…</div>}><LazyMapView points={points} selected={selected} onSelect={select} theme={theme} detail={currentDetail?.detail?.facility ?? null} detailError={!!currentDetail?.error} /></Suspense></MapImportBoundary>
      </div>
    </main>
  </>
}
