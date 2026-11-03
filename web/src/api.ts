import PocketBase from 'pocketbase'
import type { Detail, Facility, Snapshot } from './types'

export const pb = new PocketBase('/')
async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(response.status === 404 ? 'This facility could not be found.' : 'Inspection data is unavailable. Please try again.')
  return response.json() as Promise<T>
}
export async function getPoints(): Promise<{ snapshot: Snapshot; stale: boolean }> {
  const response = await fetch('/api/inspect/points')
  if (!response.ok) throw new Error('Map data is unavailable. You can still search the directory.')
  return { snapshot: await response.json() as Snapshot, stale: response.headers.get('X-Inspection-Stale') === 'true' }
}
export function search(q: string, permit: string, signal: AbortSignal) {
  return get<{ facilities: Facility[] }>(`/api/inspect/search?${new URLSearchParams({ q, permit })}`, signal)
}
export function getDetail(id: string) { return get<Detail>(`/api/inspect/facilities/${encodeURIComponent(id)}`) }
export function errorMessage(error: unknown, action: string): string {
  if (typeof error === 'object' && error && 'status' in error) {
    const status = error.status
    if (status === 403) return `Could not ${action}. Check your permissions and email verification.`
    if (status === 404) return `Could not ${action}. The service or record is unavailable.`
    if (status === 400) return `Could not ${action}. Check your entries and try again.`
  }
  return `Could not ${action}. Please try again.`
}
