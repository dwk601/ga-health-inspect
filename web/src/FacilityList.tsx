import { useLayoutEffect, useRef } from 'react'
import { ChevronRight } from 'lucide-react'
import { formatDate } from './format'
import { facilityTitle, facilityLabel, officialName } from './facilityName'
import type { Facility, ComparisonSelection } from './types'

export function FacilityList({ facilities, restoreId, onRestored, onSelect, distances, comparison }: { comparison: ComparisonSelection; facilities: Facility[]; restoreId: string | null; onRestored: () => void; onSelect: (id: string) => void; distances?: Map<string, number> }) {
  const restoreRow = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    if (restoreId) {
      (restoreRow.current ?? document.querySelector<HTMLInputElement>('#search'))?.focus()
      onRestored()
    }
  }, [restoreId, onRestored])

  if (!facilities.length) return <p className="empty">No facilities match. Try a shorter name, a street or city, or all permit types.</p>
  return <ul className="facility-list">{facilities.map(f => {
    const inspected = formatDate(f.lastInspectionDate)
    const distance = distances?.get(f.id)
    return <li key={f.id} className="facility-list-entry"><button ref={f.id === restoreId ? restoreRow : undefined} className="facility-row" onClick={() => onSelect(f.id)}>
      <span className="facility-main">
        <strong>{facilityTitle(f)}</strong>
        {officialName(f) && <small>Listed as {officialName(f)}</small>}
        {distance !== undefined && <small className="distance">{distance < 0.1 ? '<0.1' : distance.toFixed(1)} mi away</small>}
        <small>{[f.permitType, f.address || 'Address unavailable'].filter(Boolean).join(' · ')}</small>
        <small>{inspected ? `Inspected ${inspected}` : 'No inspection date'}</small>
      </span>
      <span className="score"><small>Inspection score</small><strong>{f.lastInspectionScore ?? <><span aria-hidden>—</span><span className="sr-only">unavailable</span></>}</strong></span>
      <ChevronRight className="row-chevron" size={18} aria-hidden />
    </button><label className="compare-choice"><input type="checkbox" checked={comparison.ids.includes(f.id)} disabled={comparison.ids.length >= 3 && !comparison.ids.includes(f.id)} onChange={() => comparison.toggle(f.id)} /><span>Compare<span className="sr-only"> {facilityLabel(f)}</span></span></label></li>
  })}</ul>
}
