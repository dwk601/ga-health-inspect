import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cachedFacilities, lookupFacilities } from './api'
import { distanceMiles, geolocationFailureMessage, type LocationFix } from './geolocation'
import type { Facility, MapArea, Point, Snapshot } from './types'

export type Origin = LocationFix & { sequence: number }
type Candidate = { point: Point; distance: number }


export function useNearby(snapshot: Snapshot | null, permit: string, area: MapArea | null) {
  const [active, setActive] = useState(false)
  const [origin, setOrigin] = useState<Origin | null>(null)
  const [locating, setLocating] = useState(false)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const candidates = useMemo<Candidate[]>(() => {
    if (!origin || !snapshot) return []
    return snapshot.points.filter(p => !permit || p.permitType === permit)
      .map(point => ({ point, distance: distanceMiles(origin.coordinates, point.coordinates) }))
      .filter(item => item.distance <= 25)
      .sort((a, b) => a.distance - b.distance || (a.point.id < b.point.id ? -1 : a.point.id > b.point.id ? 1 : 0)).slice(0, 20)
  }, [origin, snapshot, permit])
  const areaCandidates = useMemo(() => {
    if (!area || !snapshot) return []
    const [[west, south], [east, north]] = area.bounds
    return snapshot.points.filter(p => (!permit || p.permitType === permit) && p.coordinates[0] >= west && p.coordinates[0] <= east && p.coordinates[1] >= south && p.coordinates[1] <= north)
      .map(point => ({ point, distance: distanceMiles(area.center, point.coordinates) }))
      .sort((a, b) => a.distance - b.distance || a.point.id.localeCompare(b.point.id))
  }, [area, snapshot, permit])
  const listCandidates = area ? areaCandidates.slice(0, 20) : candidates
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
  const ids = new Set(lookup.facilities.map(f => f.id))
  return {
    active, origin, locating, error, candidates: listCandidates, fitCandidates: candidates, areaCount: areaCandidates.length, canLocate: window.isSecureContext && !!navigator.geolocation,
    points: listCandidates.filter(c => ids.has(c.point.id)).map(c => c.point),
    distances: new Map(origin ? listCandidates.map(c => [c.point.id, distanceMiles(origin.coordinates, c.point.coordinates)]) : []),
    ...lookup,
    locate, exit,
  }
}

function useFacilityLookup(candidates: Candidate[], enabled: boolean) {
  const [lookup, setLookup] = useState<{ key: string; facilities: Facility[]; error: string } | null>(null)
  const [retryVersion, setRetryVersion] = useState(0)
  const key = JSON.stringify(candidates.map(c => c.point.id))
  useEffect(() => {
    if (!enabled || key === '[]' || cachedFacilities(JSON.parse(key) as string[]) !== null) return
    const controller = new AbortController()
    lookupFacilities(JSON.parse(key) as string[], controller.signal).then(facilities => {
      if (!controller.signal.aborted) setLookup({ key, facilities, error: '' })
    }).catch(() => { if (!controller.signal.aborted) setLookup({ key, facilities: [], error: 'Place details are unavailable. Try again.' }) })
    return () => controller.abort()
  }, [enabled, key, retryVersion])
  const cached = enabled ? cachedFacilities(candidates.map(c => c.point.id)) : null
  const current = cached !== null ? { facilities: cached, error: '' } : lookup?.key === key ? lookup : null
  return { facilities: current?.facilities ?? [], loading: enabled && !!candidates.length && !current, lookupError: current?.error ?? '', missing: current && !current.error ? candidates.length - current.facilities.length : 0, retry: () => { setLookup(null); setRetryVersion(v => v + 1) } }
}
