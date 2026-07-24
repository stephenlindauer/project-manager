import { useState } from 'react'
import { useStore } from '../store'

export function Login() {
  const login = useStore((s) => s.login)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true); setError(null)
    try {
      await login(username, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid h-full place-items-center">
      <form
        onSubmit={submit}
        className="w-[320px] rounded-xl border border-accent/40 bg-panel p-6 shadow-[0_0_40px_-8px_var(--color-accent)]"
      >
        <h1 className="mb-1 text-center text-[13px] font-semibold uppercase tracking-[0.18em] text-accent glow-text">
          ProjectManager
        </h1>
        <p className="mb-5 text-center text-[11px] text-muted">Sign in to continue</p>

        <label className="mb-1 block text-[11px] text-muted">Username</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          autoComplete="username"
          className="mb-3 w-full rounded border border-line bg-bg px-2 py-1.5 outline-none focus:border-accent"
        />

        <label className="mb-1 block text-[11px] text-muted">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="mb-4 w-full rounded border border-line bg-bg px-2 py-1.5 outline-none focus:border-accent"
        />

        {error && (
          <div className="mb-3 rounded border border-bad/40 bg-bad/10 p-2 text-[11px] text-bad">{error}</div>
        )}

        <button
          type="submit"
          disabled={busy || !username || !password}
          className="w-full rounded border border-accent/60 bg-accent/15 py-1.5 text-[12px] text-ink hover:bg-accent/25 disabled:opacity-40"
        >{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  )
}
