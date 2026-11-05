import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cachedFacilities, lookupFacilities } from './api'
import { distanceMiles, geolocationFailureMessage, type LocationFix } from './geolocation'
import type { Facility, MapArea, Point, Snapshot } from './types'

export type Origin = LocationFix & { sequence: number }
type Candidate = { point: Point; distance: number }
export const LIST_LIMIT = 20

function inBounds(point: Point, area: MapArea) {
  const [[west, south], [east, north]] = area.bounds
  return point.coordinates[0] >= west && point.coordinates[0] <= east && point.coordinates[1] >= south && point.coordinates[1] <= north
}

// Picks up to `limit` places spread over the visible map: a grid splits the view into cells,
// and each round takes the next place nearest each cell's centre, central cells first.
function spreadAcross(area: MapArea, points: Point[], limit: number) {
  const [[west, south], [east, north]] = area.bounds
  const lonSpan = east - west
  const latSpan = north - south
  const aspect = lonSpan * Math.cos(area.center[1] * Math.PI / 180) / latSpan
  const columns = Math.max(1, Math.min(LIST_LIMIT, Math.round(Math.sqrt(LIST_LIMIT * aspect))))
  const rows = Math.max(1, Math.floor(LIST_LIMIT / columns))
  const cells = new Map<number, { center: [number, number]; places: { point: Point; offset: number }[] }>()
  for (const point of points) {
    const column = Math.min(columns - 1, Math.floor((point.coordinates[0] - west) / lonSpan * columns))
    const row = Math.min(rows - 1, Math.floor((north - point.coordinates[1]) / latSpan * rows))
    const index = row * columns + column
    let cell = cells.get(index)
    if (!cell) {
      cell = { center: [west + (column + 0.5) * lonSpan / columns, north - (row + 0.5) * latSpan / rows], places: [] }
      cells.set(index, cell)
    }
    cell.places.push({ point, offset: distanceMiles(cell.center, point.coordinates) })
  }
  const ordered = [...cells.values()].sort((a, b) => distanceMiles(area.center, a.center) - distanceMiles(area.center, b.center))
  for (const cell of ordered) cell.places.sort((a, b) => a.offset - b.offset || a.point.id.localeCompare(b.point.id))
  const picked: Point[] = []
  for (let round = 0; picked.length < limit && picked.length < points.length; round++) {
    for (const cell of ordered) if (round < cell.places.length && picked.length < limit) picked.push(cell.places[round].point)
  }
  return picked
}

function byDistance(from: [number, number], points: Point[]): Candidate[] {
  return points.map(point => ({ point, distance: distanceMiles(from, point.coordinates) }))
    .sort((a, b) => a.distance - b.distance || a.point.id.localeCompare(b.point.id))
}


