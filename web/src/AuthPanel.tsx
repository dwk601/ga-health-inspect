import { useState, type FormEvent } from 'react'
import { pb, errorMessage } from './api'

export function AuthPanel({ onClose }: { onClose: () => void }) {
  const [signup, setSignup] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setMessage('')
    const data = new FormData(e.currentTarget)
    const email = String(data.get('email')); const password = String(data.get('password'))
    try {
      if (signup) {
        await pb.collection('users').create({ name: data.get('name'), email, password, passwordConfirm: password })
        await pb.collection('users').requestVerification(email)
        setMessage('Account created. Check your email to verify your account, then sign in.')
      } else { await pb.collection('users').authWithPassword(email, password); onClose() }
    } catch (error) { setMessage(errorMessage(error)) } finally { setBusy(false) }
  }
  return <div className="auth-panel"><div className="section-heading"><h2>{signup ? 'Create account' : 'Sign in'}</h2><button className="text-button" onClick={onClose}>Close</button></div><p>Verify your email before posting a rating or comment.</p><form onSubmit={submit}>
    {signup && <label htmlFor="auth-name">Name<input id="auth-name" name="name" autoComplete="name" maxLength={60} required /></label>}
    <label htmlFor="auth-email">Email<input id="auth-email" name="email" type="email" autoComplete="email" required /></label>
    <label htmlFor="auth-password">Password<input id="auth-password" name="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} minLength={8} required /></label>
    <button className="primary" disabled={busy}>{signup ? 'Create account' : 'Sign in'}</button>
  </form><p role="status">{message}</p><button className="text-button" onClick={() => { setSignup(!signup); setMessage('') }}>{signup ? 'Already have an account? Sign in' : 'New here? Create an account'}</button></div>
}
