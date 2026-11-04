import { useCallback } from 'react'
import type { RecordModel } from 'pocketbase'
import { CommunityPanel } from './CommunityPanel'
import type { Detail } from './types'

function date(value: string | null) {
  if (!value) return 'Date unavailable'
  const [year, month, day] = value.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)))
}
function safeLink(value: string | null) {
  try {
    const url = new URL(value || '')
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}
export function FacilityDetail({
  id,
  onClose,
  user,
  detail,
  error,
  load,
}: {
  id: string
  onClose: () => void
  user: RecordModel | null
  detail: Detail | null
  error: string
  load: () => void
}) {
  const focusHeading = useCallback((node: HTMLHeadingElement | null) => {
    node?.focus()
  }, [])
  return (
    <article className="detail">
      <button className="text-button back" onClick={onClose}>
        ‹ Back to results
      </button>
      {error && <p role="status">{error}</p>}
      {!detail && !error && <p>Loading facility…</p>}
      {detail && (
        <>
          <div className="detail-title">
            <p>{detail.facility.permitType || 'Facility'}</p>
            <h2 tabIndex={-1} ref={focusHeading}>
              {detail.facility.name || 'Unnamed facility'}
            </h2>
            <p>{detail.facility.address || 'Address unavailable'}</p>
          </div>
          <div className="summary-grid">
            <div>
              <span>Inspection score</span>
              <strong>{detail.facility.lastInspectionScore ?? '—'}</strong>
              <small>{date(detail.facility.lastInspectionDate)}</small>
            </div>
            <div>
              <span>Visitor experience · 1–5</span>
              <strong>
                {detail.community.ratingAverage != null
                  ? detail.community.ratingAverage.toFixed(1)
                  : '—'}
              </strong>
              <small>
                {`${detail.community.ratingCount} ${detail.community.ratingCount === 1 ? 'rating' : 'ratings'}`}
              </small>
            </div>
          </div>
          <section className="inspection-history">
            <h3>Inspection history</h3>
            {!detail.inspections.length && <p>No inspections available.</p>}
            <ol>
              {detail.inspections.map((i) => (
                <li key={i.id}>
                  <div className="section-heading">
                    <div>
                      <strong>{date(i.inspectionDate)}</strong>
                      <p>{i.purpose || 'Inspection'}</p>
                    </div>
                    <strong>{i.score ?? '—'}</strong>
                  </div>
                  {safeLink(i.printableUrl) && (
                    <a
                      href={safeLink(i.printableUrl)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View inspection report
                    </a>
                  )}
                  {i.violations.length > 0 && (
                    <details>
                      <summary>
                        Current violations ({i.violations.length})
                      </summary>
                      <ul>
                        {i.violations.map((v) => (
                          <li key={v.sourceKey}>
                            <strong>
                              {v.codeTitle || v.regulation || 'Violation'}
                            </strong>
                            {v.notes && <p>{v.notes}</p>}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              ))}
            </ol>
          </section>
          <CommunityPanel
            key={`${id}-${user?.id ?? 'anonymous'}`}
            facilityId={id}
            user={user}
            refresh={load}
          />
        </>
      )}
    </article>
  )
}
