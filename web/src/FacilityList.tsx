import { useLayoutEffect, useRef } from 'react'
import type { Facility } from './types'

export function FacilityList({ facilities, restoreId, onSelect }: { facilities: Facility[]; restoreId: string | null; onSelect: (id: string) => void }) {
  const restoreRow = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    if (restoreId) (restoreRow.current ?? document.querySelector<HTMLInputElement>('#search'))?.focus()
  }, [restoreId])

  if (!facilities.length) return <p className="empty">No facilities found. Try another search or permit type.</p>
  return <ul className="facility-list">{facilities.map(f => <li key={f.id}><button ref={f.id === restoreId ? restoreRow : undefined} className="facility-row" onClick={() => onSelect(f.id)}><span><strong>{f.name || 'Unnamed facility'}</strong><small>{f.address || 'Address unavailable'}</small><small>{f.permitType || 'Permit type unavailable'}</small></span><span className="score"><b>{f.lastInspectionScore ?? '—'}</b><small>Inspection<br />score</small></span></button></li>)}</ul>
}
