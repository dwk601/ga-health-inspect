import { useLayoutEffect, useRef } from 'react'
import { ChevronRight } from 'lucide-react'
import { formatDate } from './format'
import type { Facility } from './types'

export function FacilityList({ facilities, restoreId, onSelect }: { facilities: Facility[]; restoreId: string | null; onSelect: (id: string) => void }) {
  const restoreRow = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    if (restoreId) (restoreRow.current ?? document.querySelector<HTMLInputElement>('#search'))?.focus()
  }, [restoreId])

  if (!facilities.length) return <p className="empty">No facilities match. Try a shorter name, a street or city, or all permit types.</p>
  return <ul className="facility-list">{facilities.map(f => {
    const inspected = formatDate(f.lastInspectionDate)
    return <li key={f.id}><button ref={f.id === restoreId ? restoreRow : undefined} className="facility-row" onClick={() => onSelect(f.id)}>
      <span className="facility-main">
        <strong>{f.name || 'Unnamed facility'}</strong>
        <small>{[f.permitType, f.address || 'Address unavailable'].filter(Boolean).join(' · ')}</small>
        <small>{inspected ? `Inspected ${inspected}` : 'No inspection date'}</small>
      </span>
      <span className="score"><span className="sr-only">Inspection score </span>{f.lastInspectionScore ?? <><span aria-hidden>—</span><span className="sr-only">unavailable</span></>}</span>
      <ChevronRight className="row-chevron" size={18} aria-hidden />
    </button></li>
  })}</ul>
}
