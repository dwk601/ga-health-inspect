import { useEffect, useRef, useState } from 'react'
import { requestAI } from './api'
import type { AIAnswer, AISelection } from './types'

export function InspectionExplanation({ selections, task = 'explain' }: { selections: AISelection[]; task?: 'explain' | 'compare' }) {
  const [answer, setAnswer] = useState<AIAnswer | null>(null)
  const [translation, setTranslation] = useState<AIAnswer | null>(null)
  const [language, setLanguage] = useState<'en' | 'es'>('en')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState(false)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  async function explain(target: 'en' | 'es' = 'en') {
    controller.current?.abort()
    const next = new AbortController(); controller.current = next
    setBusy(true); setError('')
    try {
      const data = await requestAI<AIAnswer>('explain', { task, selections, language: target }, next.signal)
      if (!next.signal.aborted) {
        if (target === 'es') { setTranslation(data); if (data.original) setAnswer(data.original) }
        else { setAnswer(data); setTranslation(null) }
        setLanguage(target)
      }
    } catch (failure) {
      if (!next.signal.aborted) setError((failure as Error).message)
    } finally { if (!next.signal.aborted) setBusy(false) }
  }
  const displayed = language === 'es' && translation ? translation : answer
  return <div className="ai-explanation">
    {task === 'compare' && <p className="muted">Optional AI help sends these public inspection records to the configured AI provider, not your account or device location.</p>}
    <div className="ai-actions"><button type="button" disabled={busy} onClick={() => void explain()}>{busy ? 'Explaining…' : task === 'compare' ? 'Explain differences with AI' : 'Explain findings with AI'}</button>{busy && <button type="button" onClick={() => { controller.current?.abort(); setBusy(false) }}>Cancel</button>}</div>
    <p role="status">{error}</p>
    {answer && <>
      <h3>AI explanation</h3>
      <p className="muted">May contain mistakes. Citations identify records, not proof of each claim. This is not an assessment of current safety or a score interpretation.</p>
      <div className="ai-actions" role="group" aria-label="Explanation language">
        <button type="button" aria-pressed={language === 'en'} onClick={() => { controller.current?.abort(); setBusy(false); setLanguage('en') }}>English</button>
        <button type="button" lang="es" aria-pressed={language === 'es'} disabled={busy} onClick={() => { if (translation) setLanguage('es'); else void explain('es') }}>Español</button>
      </div>
      {language === 'es' && <p>Machine translation of the English AI explanation. The official report is unchanged.</p>}
      <ul>{displayed?.bullets.map((bullet, index) => <li key={index}><span lang={language}>{bullet.text}</span><ul className="ai-citations">{bullet.citations.map(id => {
        const source = answer.sources.find(item => item.id === id)
        return source && <li key={id}>{source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.label} (original report)</a> : <span>{source.label} (record on this page)</span>}</li>
      })}</ul></li>)}</ul>
      <button type="button" aria-expanded={report} onClick={() => setReport(!report)}>Check this explanation</button>
      {report && <p>Do not rely on uncertain AI text. Check the original report using the citations above and contact the issuing authority about its records. No report has been submitted by this app.</p>}
    </>}
  </div>
}
