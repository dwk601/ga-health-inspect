import { Component, Suspense, lazy, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ClientResponseError, type RecordModel } from 'pocketbase'
import { pb, errorMessage, refreshAuth } from './api'
import { distanceMiles, geolocationFailureMessage, getPreciseLocation, type LocationFix } from './geolocation'
import type { Contribution } from './types'

type Item = Contribution & RecordModel
type Removal = { kind: 'ratings' | 'comments'; item: Item; launcher: HTMLButtonElement }
const createRemovalConfirmation = () => lazy(() => import('./RemovalConfirmation'))

class RemovalImportBoundary extends Component<{ children: ReactNode; onFailure: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { this.props.onFailure() }
  render() { return this.state.failed ? null : this.props.children }
}

type Eligibility = { state: 'unknown' | 'checking' | 'eligible' | 'far' | 'outside' | 'imprecise' | 'unavailable' | 'expired'; text: string; expires?: number }
const unknownLocation: Eligibility = { state: 'unknown', text: 'Check your location to see if you can rate here.' }
function locationError(error: unknown) {
  const code = typeof error === 'object' && error && 'code' in error ? error.code : undefined
  return error instanceof Error ? error.message : geolocationFailureMessage(code)
}
const visibleText = /[^\s\p{Z}\p{C}\u{034F}\u{115F}\u{1160}\u{17B4}\u{17B5}\u{180B}-\u{180F}\u{2800}\u{3164}\u{FE00}-\u{FE0F}\u{FFA0}\u{E0100}-\u{E01EF}]/u
const postedDate = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' })

function RatingPicker({ value, disabled }: { value: number | undefined; disabled: boolean }) {
  return <fieldset className="rating-picker" disabled={disabled} aria-describedby="rating-location">
    <legend>Your rating <span className="rating-hint">out of 5</span></legend>
    <div>{[1, 2, 3, 4, 5].map(n => <label key={n}><input type="radio" name="rating" value={n} aria-label={`${n} out of 5`} defaultChecked={n === value} required /><span>{n}</span></label>)}</div>
  </fieldset>
}

