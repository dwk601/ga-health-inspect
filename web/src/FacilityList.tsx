import type { Facility } from './types'
export function FacilityList({ facilities, selected, onSelect }: { facilities: Facility[]; selected: string | null; onSelect: (id: string) => void }) {
  if (!facilities.length) return <p className="empty">No facilities found. Try another search or permit type.</p>
  return <ul className="facility-list">{facilities.map(f => <li key={f.id}><button className={`facility-row ${f.id === selected ? 'selected' : ''}`} onClick={() => onSelect(f.id)}><span><strong>{f.name || 'Unnamed facility'}</strong><small>{f.address || 'Address unavailable'}</small><small>{f.permitType || 'Permit type unavailable'}</small></span><span className="score"><b>{f.lastInspectionScore ?? '—'}</b><small>Inspection<br />score</small></span></button></li>)}</ul>
}
