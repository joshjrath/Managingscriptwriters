// One sign-in page for everyone, plus first-run setup of the first manager.

import { useState } from 'react';
import { api, type ApiError } from '../api';
import { Button, Field, FormError, inputProps, useFieldId } from '../components/ui';

export interface AuthStatus { signedIn: boolean; needsSetup: boolean; setupAllowed: boolean; setupHint: string | null; demo: boolean; orgName: string }

export function Login({ status, onDone }: { status: AuthStatus; onDone: () => void }) {
  const setup = status.needsSetup;
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { n: useFieldId('n'), e: useFieldId('e'), p: useFieldId('p') };
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await api(setup ? '/api/auth/setup' : '/api/auth/login', { body: setup ? { name, email, password } : { email, password } });
      onDone();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const f = error?.fields ?? {};
  return (
    <main className="login">
      <div className="login-card">
        <div className="wordmark"><span className="full" style={{ color: '#fff' }}>Scale</span>&nbsp;<span>Media</span></div>
        <h1>{setup ? 'Set up your workspace' : 'Sign in'}</h1>
        <p className="sub">{setup ? 'Create the first manager account. You can add writers afterwards.' : 'Script production for the Scale Media team.'}</p>
        {setup && !status.setupAllowed ? (
          <div className="form-error" role="alert"><span>{status.setupHint ?? 'Set MANAGER_EMAIL and MANAGER_PASSWORD in the server’s environment, then redeploy.'}</span></div>
        ) : (
          <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <FormError error={error && !Object.keys(f).length ? error : null} />
            {setup && <Field label="Your name" htmlFor={ids.n} error={f.name}><input className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} {...inputProps(ids.n, f.name)} /></Field>}
            <Field label="Email" htmlFor={ids.e} error={f.email}><input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} {...inputProps(ids.e, f.email)} autoFocus /></Field>
            <Field label="Password" htmlFor={ids.p} error={f.password} help={setup ? 'At least 10 characters.' : undefined}><input className="input" type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} {...inputProps(ids.p, f.password)} /></Field>
            <Button type="submit" variant="primary pill lg block" busy={busy}>{setup ? 'Create manager account' : 'Sign in'}</Button>
          </form>
        )}
        {status.demo && (
          <div className="login-note">
            <b>Demo workspace</b> — sample data only, stored separately from your real workspace.<br />
            Manager: <code>josh@scalemedia.demo</code> · Writer: <code>sarah@scalemedia.demo</code><br />
            Password for both: <code>scalemedia-demo</code>
          </div>
        )}
      </div>
    </main>
  );
}
