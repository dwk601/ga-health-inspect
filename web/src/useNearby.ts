import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { lookupFacilities } from './api'
import type { Facility, Point, Snapshot } from './types'

export type Origin = { coordinates: [number, number]; accuracy: number; sequence: number }
type Candidate = { point: Point; distance: number }

function distance(a: [number, number], b: [number, number]) {
  const radians = Math.PI / 180
  const lat = (b[1] - a[1]) * radians
  const lon = (b[0] - a[0]) * radians
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(lon / 2) ** 2
  return 3958.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

export function useNearby(snapshot: Snapshot | null, permit: string) {
  const [active, setActive] = useState(false)
  const [origin, setOrigin] = useState<Origin | null>(null)
  const [locating, setLocating] = useState(false)
  const [error, setError] = useState('')
  const [lookup, setLookup] = useState<{ key: string; facilities: Facility[]; error: string } | null>(null)
  const [retryVersion, setRetryVersion] = useState(0)
  const sequence = useRef(0)
  const candidates = useMemo<Candidate[]>(() => {
    if (!origin || !snapshot) return []
    return snapshot.points.filter(p => !permit || p.permitType === permit)
      .map(point => ({ point, distance: distance(origin.coordinates, point.coordinates) }))
      .filter(item => item.distance <= 25)
      .sort((a, b) => a.distance - b.distance || (a.point.id < b.point.id ? -1 : a.point.id > b.point.id ? 1 : 0)).slice(0, 20)
  }, [origin, snapshot, permit])
  const key = JSON.stringify(candidates.map(c => c.point.id))
  const canLookup = active && !!origin && !!snapshot
  useEffect(() => {
    if (!canLookup || key === '[]') return
    const controller = new AbortController()
    lookupFacilities(JSON.parse(key) as string[], controller.signal).then(facilities => {
      if (!controller.signal.aborted) setLookup({ key, facilities, error: '' })
    }).catch(() => { if (!controller.signal.aborted) setLookup({ key, facilities: [], error: 'Place details are unavailable. Try again.' }) })
    return () => controller.abort()
  }, [canLookup, key, retryVersion])
  const exit = useCallback(() => { sequence.current++; setActive(false); setLocating(false); setOrigin(null); setError('') }, [])
  const locate = useCallback(() => {
    const current = ++sequence.current
    setActive(true); setLocating(true); setOrigin(null); setError(''); setLookup(null)
    if (!window.isSecureContext || !navigator.geolocation) {
      setLocating(false); setError(!window.isSecureContext ? 'Location requires a secure connection. Open this site over HTTPS or browse all Georgia.' : 'This browser does not support location. Browse all Georgia instead.')
      return
    }
    navigator.geolocation.getCurrentPosition(position => {
      if (sequence.current !== current) return
      setOrigin({ coordinates: [position.coords.longitude, position.coords.latitude], accuracy: position.coords.accuracy, sequence: current }); setLocating(false)
    }, failure => {
      if (sequence.current !== current) return
      setLocating(false)
      setError(failure.code === 1 ? 'Location permission was denied. Enable location for this site in your browser settings and try again.' : failure.code === 3 ? 'Finding your location timed out. Try again.' : 'Your location is unavailable. Check your device location settings and try again.')
    }, { maximumAge: 0, timeout: 10000, enableHighAccuracy: false })
  }, [])
  useEffect(() => () => { sequence.current++ }, [])
  const current = lookup?.key === key ? lookup : null
  const facilities = current?.facilities ?? []
  const ids = new Set(facilities.map(f => f.id))
  return {
    active, origin, locating, error, candidates, facilities, canLocate: window.isSecureContext && !!navigator.geolocation,
    points: candidates.filter(c => ids.has(c.point.id)).map(c => c.point),
    distances: new Map(candidates.map(c => [c.point.id, c.distance])),
    loading: !!(active && origin && snapshot && candidates.length && !current),
    lookupError: current?.error ?? '',
    missing: current && !current.error ? candidates.length - facilities.length : 0,
    locate, exit,
    retry: () => { setLookup(null); setRetryVersion(v => v + 1) },
  }
}
