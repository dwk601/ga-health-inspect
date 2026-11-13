import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@ui-sdk/react/dialog'
import { ClientResponseError } from 'pocketbase'
import { X } from 'lucide-react'
import { pb, errorMessage, refreshAuth } from './api'

export function AuthPanel({ open, accountRef, onClose, onSignedIn, initialRecovery = false }: { open: boolean; accountRef: RefObject<HTMLButtonElement | null>; onClose: () => void; onSignedIn: () => void; initialRecovery?: boolean }) {
  const [signup, setSignup] = useState(false)
  const [recovery, setRecovery] = useState<'reset' | 'verify' | null>(initialRecovery ? 'verify' : null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const emailRef = useRef<HTMLInputElement>(null)
  useEffect(() => { emailRef.current?.focus() }, [signup, recovery])
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (busy) return
    setBusy(true); setMessage('')
    const data = new FormData(e.currentTarget)
    const email = String(data.get('email')); const password = String(data.get('password'))
    try {
      if (recovery) {
        if (recovery === 'reset') await pb.collection('users').requestPasswordReset(email)
        else await pb.collection('users').requestVerification(email)
        setMessage('If the address is eligible, an email will be sent shortly.')
      } else if (signup) {
        await pb.collection('users').create({ name: data.get('name'), email, password, passwordConfirm: password })
        try {
          await pb.collection('users').requestVerification(email)
          setMessage('Account created. Check your email to verify your account, then sign in.')
        } catch (error) {
          if (!(error instanceof ClientResponseError) || error.status !== 429) throw error
          setMessage('Account created. You can resend verification later, then sign in.')
        }
      } else {
        await pb.collection('users').authWithPassword(email, password)
        await refreshAuth()
        if (!pb.authStore.isValid) throw new Error('Session refresh failed')
        onSignedIn()
      }
    } catch (error) { setMessage(errorMessage(error, recovery === 'reset' ? 'request a password reset' : recovery === 'verify' ? 'resend verification' : signup ? 'create your account or send verification' : 'sign in')) } finally { setBusy(false) }
  }
  const title = recovery === 'reset' ? 'Reset password' : recovery === 'verify' ? 'Resend verification email' : signup ? 'Create account' : 'Sign in'
  const switchTo = (next: { signup?: boolean; recovery?: 'reset' | 'verify' | null }) => { setSignup(next.signup ?? false); setRecovery(next.recovery ?? null); setMessage('') }
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose() }} modal={false} closeOnOutsidePress={false}>
    <DialogContent className="auth-panel" initialFocus="#auth-email" finalFocus={() => accountRef.current}>
      <div className="section-heading"><DialogTitle id="auth-title" aria-live="polite">{title}</DialogTitle><DialogClose className="icon-button" aria-label="Close"><X size={18} /></DialogClose></div>
      <p>{recovery === 'reset' ? 'Enter your email and we’ll send a reset link.' : recovery === 'verify' ? 'Enter your email and we’ll send a new verification link.' : 'Verify your email before posting a rating or comment.'}</p>
      <form onSubmit={submit} method="post">
        {signup && !recovery && <label htmlFor="auth-name">Name<input id="auth-name" name="name" autoComplete="name" maxLength={60} required /></label>}
        <label htmlFor="auth-email">Email<input ref={emailRef} id="auth-email" name="email" type="email" autoComplete="email" required /></label>
        {!recovery && <label htmlFor="auth-password">Password<input id="auth-password" name="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} minLength={8} aria-describedby={signup ? 'auth-password-help' : undefined} required />{signup && <small id="auth-password-help">At least 8 characters.</small>}</label>}
        <button type="submit" className="primary block" aria-disabled={busy}>{busy ? 'Please wait…' : recovery ? 'Send email' : signup ? 'Create account' : 'Sign in'}</button>
      </form>
      <p role="status" className="form-status">{message}</p>
      <div className="auth-links">
        {recovery ? <button className="text-button" onClick={() => switchTo({})}>Back to sign in</button> : <>
          <button className="text-button" onClick={() => switchTo({ signup: !signup })}>{signup ? 'Already have an account? Sign in' : 'New here? Create an account'}</button>
          {!signup && <><button className="text-button" onClick={() => switchTo({ recovery: 'reset' })}>Forgot password?</button><button className="text-button" onClick={() => switchTo({ recovery: 'verify' })}>Resend verification email</button></>}
        </>}
      </div>
    </DialogContent>
  </Dialog>
}
