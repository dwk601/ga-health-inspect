import { useEffect, useState } from 'react'
import { getDetail } from './api'
import { facilityTitle, facilityLabel } from './facilityName'
import { formatDate } from './format'
import { FindingsStatus, safeLink } from './FacilityDetail'
import { InspectionExplanation } from './InspectionExplanation'
import type { Detail } from './types'

type ComparisonItem = { id: string; detail: Detail | null; error: string }

export function useComparison(ids: string[]) {
  const key = JSON.stringify(ids)
  const [version, setVersion] = useState(0)
  const [state, setState] = useState<{ key: string; items: ComparisonItem[] } | null>(null)
  useEffect(() => {
    if (key === '[]') return
    const controller = new AbortController()
    const selected = JSON.parse(key) as string[]
    // URL parsing and selection both cap this at three unique public records.
    void Promise.all(selected.map(async id => {
      try { return { id, detail: await getDetail(id, controller.signal), error: '' } }
      catch (error) { return { id, detail: null, error: (error as Error).message } }
    })).then(items => { if (!controller.signal.aborted) setState({ key, items }) })
    return () => controller.abort()
  }, [key, version])
  return { items: state?.key === key ? state.items : ids.map(id => ({ id, detail: null, error: '' })), retry: () => { setState(null); setVersion(value => value + 1) } }
}

export function ComparisonTray({ ids, items, names, onRemove, onClear, onView }: {
  ids: string[]; items: ComparisonItem[]; names: Map<string, string>; onRemove: (id: string) => void; onClear: () => void; onView: () => void
}) {
  if (!ids.length) return null
  return <section className="comparison-tray" aria-label="Selected places for comparison">
    <h2 id="comparison-selection-title" tabIndex={-1}>Compare places ({ids.length}/3)</h2>
    <ul role="list">{ids.map((id, index) => {
      const detail = items.find(item => item.id === id)?.detail
      const name = detail ? facilityLabel(detail.facility) : names.get(id) || `Place ${index + 1}`
      return <li key={id}><span>{name}</span><button type="button" aria-label={`Remove ${name} from comparison`} onClick={() => onRemove(id)}>Remove</button></li>
    })}</ul>
    <div className="ai-actions">{ids.length >= 2 ? <button type="button" id="comparison-view-action" onClick={onView}>View comparison</button> : <p className="muted">Choose one or two more places from the list or a facility page.</p>}<button type="button" onClick={onClear}>Clear comparison</button>{ids.length >= 2 && <a href={`/?${new URLSearchParams({ compare: ids.join(',') })}`}>Shareable comparison link</a>}</div>
  </section>
}

export function FacilityCompare({ items, retry, onRemove, onClear }: { items: ComparisonItem[]; retry: () => void; onRemove: (id: string) => void; onClear: () => void }) {
  const loaded = items.every(item => item.detail)
  const selections = items.flatMap(item => {
    const inspection = item.detail?.inspections[0]
    return inspection ? [{ facilityId: item.id, inspectionId: inspection.id, contentHash: inspection.contentHash }] : []
  })
  const eligible = loaded && selections.length === items.length && items.every(item => {
    const inspection = item.detail?.inspections[0]
    return inspection?.evidence.findingsStatus === 'available' && inspection.violations.length > 0
  })
  return <section className="comparison" aria-labelledby="comparison-title">
    <header><button type="button" onClick={onClear}>Clear comparison & show map</button><h2 id="comparison-title" tabIndex={-1}>Inspection comparison</h2><p>Latest recorded inspection for each place. Scores may use different permit scales; this is not a ranking or an assessment of current safety.</p></header>
    <div className="comparison-grid">{items.map((item, index) => {
      const detail = item.detail
      if (!detail) return <article key={item.id}><h3>Place {index + 1}</h3>{item.error ? <><p role="status">{item.error}</p><button type="button" onClick={retry}>Reload records</button><button type="button" onClick={() => onRemove(item.id)}>Remove missing place</button></> : <p>Loading inspection…</p>}</article>
      const inspection = detail.inspections[0]
      const report = safeLink(inspection?.printableUrl ?? null)
      return <article key={item.id}>
        <h3>{facilityTitle(detail.facility)}</h3><p className="muted">{detail.facility.address || 'Address unavailable'}</p>
        <button type="button" onClick={() => onRemove(item.id)} aria-label={`Remove ${facilityLabel(detail.facility)} from comparison`}>Remove</button>
        <dl>
          <div><dt>Permit type</dt><dd>{detail.facility.permitType || 'Unavailable'}</dd></div>
          <div><dt>Inspection score</dt><dd className="comparison-score">{inspection?.score ?? 'Unavailable'}</dd></div>
          <div><dt>Inspection date</dt><dd>{formatDate(inspection?.inspectionDate ?? null) || 'Unavailable'}</dd></div>
          <div><dt>Purpose</dt><dd>{inspection?.purpose || 'Unavailable'}</dd></div>
        </dl>
        <h4>Findings from this inspection</h4>
        {inspection ? <><FindingsStatus inspection={inspection} /><ul>{inspection.violations.map(finding => <li key={finding.sourceKey}><strong>{finding.codeTitle || finding.regulation || 'Finding'}</strong>{finding.notes && <p>{finding.notes}</p>}{finding.corrected === true && <p>Corrected during inspection</p>}{finding.repeat === true && <p>Repeat finding</p>}</li>)}</ul>{report && <a href={report} target="_blank" rel="noreferrer">Original inspection report for {facilityTitle(detail.facility)}</a>}</> : <p>No inspection records available.</p>}
        <div className="comparison-visitors"><h4>Visitor experience · 1–5</h4><p>{detail.community.ratingAverage == null ? 'No average yet' : `${detail.community.ratingAverage.toFixed(1)} average`} · {detail.community.ratingCount} {detail.community.ratingCount === 1 ? 'rating' : 'ratings'}</p><p className="muted">Visitor ratings are separate from inspection scores.</p></div>
      </article>
    })}</div>
    {eligible ? <InspectionExplanation key={JSON.stringify(selections)} selections={selections} task="compare" /> : <p className="muted">AI differences are available only when all selected inspections have confirmed, non-empty findings. The records above remain usable without AI.</p>}
  </section>
}
