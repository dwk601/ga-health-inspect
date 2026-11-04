import { useCallback } from 'react'
import type { RecordModel } from 'pocketbase'
import { ArrowLeft, ExternalLink, MapPin, Phone } from 'lucide-react'
import { CommunityPanel } from './CommunityPanel'
import { formatDate } from './format'
import type { Detail } from './types'

function safeLink(value: string | null) {
  try {
    const url = new URL(value || '')
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

function Contact({ facility }: { facility: Detail['facility'] }) {
  const mapLink = safeLink(facility.googlePlaces)
  if (!facility.phone && !mapLink) return null
  return (
    <div className="contact-links">
      {facility.phone && (
        <a href={`tel:${facility.phone.replace(/[^\d+]/g, '')}`}>
          <Phone size={15} aria-hidden />
          {facility.phone}
        </a>
      )}
      {mapLink && (
        <a href={mapLink} target="_blank" rel="noreferrer">
          <MapPin size={15} aria-hidden />
          Directions
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      )}
    </div>
  )
}

export function FacilityDetail({
  id,
  onClose,
  onSignIn,
  user,
  detail,
  error,
  load,
}: {
  id: string
  onClose: () => void
  onSignIn: () => void
  user: RecordModel | null
  detail: Detail | null
  error: string
  load: () => void
}) {
  const focusHeading = useCallback((node: HTMLHeadingElement | null) => {
    node?.focus()
  }, [])
  const facility = detail?.facility
  return (
    <article className="detail">
      <button className="back" onClick={onClose}>
        <ArrowLeft size={16} aria-hidden />
        All facilities
      </button>
      {error && (
        <div className="notice" role="alert">
          <p>{error}</p>
          <button onClick={load}>Try again</button>
        </div>
      )}
      {!detail && !error && <p className="loading">Loading facility…</p>}
      {detail && facility && (
        <>
          <header className="detail-title">
            <h2 tabIndex={-1} ref={focusHeading}>
              {facility.name || 'Unnamed facility'}
            </h2>
            <p>
              {[facility.permitType, facility.address || 'Address unavailable']
                .filter(Boolean)
                .join(' · ')}
            </p>
            <Contact facility={facility} />
          </header>
          <dl className="summary-grid">
            <div>
              <dt>Inspection score</dt>
              <dd className="metric">{facility.lastInspectionScore ?? '—'}</dd>
              <dd>
                {formatDate(facility.lastInspectionDate) ?? 'Date unavailable'}
              </dd>
            </div>
            <div>
              <dt>Visitor experience · 1–5</dt>
              <dd className="metric">
                {detail.community.ratingAverage != null
                  ? detail.community.ratingAverage.toFixed(1)
                  : '—'}
              </dd>
              <dd>
                {`${detail.community.ratingCount} ${detail.community.ratingCount === 1 ? 'rating' : 'ratings'}`}
              </dd>
            </div>
          </dl>
          <section className="inspection-history">
            <h3>Inspection history</h3>
            {!detail.inspections.length && (
              <p className="muted">No inspections on record.</p>
            )}
            <ol>
              {detail.inspections.map((i) => {
                const report = safeLink(i.printableUrl)
                return (
                  <li key={i.id}>
                    <div className="inspection-row">
                      <div>
                        <strong>
                          {formatDate(i.inspectionDate) ?? 'Date unavailable'}
                        </strong>
                        <p>{i.purpose || 'Inspection'}</p>
                      </div>
                      <span className="score">
                        <span className="sr-only">Score </span>
                        {i.score ?? '—'}
                      </span>
                    </div>
                    {(report || i.violations.length > 0) && (
                      <div className="inspection-extras">
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
                        {report && (
                          <a href={report} target="_blank" rel="noreferrer">
                            Inspection report
                            <ExternalLink size={13} aria-hidden />
                            <span className="sr-only"> (opens in a new tab)</span>
                          </a>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ol>
          </section>
          <CommunityPanel
            key={`${id}-${user?.id ?? 'anonymous'}`}
            facilityId={id}
            user={user}
            refresh={load}
            onSignIn={onSignIn}
          />
        </>
      )}
    </article>
  )
}
