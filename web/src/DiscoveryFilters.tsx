import { useEffect, useRef, useState } from 'react'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@ui-sdk/react/collapsible'
import { AIUsageControl, useAI } from './AIUsage'
import { aiUserId } from './api'
import type { SearchFilters, SearchIntent } from './types'

function NaturalLanguageSearch({ onIntent, cancelKey }: { onIntent: (intent: SearchIntent) => void; cancelKey: string }) {
  const ai = useAI()
  const [text, setText] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const currentKey = useRef(cancelKey); currentKey.current = cancelKey
  useEffect(() => { controller.current?.abort(); setBusy(false) }, [cancelKey])
  useEffect(() => () => controller.current?.abort(), [])
  function cancel() { controller.current?.abort(); setBusy(false) }
  async function interpret() {
    if (!ai.allowed) return
    cancel()
    const next = new AbortController(); controller.current = next
    const key = currentKey.current
    setBusy(true); setMessage('')
    try {
      const intent = await ai.request<SearchIntent>('search', { text }, next.signal)
      if (next.signal.aborted || currentKey.current !== key || aiUserId() !== ai.userId) return
      if (intent.clarification) setMessage(intent.clarification)
      else { onIntent(intent); setMessage('Filters applied. Review and edit them below.') }
    } catch (failure) { if (!next.signal.aborted && currentKey.current === key && aiUserId() === ai.userId) setMessage((failure as Error).message) }
    finally { if (!next.signal.aborted) setBusy(false) }
  }
  return <>
    <AIUsageControl />
    {ai.userId && <form aria-label="Natural-language search" onSubmit={event => { event.preventDefault(); void interpret() }}>
      <label htmlFor="ai-search">Describe your search</label>
      <p id="ai-search-help" className="muted">AI processes this text with the configured provider. Do not include personal information. Use names, addresses, permit types or numeric score ranges. Nearby search asks for location separately; coordinates are not sent to AI.</p>
      <textarea id="ai-search" name="text" required maxLength={1000} value={text} aria-describedby="ai-search-help" onChange={event => { cancel(); setText(event.target.value); setMessage('') }} placeholder="Restaurants on Peachtree with a score of at least 90" />
      <div className="ai-actions"><button type="submit" disabled={busy || !ai.allowed}>{busy ? 'Reading search…' : 'Create filters with AI'}</button>{busy && <button type="button" onClick={cancel}>Cancel</button>}</div>
    </form>}
    <p role="status">{message}</p>
  </>
}

export function DiscoveryFilters({ filters, onFilters, onIntent, nearby, cancelKey }: {
  filters: SearchFilters; onFilters: (filters: SearchFilters) => void; onIntent: (intent: SearchIntent) => void; nearby: boolean; cancelKey: string
}) {
  const ai = useAI()
  const [draft, setDraft] = useState(filters)
  const [cancelVersion, setCancelVersion] = useState(0)
  useEffect(() => { setDraft(filters) }, [filters])
  function cancel() { setCancelVersion(version => version + 1) }
  function change(field: keyof SearchFilters, value: string) { cancel(); setDraft({ ...draft, [field]: value }) }
  const active = [filters.name && `Name: ${filters.name}`, filters.address && `Address: ${filters.address}`, filters.minScore && `Score ≥ ${filters.minScore}`, filters.maxScore && `Score ≤ ${filters.maxScore}`, nearby && `Within ${filters.radius || 25} miles`].filter(Boolean)
  function clear() { cancel(); onFilters({ name: '', address: '', minScore: '', maxScore: '', radius: '25' }) }
  return <>
    {active.length > 0 && <div className="active-filters"><ul role="list" aria-label="Active extra filters">{active.map(label => <li key={String(label)}>{label}</li>)}</ul><button type="button" onClick={clear}>Clear extra filters</button></div>}
    <Collapsible className="discovery-filters">
    <CollapsibleTrigger>More filters & AI search</CollapsibleTrigger>
    <CollapsiblePanel keepMounted>
    <NaturalLanguageSearch key={ai.userId} onIntent={onIntent} cancelKey={JSON.stringify([cancelKey, cancelVersion])} />
    <form aria-label="Manual search filters" onSubmit={event => { event.preventDefault(); cancel(); onFilters(draft) }}>
      <label htmlFor="filter-name">Name contains</label><input id="filter-name" name="name" maxLength={200} value={draft.name} onChange={event => change('name', event.target.value)} />
      <label htmlFor="filter-address">Address contains</label><input id="filter-address" name="address" maxLength={200} value={draft.address} onChange={event => change('address', event.target.value)} />
      <div className="score-filters">
        <div><label htmlFor="min-score">Minimum score</label><input id="min-score" name="minScore" type="number" step="any" min={-10000} max={10000} value={draft.minScore} onChange={event => change('minScore', event.target.value)} /></div>
        <div><label htmlFor="max-score">Maximum score</label><input id="max-score" name="maxScore" type="number" step="any" min={draft.minScore || -10000} max={10000} value={draft.maxScore} onChange={event => change('maxScore', event.target.value)} /></div>
      </div>
      {nearby && <><label htmlFor="near-radius">Nearby radius (miles)</label><input id="near-radius" name="radius" type="number" min={1} max={100} step="any" required value={draft.radius} onChange={event => change('radius', event.target.value)} /></>}
      <p className="muted">Scores are source values, not visitor ratings. Different permit types may use different scales.</p>
      <div className="ai-actions"><button type="submit">Apply filters</button><button type="button" onClick={clear}>Clear extra filters</button></div>
    </form>
    </CollapsiblePanel>
  </Collapsible></>
}
