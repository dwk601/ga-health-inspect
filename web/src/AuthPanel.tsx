import { useEffect, useRef, useState, type FormEvent } from 'react'
import { pb, errorMessage, refreshAuth } from './api'

export function AuthPanel({ onClose, initialRecovery = false }: { onClose: () => void; initialRecovery?: boolean }) {
  const [signup, setSignup] = useState(false)
  const [recovery, setRecovery] = useState<'reset' | 'verify' | null>(initialRecovery ? 'verify' : null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const emailRef = useRef<HTMLInputElement>(null)
  useEffect(() => { emailRef.current?.focus() }, [signup, recovery])
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setMessage('')
    const data = new FormData(e.currentTarget)
    const email = String(data.get('email')); const password = String(data.get('password'))
    try {
      if (recovery) {
        if (recovery === 'reset') await pb.collection('users').requestPasswordReset(email)
        else await pb.collection('users').requestVerification(email)
        setMessage('If the address is eligible, an email will be sent shortly.')
      } else if (signup) {
        await pb.collection('users').create({ name: data.get('name'), email, password, passwordConfirm: password })
        await pb.collection('users').requestVerification(email)
        setMessage('Account created. Check your email to verify your account, then sign in.')
      } else {
        await pb.collection('users').authWithPassword(email, password)
        await refreshAuth()
        if (!pb.authStore.isValid) throw new Error('Session refresh failed')
        onClose()
      }
    } catch (error) { setMessage(errorMessage(error, recovery === 'reset' ? 'request a password reset' : recovery === 'verify' ? 'resend verification' : signup ? 'create your account or send verification' : 'sign in')) } finally { setBusy(false) }
  }
  return <div className="auth-panel"><div className="section-heading"><h2 aria-live="polite">{recovery === 'reset' ? 'Reset password' : recovery === 'verify' ? 'Resend verification email' : signup ? 'Create account' : 'Sign in'}</h2><button className="text-button" onClick={onClose}>Close</button></div>{!recovery && <p>Verify your email before posting a rating or comment.</p>}<form onSubmit={submit} method="post">
    {signup && !recovery && <label htmlFor="auth-name">Name<input id="auth-name" name="name" autoComplete="name" maxLength={60} required /></label>}
    <label htmlFor="auth-email">Email<input ref={emailRef} id="auth-email" name="email" type="email" autoComplete="email" required /></label>
    {!recovery && <label htmlFor="auth-password">Password<input id="auth-password" name="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} minLength={8} required /></label>}
    <button className="primary" disabled={busy}>{recovery ? 'Send email' : signup ? 'Create account' : 'Sign in'}</button>
  </form><p role="status">{message}</p>{!signup && !recovery && <><button className="text-button" onClick={() => { setRecovery('reset'); setMessage('') }}>Forgot password?</button>{' '}<button className="text-button" onClick={() => { setRecovery('verify'); setMessage('') }}>Resend verification email</button></>}{recovery ? <button className="text-button" onClick={() => { setRecovery(null); setMessage('') }}>Back to sign in</button> : <button className="text-button" onClick={() => { setSignup(!signup); setMessage('') }}>{signup ? 'Already have an account? Sign in' : 'New here? Create an account'}</button>}</div>
}
