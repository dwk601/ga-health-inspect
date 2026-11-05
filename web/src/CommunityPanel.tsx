import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ClientResponseError, type RecordModel } from 'pocketbase'
import { pb, errorMessage, refreshAuth } from './api'
import { geolocationFailureMessage } from './geolocation'
import type { Contribution } from './types'

type Item = Contribution & RecordModel
const visibleText = /[^\s\p{Z}\p{C}\u{034F}\u{115F}\u{1160}\u{17B4}\u{17B5}\u{180B}-\u{180F}\u{2800}\u{3164}\u{FE00}-\u{FE0F}\u{FFA0}\u{E0100}-\u{E01EF}]/u
const postedDate = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' })

function RatingPicker({ value }: { value: number | undefined }) {
  return <fieldset className="rating-picker">
    <legend>Your rating <span className="rating-hint">out of 5</span></legend>
    <div>{[1, 2, 3, 4, 5].map(n => <label key={n}><input type="radio" name="rating" value={n} aria-label={`${n} out of 5`} defaultChecked={n === value} required /><span>{n}</span></label>)}</div>
  </fieldset>
}

export function CommunityPanel({ facilityId, mapped, user, refresh, onSignIn }: { facilityId: string; mapped?: boolean; user: RecordModel | null; refresh: () => void; onSignIn: () => void }) {
  const [ratings, setRatings] = useState<Item[]>([]); const [comments, setComments] = useState<Item[]>([])
  const [message, setMessage] = useState(''); const [loadError, setLoadError] = useState(''); const [loaded, setLoaded] = useState(false); const [version, setVersion] = useState(0)
  const [editing, setEditing] = useState<string | null>(null)
  const [ratingPending, setRatingPending] = useState(false); const [commentPending, setCommentPending] = useState(false)
  const [checkingLocation, setCheckingLocation] = useState(false)
  const generation = useRef(0)
  useEffect(() => { generation.current++; return () => { generation.current++ } }, [facilityId, user?.id])
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
    if (kind === 'ratings' && mapped === false) return
    const current = generation.current
    const pending = kind === 'ratings' ? setRatingPending : setCommentPending
    pending(true)
    try {
      let location = {}
      if (kind === 'ratings') {
        setCheckingLocation(true); setMessage('')
        if (!window.isSecureContext) throw new Error('Location requires a secure connection. Open this site over HTTPS and try again.')
        if (!navigator.geolocation) throw new Error('This browser does not support location.')
        const position = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }))
        if (generation.current !== current) return
        setCheckingLocation(false)
        location = { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy }
      }
      if (kind === 'ratings' && own) await pb.collection(kind).update(own.id, { rating: Number(data.get('rating')), ...location })
      else await pb.collection(kind).create({ owner: user?.id, facility_id: facilityId, ...(kind === 'ratings' ? { rating: Number(data.get('rating')), ...location } : { body }) })
      if (generation.current !== current) return
      if (kind === 'comments') form.reset()
      setMessage(kind === 'ratings' ? 'Rating saved.' : 'Comment posted.'); updated()
    } catch (error) {
      if (generation.current !== current) return
      if (kind === 'ratings' && !(error instanceof ClientResponseError)) {
        const code = typeof error === 'object' && error && 'code' in error ? error.code : undefined
        setMessage(error instanceof Error ? error.message : geolocationFailureMessage(code))
      } else { setMessage(errorMessage(error, kind === 'ratings' ? 'save your rating' : 'post your comment', kind === 'ratings' && !!own, true)); void refreshAuth() }
    } finally { if (generation.current === current) { pending(false); if (kind === 'ratings') setCheckingLocation(false) } }
  }
  async function remove(kind: 'ratings' | 'comments', item: Item) {
    if (!window.confirm(`Remove this ${kind === 'ratings' ? 'rating' : 'comment'}?`)) return
    try { await pb.collection(kind).delete(item.id); setMessage('Removed.'); updated() } catch (e) {
      setMessage(errorMessage(e, kind === 'ratings' ? 'remove the rating' : 'remove the comment', true))
      if (e instanceof ClientResponseError && e.status === 404) updated()
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
  const byline = (item: Item) => <span className="byline"><strong>{item.authorName}</strong><time dateTime={item.created}>{postedDate.format(new Date(item.created.replace(' ', 'T')))}</time></span>
  const adminId = (item: Item) => user?.role === 'admin' && <small>User ID: {item.owner}</small>

  return <section className="community" aria-labelledby="community-title">
    <h3 id="community-title" tabIndex={-1}>Visitor experience · 1–5</h3>
    <p className="muted">Visitor ratings reflect personal experiences. They are not a safety score.</p>
    {user?.verified ? <div className="contribute">
      <form onSubmit={e => submit(e, 'ratings')} className="compact-form">
        <p className="muted">Enable location while you're here to rate. Comments don't require location.</p>
        {mapped === false && <p className="muted">This facility has no map location, so ratings are unavailable.</p>}
        <RatingPicker key={`${user.id}-${ownRating ?? 'new'}`} value={ownRating} />
        <button className="primary" disabled={ratingPending || mapped === false}>{ratingPending ? 'Saving…' : ownRating ? 'Update rating' : 'Save rating'}</button>
      </form>
      <form className="comment-composer" onSubmit={e => submit(e, 'comments')}>
        <label htmlFor="comment">Your comment<textarea id="comment" name="body" maxLength={2000} required rows={3} placeholder="What was your visit like?" /></label>
        <button className="primary" disabled={commentPending}>{commentPending ? 'Saving…' : 'Post comment'}</button>
      </form>
    </div> : <div className="notice contribute-prompt">{user
      ? <p>Verify your email to post a rating or comment. <button className="text-button" onClick={resendVerification}>Resend verification email</button></p>
      : <><p>Sign in with a verified email to rate this place or leave a comment.</p><button onClick={onSignIn}>Sign in to contribute</button></>}</div>}
    <p role="status" className="form-status">{message || (checkingLocation ? 'Checking location…' : loadError || (!loaded ? 'Loading visitor contributions…' : ''))}</p>

    <h4>Ratings{ratings.length > 0 && <span className="count">{ratings.length}</span>}</h4>
    {loaded && ratings.length === 0 && <p className="muted">No ratings yet.</p>}
    <ul className="contributions">{ratings.map(item => <li key={item.id}>
      <div className="contribution-head">{byline(item)}<span className="rating-value">{item.rating}<small>/5</small></span></div>
      {canRemove(item) && <button className="text-button" onClick={() => remove('ratings', item)}>Remove rating</button>}{adminId(item)}
    </li>)}</ul>

    <h4>Comments{comments.length > 0 && <span className="count">{comments.length}</span>}</h4>
    {loaded && comments.length === 0 && <p className="muted">No comments yet.</p>}
    <ul className="contributions">{comments.map(item => <li key={item.id}>
      <div className="contribution-head">{byline(item)}</div>
      {editing === item.id ? <form onSubmit={e => saveEdit(e, item)} className="edit-form">
        <label htmlFor={`edit-${item.id}`} className="sr-only">Edit your comment</label>
        <textarea id={`edit-${item.id}`} name="body" defaultValue={item.body} maxLength={2000} required rows={3} autoFocus />
        <div className="actions"><button className="primary">Save</button><button type="button" onClick={() => setEditing(null)}>Cancel</button></div>
      </form> : <>
        <p className="comment-body">{item.body}</p>
        <div className="actions">
          {user?.id === item.owner && <button className="text-button" onClick={() => setEditing(item.id)}>Edit comment</button>}
          {canRemove(item) && <button className="text-button" onClick={() => remove('comments', item)}>Remove comment</button>}
        </div>
      </>}
      {adminId(item)}
    </li>)}</ul>

    {user?.verified && user.role === 'admin' && <form onSubmit={role} className="role-form"><h4>Change user role</h4><label htmlFor="user-id">User ID<input id="user-id" name="userId" required /></label><label htmlFor="user-role">Role<select id="user-role" name="role"><option value="user">User</option><option value="moderator">Moderator</option><option value="admin">Admin</option></select></label><button>Update role</button></form>}
  </section>
}
