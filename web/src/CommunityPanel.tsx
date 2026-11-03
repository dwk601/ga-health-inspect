import { useEffect, useState, type FormEvent } from 'react'
import type { RecordModel } from 'pocketbase'
import { pb, errorMessage } from './api'
import type { Contribution } from './types'

type Item = Contribution & RecordModel
export function CommunityPanel({ facilityId, user, refresh }: { facilityId: string; user: RecordModel | null; refresh: () => void }) {
  const [ratings, setRatings] = useState<Item[]>([]); const [comments, setComments] = useState<Item[]>([])
  const [message, setMessage] = useState(''); const [version, setVersion] = useState(0)
  useEffect(() => {
    let active = true
    const filter = pb.filter('facility_id = {:id}', { id: facilityId })
    Promise.all([pb.collection('ratings').getFullList<Item>({ filter, sort: '-created', requestKey: null }), pb.collection('comments').getFullList<Item>({ filter, sort: '-created', requestKey: null })]).then(([r, c]) => { if (active) { setRatings(r); setComments(c); setMessage('') } }).catch(e => { if (active) setMessage(errorMessage(e)) })
    return () => { active = false }
  }, [facilityId, version])
  function updated() { setVersion(v => v + 1); refresh() }
  async function submit(e: FormEvent<HTMLFormElement>, kind: 'ratings' | 'comments') {
    e.preventDefault(); const form = e.currentTarget; const data = new FormData(form)
    try {
      const own = ratings.find(r => r.owner === user?.id)
      if (kind === 'ratings' && own) await pb.collection(kind).update(own.id, { rating: Number(data.get('rating')) })
      else await pb.collection(kind).create({ owner: user?.id, facility_id: facilityId, ...(kind === 'ratings' ? { rating: Number(data.get('rating')) } : { body: data.get('body') }) })
      form.reset(); setMessage('Saved.'); updated()
    } catch (error) { setMessage(errorMessage(error)) }
  }
  async function remove(kind: 'ratings' | 'comments', item: Item) {
    if (!window.confirm(`Remove this ${kind === 'ratings' ? 'rating' : 'comment'}?`)) return
    try { await pb.collection(kind).delete(item.id); setMessage('Removed.'); updated() } catch (e) { setMessage(errorMessage(e)) }
  }
  async function editComment(item: Item) {
    const body = window.prompt('Edit your comment:', item.body || '')
    if (body === null || body === item.body) return
    if (!body.trim() || body.length > 2000) { setMessage('Comments must contain 1–2000 characters.'); return }
    try { await pb.collection('comments').update(item.id, { body }); setMessage('Comment updated.'); updated() } catch (e) { setMessage(errorMessage(e)) }
  }
  async function role(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const data = new FormData(e.currentTarget)
    try { await pb.collection('users').update(String(data.get('userId')), { role: data.get('role') }); setMessage('Role updated.'); updated() } catch (error) { setMessage(errorMessage(error)) }
  }
  const canRemove = (item: Item) => !!user && (item.owner === user.id || user.role === 'moderator' || user.role === 'admin')
  return <section className="community"><h3>Visitor experience · 1–5</h3><p>Visitor ratings reflect personal experiences. They are not a safety score.</p>
    {user ? <><form onSubmit={e => submit(e, 'ratings')} className="compact-form"><label htmlFor="rating">Your rating<select id="rating" name="rating" defaultValue={ratings.find(r => r.owner === user.id)?.rating || 5}>{[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}</select></label><button className="primary">Save rating</button></form>
      <form onSubmit={e => submit(e, 'comments')}><label htmlFor="comment">Your comment<textarea id="comment" name="body" maxLength={2000} required rows={3} /></label><button className="primary">Post comment</button></form></> : <p>Sign in and verify your email to contribute.</p>}
    <p role="status">{message}</p>
    <h4>Ratings</h4>{ratings.length === 0 && <p>No ratings yet.</p>}<ul className="contributions">{ratings.map(item => <li key={item.id}><strong>{item.authorName}</strong> · {item.rating}/5 {canRemove(item) && <button className="text-button" onClick={() => remove('ratings', item)}>Remove rating</button>}{user?.role === 'admin' && <small>User ID: {item.owner}</small>}</li>)}</ul>
    <h4>Comments</h4>{comments.length === 0 && <p>No comments yet.</p>}<ul className="contributions">{comments.map(item => <li key={item.id}><strong>{item.authorName}</strong><p className="comment-body">{item.body}</p>{user?.id === item.owner && <button className="text-button" onClick={() => editComment(item)}>Edit comment</button>} {' '}{canRemove(item) && <button className="text-button" onClick={() => remove('comments', item)}>Remove comment</button>}{user?.role === 'admin' && <small>User ID: {item.owner}</small>}</li>)}</ul>
    {user?.role === 'admin' && <form onSubmit={role} className="role-form"><h4>Change user role</h4><label htmlFor="user-id">User ID<input id="user-id" name="userId" required /></label><label htmlFor="user-role">Role<select id="user-role" name="role"><option value="user">User</option><option value="moderator">Moderator</option><option value="admin">Admin</option></select></label><button>Update role</button></form>}
  </section>
}
