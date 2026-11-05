import PocketBase, { BaseAuthStore, ClientResponseError } from 'pocketbase'
import type { Detail, Facility, Snapshot } from './types'

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
export function search(q: string, permit: string, signal: AbortSignal) {
  return get<{ facilities: Facility[] }>(`/api/inspect/search?${new URLSearchParams({ q, permit })}`, signal)
}
export async function lookupFacilities(ids: string[], signal: AbortSignal) {
  const response = await fetch('/api/inspect/facilities/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }), signal })
  if (!response.ok) throw new Error('Place details unavailable')
  return (await response.json() as { facilities: Facility[] }).facilities
}
export function getDetail(id: string) { return get<Detail>(`/api/inspect/facilities/${encodeURIComponent(id)}`) }
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
