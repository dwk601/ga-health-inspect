import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { aiUserId, getAIUsage, requestAI } from './api'
import type { AIUsage } from './types'

type AIContext = {
  userId: string; usage: AIUsage | null; allowed: boolean; reason: string; refreshing: boolean
  refresh: () => Promise<void>; signIn: () => void
  request: <T>(task: 'explain' | 'search', input: unknown, signal: AbortSignal) => Promise<T>
}
const Context = createContext<AIContext | null>(null)
type UsageState = { userId: string; usage: AIUsage | null; loading: boolean; unavailable: boolean }

function validUsage(usage: AIUsage) {
  return typeof usage.enabled === 'boolean' && Number.isInteger(usage.limit) && usage.limit >= 0 && usage.limit <= 100000 &&
    Number.isInteger(usage.used) && usage.used >= 0 && Number.isInteger(usage.remaining) && usage.remaining === Math.max(0, usage.limit - usage.used) &&
    typeof usage.resetsAt === 'string' && /T00:00:00Z$/.test(usage.resetsAt) && Number.isFinite(Date.parse(usage.resetsAt))
}

export function AIUsageProvider({ userId, onSignIn, children }: { userId: string; onSignIn: () => void; children: ReactNode }) {
  const [state, setState] = useState<UsageState>({ userId, usage: null, loading: !!userId, unavailable: false })
  const refreshController = useRef<AbortController | null>(null)
  const accept = useCallback((incoming: AIUsage) => {
    if (aiUserId() !== userId || !validUsage(incoming)) return
    setState(previous => {
      const prior = previous.userId === userId ? previous.usage : null
      if (prior && prior.resetsAt > incoming.resetsAt) return previous
      // Reservations and GETs can finish out of order. Only a newer UTC window resets usage.
      const used = prior?.resetsAt === incoming.resetsAt ? Math.max(prior.used, incoming.used) : incoming.used
      return { userId, usage: { ...incoming, used, remaining: Math.max(0, incoming.limit - used) }, loading: false, unavailable: false }
    })
  }, [userId])
  const refresh = useCallback(async () => {
    if (!userId || aiUserId() !== userId) return
    refreshController.current?.abort()
    const controller = new AbortController(); refreshController.current = controller
    setState(previous => previous.userId === userId ? { ...previous, loading: true } : { userId, usage: null, loading: true, unavailable: false })
    try {
      const usage = await getAIUsage(userId, controller.signal)
      if (!validUsage(usage)) throw new Error('Invalid AI usage')
      if (!controller.signal.aborted) accept(usage)
    } catch {
      if (!controller.signal.aborted && aiUserId() === userId) setState(previous => ({ ...previous, userId, loading: false, unavailable: true }))
    }
  }, [userId, accept])
  useEffect(() => {
    setState({ userId, usage: null, loading: !!userId, unavailable: false })
    if (!userId) return
    void refresh()
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => { refreshController.current?.abort(); window.removeEventListener('focus', onFocus) }
  }, [userId, refresh])
  const usage = state.userId === userId ? state.usage : null
  useEffect(() => {
    if (!userId || !usage) return
    const timer = setTimeout(() => { void refresh() }, Math.max(100, Date.parse(usage.resetsAt) - Date.now() + 100))
    return () => clearTimeout(timer)
  }, [userId, usage?.resetsAt, refresh])
  const expired = !!usage && Date.parse(usage.resetsAt) <= Date.now()
  const reason = !usage || expired || state.unavailable
    ? state.loading ? 'Checking your AI usage…' : 'AI usage is unavailable. Refresh to use AI.'
    : !usage.enabled ? 'AI is not enabled. Original records and manual search remain available.'
      : usage.remaining === 0 ? 'You have used your daily AI requests. Your allowance resets at midnight UTC.' : ''
  const allowed = !!userId && !!usage && !expired && !state.unavailable && usage.enabled && usage.remaining > 0
  async function request<T>(task: 'explain' | 'search', input: unknown, signal: AbortSignal) {
    if (!allowed) throw new Error(reason || 'Sign in to use AI.')
    try { return await requestAI<T>(task, input, signal, userId, accept) }
    finally { void refresh() } // Even a cancelled or failed accepted request may have consumed a slot.
  }
  return <Context.Provider value={{ userId, usage, allowed, reason, refreshing: state.loading, refresh, signIn: onSignIn, request }}>{children}</Context.Provider>
}

export function useAI() {
  const context = useContext(Context)
  if (!context) throw new Error('AI usage provider is missing')
  return context
}

export function AIUsageControl() {
  const ai = useAI()
  if (!ai.userId) return <button type="button" onClick={ai.signIn}>Sign in to use AI</button>
  return <>
    <p className="muted" role="status">{ai.usage && <>{ai.usage.remaining} of {ai.usage.limit} AI requests remaining. Resets at <time dateTime={ai.usage.resetsAt}>midnight UTC</time>. </>}{ai.reason}</p>
    <button type="button" disabled={ai.refreshing} onClick={() => void ai.refresh()}>{ai.refreshing ? 'Refreshing AI usage…' : 'Refresh AI usage'}</button>
  </>
}
