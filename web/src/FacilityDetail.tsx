import { useCallback } from 'react'
import type { RecordModel } from 'pocketbase'
import { ArrowLeft, ExternalLink, MapPin, Phone } from 'lucide-react'
import { AIUsageControl } from './AIUsage'
import { InspectionExplanation } from './InspectionExplanation'
import { CommunityPanel } from './CommunityPanel'
import { formatDate, formatTime } from './format'
import { facilityTitle, officialName } from './facilityName'
import type { Detail, Inspection, ComparisonSelection } from './types'
import type { LocationFix } from './geolocation'

export function safeLink(value: string | null) {
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

export function FindingsStatus({ inspection }: { inspection: Inspection }) {
  const status = inspection.evidence.findingsStatus
  const copy = {
    available: inspection.violations.length ? 'Findings available for this inspection.' : 'The source records no findings for this inspection.',
    incomplete: 'Some findings may be missing from this inspection snapshot.',
    unavailable: 'Findings completeness is unavailable.',
    not_fetched: 'Findings have not been retrieved.',
    failed: 'Findings could not be retrieved.',
    refresh_failed: 'Refresh failed. These are retained findings, not confirmed current to this listing.',
    pending_refresh: 'The listing changed. Retained findings are awaiting refresh.',
  }
  return <p className="evidence-status">{inspection.evidence.source === 'gnr' ? 'County source. ' : 'State source. '}{copy[status]}</p>
}

function explainable(inspection: Inspection) {
  return inspection.evidence.findingsStatus === 'available' && inspection.violations.length > 0
}

function visitDetails(inspection: Inspection) {
  const visit = [formatTime(inspection.timeIn), formatTime(inspection.timeOut)].filter(Boolean).join('–')
  return [
    inspection.grade && `Grade ${inspection.grade}`,
    visit,
    inspection.inspector && `Inspector ${inspection.inspector}`,
  ].filter(Boolean).join(' · ')
}

export function FacilityDetail({
  id,
  mapped,
  coordinates,
  origin,
  retryMap,
  nearby,
  onClose,
  onSignIn,
  user,
  detail,
  error,
  load,
  comparison,
}: {
  comparison: ComparisonSelection
  id: string
  mapped?: boolean
  coordinates: [number, number] | null | undefined
  origin: LocationFix | null
  retryMap: (() => void) | null
  nearby: boolean
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
        {nearby ? 'Nearby places' : 'All facilities'}
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
            <h1 id="facility-title" tabIndex={-1} ref={focusHeading}>
              {facilityTitle(facility)}
            </h1>
            {officialName(facility) && <p>Listed as {officialName(facility)}</p>}
            <p>
              {[facility.permitType, facility.address || 'Address unavailable']
                .filter(Boolean)
                .join(' · ')}
            </p>
            <Contact facility={facility} />
            <button type="button" aria-pressed={comparison.ids.includes(id)} disabled={comparison.ids.length >= 3 && !comparison.ids.includes(id)} onClick={() => comparison.toggle(id)}>{comparison.ids.includes(id) ? 'Remove from comparison' : 'Add to comparison'}</button>
            <button className="community-jump" onClick={() => {
              const heading = document.getElementById('community-title')
              heading?.focus({ preventScroll: true })
              heading?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
            }}>Rate or comment</button>
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
            <h2>Inspection history</h2>
            <p className="muted">Optional AI explanations send selected public inspection records to the configured AI provider, not your account or device location. AI is offered only for confirmed, non-empty findings.</p>
            {detail.inspections.some(explainable) && <AIUsageControl />}
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
                        {visitDetails(i) && <p>{visitDetails(i)}</p>}
                      </div>
                      <span className="score">
                        <span className="sr-only">Score </span>
                        {i.score ?? '—'}
                      </span>
                    </div>
                    <FindingsStatus inspection={i} />
                    {explainable(i) ? <InspectionExplanation key={i.contentHash} selections={[{ facilityId: id, inspectionId: i.id, contentHash: i.contentHash }]} /> : <p className="evidence-status">AI explanation unavailable: {i.evidence.findingsStatus === 'available' ? 'no findings to explain.' : 'source findings are not confirmed complete.'}</p>}
                    {i.evidence.reportStatus !== 'available' && i.evidence.reportStatus !== 'external' && <p className="evidence-status">Printable report: {i.evidence.reportStatus === 'not_fetched' ? 'not retrieved' : i.evidence.reportStatus === 'refresh_failed' ? 'refresh failed; retained report fields shown' : 'retrieval failed'}.{i.evidence.reportAttemptedAt && ` Last attempt ${new Date(i.evidence.reportAttemptedAt).toLocaleString()}.`}</p>}
                    {(report || i.violations.length > 0 || i.comments) && (
                      <div className="inspection-extras">
                        {i.violations.length > 0 && (
                          <details>
                            <summary>
                              Findings from this inspection ({i.violations.length})
                            </summary>
                            <ul>
                              {i.violations.map((v) => (
                                <li key={v.sourceKey}>
                                  <strong>
                                    {v.codeTitle || v.regulation || 'Violation'}
                                  </strong>
                                  {v.notes && <p>{v.notes}</p>}
                                  {v.corrected === true && <p>Corrected during inspection</p>}
                                  {v.repeat === true && <p>Repeat finding</p>}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                        {i.comments && (
                          <details>
                            <summary>Inspector comments</summary>
                            <p>{i.comments}</p>
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
            mapped={mapped}
            coordinates={coordinates}
            origin={origin}
            retryMap={retryMap}
            user={user}
            refresh={load}
            onSignIn={onSignIn}
          />
        </>
      )}
    </article>
  )
}
