import PocketBase, { BaseAuthStore, ClientResponseError } from 'pocketbase'
import type { AIUsage, Detail, Facility, Snapshot, SearchFilters } from './types'

export const pb = new PocketBase('/')

let pendingRefresh: Promise<void> | null = null
export function refreshAuth(): Promise<void> {
  if (!pb.authStore.token) return Promise.resolve()
  if (!pendingRefresh) {
    const token = pb.authStore.token
    const store = new BaseAuthStore()
    store.save(token, pb.authStore.record)
    const client = new PocketBase('/', store)
    pendingRefresh = client.collection('users').authRefresh().then(() => {
      if (pb.authStore.token === token) pb.authStore.save(store.token, store.record)
    }).catch((error: unknown) => {
      if (error instanceof ClientResponseError && [401, 403, 404].includes(error.status) && pb.authStore.token === token) pb.authStore.clear()
    }).finally(() => { pendingRefresh = null })
  }
  return pendingRefresh
}
async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(response.status === 404 ? 'This facility could not be found.' : 'Inspection data is unavailable. Please try again.')
  return response.json() as Promise<T>
}
export async function getPoints(): Promise<{ snapshot: Snapshot; stale: boolean }> {
  const response = await fetch('/api/inspect/points')
  if (!response.ok) throw new Error('Map data is unavailable. You can still search the directory.')
  const snapshot = await response.json() as Snapshot
  snapshot.generatedAt = response.headers.get('X-Inspection-Generated-At') || null
  return { snapshot, stale: response.headers.get('X-Inspection-Stale') === 'true' }
}
const searchCache = new Map<string, { expires: number; data: { facilities: Facility[] } }>()
const facilityCache = new Map<string, { expires: number; facility: Facility | null }>()

