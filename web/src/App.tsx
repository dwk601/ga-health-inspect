import { useEffect, useMemo, useState } from 'react'
import type { RecordModel } from 'pocketbase'
import { MapPinned, Moon, Sun } from 'lucide-react'
import { pb, getPoints, search } from './api'
import { MapView } from './MapView'
import { FacilityList } from './FacilityList'
import { FacilityDetail } from './FacilityDetail'
import { AuthPanel } from './AuthPanel'
import type { Facility, Snapshot } from './types'

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
      if (stale) setMapMessage(`Showing an older map snapshot from ${new Date(data.generatedAt).toLocaleString()} because the inspection source is unavailable.`)
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

function Header({ theme, toggleTheme, user, auth, setAuth, home }: {
  theme: 'light' | 'dark'; toggleTheme: () => void; user: RecordModel | null
  auth: boolean; setAuth: (value: boolean) => void; home: () => void
}) {
  return <header className="topbar">
    <a href="/" className="brand" onClick={e => { e.preventDefault(); home() }}>
      <span className="brand-icon"><MapPinned size={21} /></span>
      <span>Georgia <b>Inspection Map</b><small>Explore local health inspections</small></span>
    </a>
    <div className="header-actions">
      <button className="icon-button" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>{theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}</button>
      {user ? <><span className="user-name">{user.name}</span><button onClick={() => pb.authStore.clear()}>Sign out</button></> : <button onClick={() => setAuth(!auth)}>{auth ? 'Close' : 'Sign in'}</button>}
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
  const [selected, setSelected] = useState<string | null>(selectedFromURL)
  const [restoreId, setRestoreId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [permit, setPermit] = useState('')
  const { facilities, snapshot, points, mapMessage, searchMessage } = useInspectionData(query, permit)
  const [user, setUser] = useState<RecordModel | null>(pb.authStore.record)
  const [auth, setAuth] = useState(false)
  const [mobileMap, setMobileMap] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const stored = localStorage.getItem('theme')
    return stored === 'light' || stored === 'dark' ? stored : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  useEffect(() => pb.authStore.onChange(() => setUser(pb.authStore.record)), [])
  useEffect(() => { document.documentElement.classList.toggle('dark', theme === 'dark'); document.documentElement.style.colorScheme = theme }, [theme])
  useEffect(() => {
    const handler = () => setSelected(selectedFromURL())
    addEventListener('popstate', handler)
    return () => removeEventListener('popstate', handler)
  }, [])

  function select(id: string | null) {
    setRestoreId(id ? null : selected)
    history.pushState(null, '', id ? `/facilities/${encodeURIComponent(id)}` : '/')
    setSelected(id)
    if (id) setMobileMap(false)
  }
  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('theme', next)
  }
  return <>
    <Header theme={theme} toggleTheme={toggleTheme} user={user} auth={auth} setAuth={setAuth} home={() => select(null)} />
    {auth && <AuthPanel onClose={() => setAuth(false)} />}
    <main className="workspace">
      <div className="mobile-switch"><button aria-pressed={!mobileMap} onClick={() => setMobileMap(false)}>List</button><button aria-pressed={mobileMap} onClick={() => setMobileMap(true)}>Map</button></div>
      <aside className={`sidebar ${mobileMap ? 'mobile-hidden' : ''}`}>
        {selected ? <FacilityDetail key={selected} id={selected} onClose={() => select(null)} user={user} /> :
          <Directory query={query} setQuery={setQuery} permit={permit} setPermit={setPermit} snapshot={snapshot} facilities={facilities} searchMessage={searchMessage} restoreId={restoreId} select={select} />}
      </aside>
      <section className={`map-panel ${mobileMap ? '' : 'mobile-hidden'}`} aria-label="Facility map">
        {mapMessage && <p className="map-message" role="status">{mapMessage}</p>}
        <MapView points={points} selected={selected} onSelect={select} theme={theme} />
      </section>
    </main>
  </>
}