export function CommunityPanel({ facilityId, mapped, coordinates, origin, retryMap, user, refresh, onSignIn }: { facilityId: string; mapped?: boolean; coordinates: [number, number] | null | undefined; origin: LocationFix | null; retryMap: (() => void) | null; user: RecordModel | null; refresh: () => void; onSignIn: () => void }) {
  const [ratings, setRatings] = useState<Item[]>([]); const [comments, setComments] = useState<Item[]>([])
  const [message, setMessage] = useState(''); const [loadError, setLoadError] = useState(''); const [loaded, setLoaded] = useState(false); const [version, setVersion] = useState(0)
  const [editing, setEditing] = useState<string | null>(null)
  const [removal, setRemoval] = useState<Removal | null>(null)
  const [Confirmation, setConfirmation] = useState(createRemovalConfirmation)
  const [ratingPending, setRatingPending] = useState(false); const [commentPending, setCommentPending] = useState(false)
  const generation = useRef(0)
  const locationRequest = useRef(0)
  const [eligibility, setEligibility] = useState<Eligibility>(unknownLocation)
  useEffect(() => { generation.current++; return () => { generation.current++; locationRequest.current++ } }, [facilityId, user?.id])
  const longitude = coordinates?.[0]
  const latitude = coordinates?.[1]
  const assess = useCallback((fix: LocationFix, precise: boolean): Eligibility => {
    if (longitude === undefined || latitude === undefined) return { state: 'unknown', text: 'Map location is unavailable.' }
    const miles = distanceMiles(fix.coordinates, [longitude, latitude])
    const meters = miles * 1609.344
    const expires = fix.timestamp + 120000
    if (expires <= Date.now()) return { state: 'expired', text: 'Your location has expired. Check again.' }
    if (meters - fix.accuracy > 150) {
      const distance = miles < 0.1 ? `${Math.round(miles * 5280)} ft` : `${miles.toFixed(1)} mi`
      return { state: 'far', text: `You're not at this place. You're about ${distance} away - ratings can only be saved on-site, within about 500 ft. You can still comment.`, expires }
    }
    if (precise && fix.accuracy <= 100) return meters <= 150 ? { state: 'eligible', text: 'Your location is within rating range.', expires } : { state: 'outside', text: 'Your location is outside rating range. Ratings can only be saved on-site, within about 500 ft. You can still comment.', expires }
    return precise ? { state: 'imprecise', text: "Your location isn't precise enough to rate. Move outdoors or enable precise location and check again.", expires } : { ...unknownLocation, expires }
  }, [longitude, latitude])
  const checkLocation = useCallback(async () => {
    const request = ++locationRequest.current
    setEligibility({ state: 'checking', text: 'Checking location…' })
    try {
      const fix = await getPreciseLocation()
      if (request !== locationRequest.current) return
      setEligibility(assess(fix, true))
    } catch (error) {
      if (request !== locationRequest.current) return
      setEligibility({ state: 'unavailable', text: locationError(error) })
    }
  }, [assess])
  useEffect(() => {
    if (!user?.verified || mapped !== true || longitude === undefined || latitude === undefined) return
    setEligibility(previous => previous.state === 'checking' ? previous : origin ? assess(origin, false) : unknownLocation)
    let active = true
    const request = locationRequest.current
    navigator.permissions?.query({ name: 'geolocation' }).then(permission => { if (active && request === locationRequest.current && permission.state === 'granted') void checkLocation() }).catch(() => {})
    return () => { active = false }
  }, [user?.verified, mapped, longitude, latitude, origin, assess, checkLocation])
  useEffect(() => {
    if (!eligibility.expires) return
    const timer = window.setTimeout(() => setEligibility({ state: 'expired', text: 'Your location has expired. Check again.' }), Math.max(0, eligibility.expires - Date.now()))
    return () => clearTimeout(timer)
  }, [eligibility])
  useEffect(() => {
    let active = true
    const filter = pb.filter('facility_id = {:id}', { id: facilityId })
    Promise.all([pb.collection('ratings').getFullList<Item>({ filter, sort: '-created', requestKey: null }), pb.collection('comments').getFullList<Item>({ filter, sort: '-created', requestKey: null })]).then(([r, c]) => { if (active) { setRatings(r); setComments(c); setLoadError(''); setLoaded(true) } }).catch(e => { if (active) { setLoaded(false); setLoadError(errorMessage(e, 'load community contributions')) } })
    return () => { active = false }
  }, [facilityId, version])
  function updated() { setVersion(v => v + 1); refresh() }
  async function submit(e: FormEvent<HTMLFormElement>, kind: 'ratings' | 'comments') {
    e.preventDefault(); const form = e.currentTarget; const data = new FormData(form)
    const own = ratings.find(r => r.owner === user?.id)
    const body = String(data.get('body') ?? '').trim()
    if (kind === 'comments' && !visibleText.test(body)) { setMessage("Comment can't be blank."); return }
    if (kind === 'ratings' && (mapped !== true || eligibility.state === 'checking' || eligibility.state === 'far' || eligibility.state === 'outside')) return
    const current = generation.current
    const pending = kind === 'ratings' ? setRatingPending : setCommentPending
    pending(true)
    try {
      let location = {}
      if (kind === 'ratings') {
        locationRequest.current++
        setEligibility({ state: 'checking', text: 'Checking location…' }); setMessage('')
        const fix = await getPreciseLocation()
        if (generation.current !== current) return
        const result = assess(fix, true)
        setEligibility(result)
        if (result.state !== 'eligible') return
        location = { latitude: fix.coordinates[1], longitude: fix.coordinates[0], accuracy: fix.accuracy }
      }
      if (kind === 'ratings' && own) await pb.collection(kind).update(own.id, { rating: Number(data.get('rating')), ...location })
      else await pb.collection(kind).create({ owner: user?.id, facility_id: facilityId, ...(kind === 'ratings' ? { rating: Number(data.get('rating')), ...location } : { body }) })
      if (generation.current !== current) return
      if (kind === 'comments') form.reset()
      setMessage(kind === 'ratings' ? 'Rating saved.' : 'Comment posted.'); updated()
    } catch (error) {
      if (generation.current !== current) return
      if (kind === 'ratings' && !(error instanceof ClientResponseError)) {
        setEligibility({ state: 'unavailable', text: locationError(error) })
      } else { setMessage(errorMessage(error, kind === 'ratings' ? 'save your rating' : 'post your comment', kind === 'ratings' && !!own, true)); void refreshAuth() }
    } finally { if (generation.current === current) pending(false) }
  }
  function requestRemoval(kind: 'ratings' | 'comments', item: Item, launcher: HTMLButtonElement) {
    setMessage('')
    setRemoval({ kind, item, launcher })
  }
  function removalLoadFailed() {
    // A failed lazy import is cached, so a retry needs a new one.
    setConfirmation(createRemovalConfirmation())
    setMessage('Could not load removal confirmation. Please try again.')
    setRemoval(null)
    const target = removal?.launcher.isConnected ? removal.launcher : document.getElementById('community-title')
    target?.focus()
  }
  async function remove(kind: 'ratings' | 'comments', item: Item) {
    try { await pb.collection(kind).delete(item.id); setMessage('Removed.'); updated(); return true } catch (e) {
      setMessage(errorMessage(e, kind === 'ratings' ? 'remove the rating' : 'remove the comment', true))
      if (e instanceof ClientResponseError && e.status === 404) { updated(); return true }
      return false
    }
  }
  async function saveEdit(e: FormEvent<HTMLFormElement>, item: Item) {
    e.preventDefault()
    const body = String(new FormData(e.currentTarget).get('body') ?? '').trim()
    if (body === item.body) { setEditing(null); return }
    if (!visibleText.test(body)) { setMessage("Comment can't be blank."); return }
    try { await pb.collection('comments').update(item.id, { body }); setEditing(null); setMessage('Comment updated.'); updated() } catch (err) { setMessage(errorMessage(err, 'update your comment', true, true)) }
  }
  async function resendVerification() {
    if (!user?.email) return
    try { await pb.collection('users').requestVerification(user.email); setMessage('If the address is eligible, an email will be sent shortly.') }
    catch (error) { setMessage(errorMessage(error, 'send verification')) }
  }
  async function role(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const data = new FormData(e.currentTarget)
    try { await pb.collection('users').update(String(data.get('userId')), { role: data.get('role') }); setMessage('Role updated.'); updated() } catch (error) { setMessage(errorMessage(error, 'update the role', true)) } finally { void refreshAuth() }
  }
  const canRemove = (item: Item) => !!user && (item.owner === user.id || user.role === 'moderator' || user.role === 'admin')
  const ownRating = ratings.find(r => r.owner === user?.id)?.rating
  const pickerBlocked = mapped !== true || eligibility.state === 'far' || eligibility.state === 'outside'
  const locationBlocked = pickerBlocked || eligibility.state === 'checking'
  const byline = (item: Item) => <span className="byline"><strong>{item.authorName}</strong><time dateTime={item.created}>{postedDate.format(new Date(item.created.replace(' ', 'T')))}</time></span>
  const adminId = (item: Item) => user?.role === 'admin' && <small>User ID: {item.owner}</small>

  return <section className="community" aria-labelledby="community-title">
    <h2 id="community-title" tabIndex={-1}>Visitor experience · 1–5</h2>
    <p className="muted">Visitor ratings reflect personal experiences. They are not a safety score.</p>
    {user?.verified ? <div className="contribute">
      <form onSubmit={e => submit(e, 'ratings')} className="compact-form">
        <p className="muted">Enable location while you're here to rate. Comments don't require location.</p>
        <div className={`notice ${mapped === true && (eligibility.state === 'far' || eligibility.state === 'outside') ? 'location-warning' : ''}`} role="status"><p id="rating-location">{mapped === false ? 'This facility has no map location, so ratings are unavailable.' : mapped === undefined ? retryMap ? "Map data is unavailable, so your location can't be checked for rating right now. You can still comment." : 'Loading map location…' : eligibility.text}</p>{mapped === undefined && retryMap && <button type="button" onClick={retryMap}>Retry map data</button>}{mapped === true && <button type="button" onClick={() => void checkLocation()} disabled={ratingPending || eligibility.state === 'checking'}>{eligibility.state === 'unknown' ? 'Check my location' : 'Check again'}</button>}</div>
        <RatingPicker key={`${user.id}-${ownRating ?? 'new'}`} value={ownRating} disabled={pickerBlocked} />
        <button type="submit" className="primary" disabled={ratingPending || locationBlocked}>{ratingPending ? 'Saving…' : ownRating ? 'Update rating' : 'Save rating'}</button>
      </form>
      <form className="comment-composer" onSubmit={e => submit(e, 'comments')}>
        <label htmlFor="comment">Your comment<textarea id="comment" name="body" maxLength={2000} required rows={3} placeholder="What was your visit like?" /></label>
        <button type="submit" className="primary" disabled={commentPending}>{commentPending ? 'Saving…' : 'Post comment'}</button>
      </form>
    </div> : <div className="notice contribute-prompt">{user
      ? <p>Verify your email to post a rating or comment. Ratings require being at the place. <button className="text-button" onClick={resendVerification}>Resend verification email</button></p>
      : <><p>Sign in with a verified email to rate this place or leave a comment. Ratings require being at the place.</p><button onClick={onSignIn}>Sign in to contribute</button></>}</div>}
    <p role="status" className="form-status">{message || loadError || (!loaded ? 'Loading visitor contributions…' : '')}</p>

    <h3>Ratings{ratings.length > 0 && <span className="count">{ratings.length}</span>}</h3>
    {loaded && ratings.length === 0 && <p className="muted">No ratings yet.</p>}
    <ul className="contributions">{ratings.map(item => <li key={item.id}>
      <div className="contribution-head">{byline(item)}<span className="rating-value">{item.rating}<small>/5</small></span></div>
      {canRemove(item) && <button type="button" className="text-button" onClick={e => requestRemoval('ratings', item, e.currentTarget)}>Remove rating</button>}{adminId(item)}
    </li>)}</ul>

    <h3>Comments{comments.length > 0 && <span className="count">{comments.length}</span>}</h3>
    {loaded && comments.length === 0 && <p className="muted">No comments yet.</p>}
    <ul className="contributions">{comments.map(item => <li key={item.id}>
      <div className="contribution-head">{byline(item)}</div>
      {editing === item.id ? <form onSubmit={e => saveEdit(e, item)} className="edit-form">
        <label htmlFor={`edit-${item.id}`} className="sr-only">Edit your comment</label>
        <textarea id={`edit-${item.id}`} name="body" defaultValue={item.body} maxLength={2000} required rows={3} autoFocus />
        <div className="actions"><button type="submit" className="primary">Save</button><button type="button" onClick={() => setEditing(null)}>Cancel</button></div>
      </form> : <>
        <p className="comment-body">{item.body}</p>
        <div className="actions">
          {user?.id === item.owner && <button className="text-button" onClick={() => setEditing(item.id)}>Edit comment</button>}
          {canRemove(item) && <button type="button" className="text-button" onClick={e => requestRemoval('comments', item, e.currentTarget)}>Remove comment</button>}
        </div>
      </>}
      {adminId(item)}
    </li>)}</ul>

    {user?.verified && user.role === 'admin' && <form onSubmit={role} className="role-form"><h3>Change user role</h3><label htmlFor="user-id">User ID<input id="user-id" name="userId" required /></label><label htmlFor="user-role">Role<select id="user-role" name="role"><option value="user">User</option><option value="moderator">Moderator</option><option value="admin">Admin</option></select></label><button type="submit">Update role</button></form>}
    {removal && <RemovalImportBoundary onFailure={removalLoadFailed}>
      <Suspense fallback={<p role="status">Loading removal confirmation…</p>}>
        <Confirmation kind={removal.kind} launcher={removal.launcher} onRemove={() => remove(removal.kind, removal.item)} onClose={() => setRemoval(null)} />
      </Suspense>
    </RemovalImportBoundary>}
  </section>
}