export async function search(q: string, permit: string, sort: string, signal: AbortSignal, filters?: SearchFilters, origin?: [number, number]) {
  const params = new URLSearchParams({ q, permit, sort, name: filters?.name ?? '', address: filters?.address ?? '', minScore: filters?.minScore ?? '', maxScore: filters?.maxScore ?? '' })
  const key = JSON.stringify([params.toString(), origin ?? null, origin ? filters?.radius || '25' : null])
  const cached = searchCache.get(key)
  if (cached && cached.expires > Date.now()) return cached.data
  let data: { facilities: Facility[] }
  if (origin) {
    const response = await fetch('/api/inspect/search/nearby', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify({ coordinates: origin, filters: { q, permit, sort, name: filters?.name ?? '', address: filters?.address ?? '', minScore: filters?.minScore ? Number(filters.minScore) : null, maxScore: filters?.maxScore ? Number(filters.maxScore) : null, radius: Number(filters?.radius || 25) } }) })
    if (!response.ok) throw new Error('Nearby search is unavailable. Check your filters or try again.')
    data = await response.json() as { facilities: Facility[] }
  } else data = await get<{ facilities: Facility[] }>(`/api/inspect/search?${params}`, signal)
  if (!signal.aborted) {
    searchCache.delete(key); searchCache.set(key, { expires: Date.now() + 300000, data })
    if (searchCache.size > 20) searchCache.delete(searchCache.keys().next().value!)
  }
  return data
}
const LOOKUP_BATCH = 20
async function lookupBatch(ids: string[], signal: AbortSignal) {
  const response = await fetch('/api/inspect/facilities/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }), signal })
  if (!response.ok) throw new Error('Place details unavailable')
  return (await response.json() as { facilities: Facility[] }).facilities
}
export function cachedFacilities(ids: string[]): Facility[] | null {
  const now = Date.now()
  if (ids.some(id => (facilityCache.get(id)?.expires ?? 0) <= now)) return null
  return ids.flatMap(id => { const facility = facilityCache.get(id)?.facility; return facility ? [facility] : [] })
}
export async function lookupFacilities(ids: string[], signal: AbortSignal) {
  const missing = ids.filter(id => (facilityCache.get(id)?.expires ?? 0) <= Date.now())
  if (missing.length) {
    const batches = []
    for (let start = 0; start < missing.length; start += LOOKUP_BATCH) batches.push(missing.slice(start, start + LOOKUP_BATCH))
    const facilities = (await Promise.all(batches.map(batch => lookupBatch(batch, signal)))).flat()
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const byId = new Map(facilities.map(f => [f.id, f]))
    for (const id of missing) {
      const facility = byId.get(id) ?? null
      facilityCache.delete(id); facilityCache.set(id, { facility, expires: Date.now() + (facility ? 300000 : 60000) })
      if (facilityCache.size > 2000) facilityCache.delete(facilityCache.keys().next().value!)
    }
  }
  return ids.flatMap(id => { const facility = facilityCache.get(id)?.facility; return facility ? [facility] : [] })
}
export function aiUserId(): string {
  return pb.authStore.token && pb.authStore.record?.collectionName === 'users' ? pb.authStore.record.id : ''
}

async function fetchAI<T>(path: 'usage' | 'explain' | 'search', userId: string, signal: AbortSignal, input?: unknown, onUsage?: (usage: AIUsage) => void): Promise<T> {
  let changed = false
  const unsubscribe = pb.authStore.onChange(() => { if (aiUserId() !== userId) changed = true })
  const checkSession = () => {
    if (changed || signal.aborted || !userId || aiUserId() !== userId) throw new DOMException('AI session changed', 'AbortError')
  }
  try {
    checkSession()
    const response = await fetch(`/api/inspect/ai/${path}`, {
      method: path === 'usage' ? 'GET' : 'POST', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json', Authorization: pb.authStore.token },
      body: input === undefined ? undefined : JSON.stringify(input),
    })
    checkSession()
    if (response.status === 401) {
      await refreshAuth()
      checkSession()
      throw new Error('Your session needs refreshing. Sign in again to use AI.')
    }
    if (response.status === 403) throw new Error('AI is available only to signed-in user accounts.')
    const data = await response.json().catch(() => ({})) as T & { error?: string }
    checkSession()
    const h = response.headers
    if (h.has('X-AI-Usage-Used')) onUsage?.({
      enabled: h.get('X-AI-Usage-Enabled') === 'true', limit: Number(h.get('X-AI-Usage-Limit')),
      used: Number(h.get('X-AI-Usage-Used')), remaining: Number(h.get('X-AI-Usage-Remaining')),
      resetsAt: h.get('X-AI-Usage-Resets-At') ?? '',
    })
    if (!response.ok) {
      const messages: Record<string, string> = {
        disabled: 'AI is not enabled. Original records and manual search remain available.',
        user_daily_limit: 'You have used your daily AI requests. Your allowance resets at midnight UTC.',
        quota: 'The service’s daily AI budget has been reached. Try again tomorrow.',
        quota_unavailable: 'AI usage is unavailable. Try again later.',
        busy: 'AI is busy. Try again shortly.',
        timeout: 'AI took too long. Try again or use the original records.',
        source_changed: 'The source record changed. Reload the page to review the updated record before asking AI again.',
        source_unavailable: path === 'search' ? 'Search data is unavailable. Try again later or use manual search.' : 'Complete source findings are unavailable for this inspection. Use the original report.',
        source_too_large: 'This record is too long for AI. Use the original report.',
      }
      throw new Error(messages[data.error ?? ''] ?? (response.status === 429 ? 'Too many AI requests. Please wait a minute.' : 'AI could not produce a supported answer. Original records remain available.'))
    }
    return data
  } finally { unsubscribe() }
}

export function getAIUsage(userId: string, signal: AbortSignal) { return fetchAI<AIUsage>('usage', userId, signal) }
export function requestAI<T>(task: 'explain' | 'search', input: unknown, signal: AbortSignal, userId: string, onUsage: (usage: AIUsage) => void) {
  return fetchAI<T>(task, userId, signal, input, onUsage)
}
export function getDetail(id: string, signal?: AbortSignal) { return get<Detail>(`/api/inspect/facilities/${encodeURIComponent(id)}`, signal) }
export function errorMessage(error: unknown, action: string, restrictedRecord = false, contributionWrite = false): string {
  if (typeof error === 'object' && error && 'status' in error) {
    const status = error.status
    if (status === 429) return 'Too many requests. Please wait a moment and try again.'
    if (status === 503 && contributionWrite) return 'Inspection data is temporarily unavailable; posting is paused.'
    if (status === 403) return `Could not ${action}. Check your permissions and email verification.`
    if (status === 404) return restrictedRecord ? `Could not ${action}: not allowed or no longer exists.` : `Could not ${action}. The service or record is unavailable.`
    if (status === 400) {
      if (contributionWrite && error instanceof ClientResponseError) {
        const fields = error.response?.data as Record<string, { code?: string }> | undefined
        const messages: Record<string, string> = {
          location_required: 'A valid current location is required to rate.',
          location_inaccurate: 'Your location is not accurate enough. Try again with location enabled.',
          location_too_far: 'You must be at the facility to rate it.',
          location_unmapped: 'This facility has no map location, so ratings are unavailable.',
        }
        for (const field of Object.values(fields ?? {})) if (field?.code && messages[field.code]) return messages[field.code]
      }
      return `Could not ${action}. Check your entries and try again.`
    }
  }
  return `Could not ${action}. Please try again.`
}
