import { useEffect, useRef, useState, type FormEvent } from 'react'
import { pb } from './api'

export function AccountLink({ kind, token }: { kind: 'verify' | 'reset-password'; token: string }) {
  const [message, setMessage] = useState('')
  const [success, setSuccess] = useState(false)
  const [busy, setBusy] = useState(kind === 'verify')
  const backLink = useRef<HTMLAnchorElement>(null)
  useEffect(() => { if (success && kind === 'reset-password') backLink.current?.focus() }, [success, kind])

  useEffect(() => {
    if (kind !== 'verify') return
    let active = true
    void pb.collection('users').confirmVerification(token).then(() => true, () => false).then(ok => {
      if (!active) return
      setSuccess(ok)
      setMessage(ok ? 'Your email is verified. You can now sign in.' : 'This verification link is invalid or expired. Request a new verification email.')
      setBusy(false)
    })
    return () => { active = false }
  }, [kind, token])

  async function reset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const data = new FormData(event.currentTarget)
    const password = String(data.get('password'))
    const confirm = String(data.get('confirm'))
    if (password !== confirm) {
      setMessage('Passwords do not match.')
      return
    }
    setBusy(true)
    setMessage('')
    try {
      await pb.collection('users').confirmPasswordReset(token, password, confirm)
      setSuccess(true)
      setMessage('Your password has been reset. You can now sign in.')
    } catch {
      setMessage('Could not reset your password. The link may be invalid or expired; request a new one and try again.')
    } finally { setBusy(false) }
  }

  return <main className="account-link">
    <h1>{kind === 'verify' ? 'Verify your email' : 'Reset your password'}</h1>
    {kind === 'verify' && busy && <p>Verifying your email…</p>}
    {kind === 'reset-password' && !success && <form onSubmit={reset} method="post">
      <p id="password-help">Use at least 8 characters. Both fields are required.</p>
      <label htmlFor="new-password">New password<input id="new-password" name="password" type="password" autoComplete="new-password" minLength={8} aria-describedby="password-help" required /></label>
      <label htmlFor="confirm-password">Confirm password<input id="confirm-password" name="confirm" type="password" autoComplete="new-password" minLength={8} required /></label>
      <button type="submit" className="primary" aria-disabled={busy}>Reset password</button>
    </form>}
    <p role="status">{message}</p>
    {kind === 'verify' && !busy && !success && <p><a href="/?resend=verification">Resend verification email</a></p>}
    <a ref={backLink} href="/">Back to map</a>
  </main>
}