export function useNearby(snapshot: Snapshot | null, permit: string, area: MapArea | null) {
  const [active, setActive] = useState(false)
  const [origin, setOrigin] = useState<Origin | null>(null)
  const [locating, setLocating] = useState(false)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const permitChoices = useMemo(() => {
    if (!snapshot) return []
    const local = snapshot.points.filter(p => {
      if (area) return inBounds(p, area)
      return !!origin && distanceMiles(origin.coordinates, p.coordinates) <= 25
    })
    return [...new Set(local.flatMap(p => p.permitType ? [p.permitType] : []))].sort()
  }, [snapshot, area, origin])
  const candidates = useMemo<Candidate[]>(() => {
    if (!origin || !snapshot) return []
    return snapshot.points.filter(p => !permit || p.permitType === permit)
      .map(point => ({ point, distance: distanceMiles(origin.coordinates, point.coordinates) }))
      .filter(item => item.distance <= 25)
      .sort((a, b) => a.distance - b.distance || (a.point.id < b.point.id ? -1 : a.point.id > b.point.id ? 1 : 0)).slice(0, LIST_LIMIT)
  }, [origin, snapshot, permit])
  const areaPoints = useMemo(() => {
    if (!area || !snapshot) return []
    return snapshot.points.filter(p => (!permit || p.permitType === permit) && inBounds(p, area))
  }, [area, snapshot, permit])
  const areaKey = JSON.stringify([area, permit])
  const [more, setMore] = useState({ key: '', limit: LIST_LIMIT })
  const areaLimit = more.key === areaKey ? more.limit : LIST_LIMIT
  const showMore = useCallback(() => setMore({ key: areaKey, limit: areaLimit + LIST_LIMIT }), [areaKey, areaLimit])
  const areaCandidates = useMemo(() => {
    if (!area) return []
    const from = origin?.coordinates ?? area.center
    const picked = spreadAcross(area, areaPoints, areaLimit)
    const pages: Candidate[] = []
    for (let start = 0; start < picked.length; start += LIST_LIMIT) pages.push(...byDistance(from, picked.slice(start, start + LIST_LIMIT)))
    return pages
  }, [area, areaPoints, origin, areaLimit])
  const listCandidates = area ? areaCandidates : candidates
  const lookup = useFacilityLookup(listCandidates, !!snapshot && (active && !!origin || !!area))
  const exit = useCallback(() => { sequence.current++; setActive(false); setLocating(false); setOrigin(null); setError('') }, [])
  const locate = useCallback(() => {
    const current = ++sequence.current
    setActive(true); setLocating(true); setOrigin(null); setError('')
    if (!window.isSecureContext || !navigator.geolocation) {
      setLocating(false); setError(!window.isSecureContext ? 'Location requires a secure connection. Open this site over HTTPS or browse all Georgia.' : 'This browser does not support location. Browse all Georgia instead.')
      return
    }
    navigator.geolocation.getCurrentPosition(position => {
      if (sequence.current !== current) return
      setOrigin({ coordinates: [position.coords.longitude, position.coords.latitude], accuracy: position.coords.accuracy, timestamp: Date.now(), sequence: current }); setLocating(false)
    }, failure => {
      if (sequence.current !== current) return
      setLocating(false)
      setError(geolocationFailureMessage(failure.code))
    }, { maximumAge: 0, timeout: 10000, enableHighAccuracy: false })
  }, [])
  useEffect(() => () => { sequence.current++ }, [])
  return {
    active, origin, locating, error, permitChoices, candidates: listCandidates, fitCandidates: candidates, areaCount: areaPoints.length, showMore, canLocate: window.isSecureContext && !!navigator.geolocation,
    distances: new Map(origin ? listCandidates.map(c => [c.point.id, distanceMiles(origin.coordinates, c.point.coordinates)]) : []),
    ...lookup,
    locate, exit,
  }
}

function useFacilityLookup(candidates: Candidate[], enabled: boolean) {
  const [lookup, setLookup] = useState<{ key: string; facilities: Facility[]; error: string } | null>(null)
  const [retryVersion, setRetryVersion] = useState(0)
  const key = JSON.stringify(candidates.map(c => c.point.id))
  const cached = useMemo(() => enabled ? cachedFacilities(JSON.parse(key) as string[]) : null, [enabled, key])
  useEffect(() => {
    if (!enabled || key === '[]' || cached !== null) return
    const controller = new AbortController()
    lookupFacilities(JSON.parse(key) as string[], controller.signal).then(facilities => {
      if (!controller.signal.aborted) setLookup({ key, facilities, error: '' })
    }).catch(() => { if (!controller.signal.aborted) setLookup({ key, facilities: [], error: 'Place details are unavailable. Try again.' }) })
    return () => controller.abort()
  }, [enabled, key, retryVersion, cached])
  const current = cached !== null ? { facilities: cached, error: '' } : lookup?.key === key ? lookup : null
  const settled = useRef<{ ids: string[]; facilities: Facility[] } | null>(null)
  if (current && !current.error) settled.current = { ids: candidates.map(c => c.point.id), facilities: current.facilities }
  const previous = settled.current
  const loadingMore = enabled && !current && !!previous?.ids.length && previous.ids.length < candidates.length && previous.ids.every((id, i) => candidates[i]?.point.id === id)
  if (loadingMore) return { facilities: previous.facilities, loading: false, loadingMore, lookupError: '', missing: 0, retry: () => {} }
  return { facilities: current?.facilities ?? [], loading: enabled && !!candidates.length && !current, loadingMore, lookupError: current?.error ?? '', missing: current && !current.error ? candidates.length - current.facilities.length : 0, retry: () => { setLookup(null); setRetryVersion(v => v + 1) } }
}
