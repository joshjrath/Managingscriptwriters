// One sign-in page for everyone, plus first-run setup of the first manager.

import type { WorkspaceTheme } from '../../../shared/palettes';
import { useMemo, useState } from 'react';
import { timeZoneList } from '../../../shared/cities';
import { api, type ApiError } from '../api';
import { Button, Field, FormError, inputProps, useFieldId } from '../components/ui';

export interface AuthStatus { signedIn: boolean; needsSetup: boolean; setupAllowed: boolean; setupHint: string | null; demo: boolean; orgName: string; theme?: WorkspaceTheme | null }

export function Login({ status, onDone, signedOut }: { status: AuthStatus; onDone: () => void; signedOut?: boolean }) {
  const setup = status.needsSetup;
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // setup step 2: the basics, with the device's time zone already picked
  const device = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'America/New_York'; } })();
  const [step, setStep] = useState<1 | 2>(1);
  const [org, setOrg] = useState(status.orgName || '');
  const [tz, setTz] = useState(device);
  const [cutoff, setCutoff] = useState('23:59');
  const zones = useMemo(() => timeZoneList(), []);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { n: useFieldId('n'), e: useFieldId('e'), p: useFieldId('p'), o: useFieldId('o'), z: useFieldId('z'), c: useFieldId('c') };
  const submit = async () => {
    if (setup && step === 1) {
      const e: Record<string, string> = {};
      if (!name.trim()) e.name = 'Enter your name';
      if (!/\S+@\S+\.\S+/.test(email)) e.email = 'Enter your email';
      if (password.length < 10) e.password = 'At least 10 characters';
      if (Object.keys(e).length) { setError(Object.assign(new Error('Check the highlighted fields'), { status: 400, fields: e }) as unknown as ApiError); return; }
      setError(null); setStep(2); return;
    }
    setBusy(true); setError(null);
    try {
      await api(setup ? '/api/auth/setup' : '/api/auth/login', { body: setup ? { name, email, password, orgName: org.trim() || undefined, timezone: tz, cutoff } : { email, password } });
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
        <p className="sub">{setup ? 'Create the first admin account. You can add managers and writers afterwards.' : 'Script production for the Scale Media team.'}</p>
        {signedOut && !setup && <div className="banner" role="status" style={{ marginBottom: 14 }}><div className="txt"><b>You were signed out</b><span>If an admin or manager reset your password, use the new one they sent you.</span></div></div>}
        {setup && !status.setupAllowed ? (
          <div className="form-error" role="alert"><span>{status.setupHint ?? 'Set MANAGER_EMAIL and MANAGER_PASSWORD in the server’s environment, then redeploy.'}</span></div>
        ) : (
          <form className="form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <FormError error={error && !Object.keys(f).length ? error : null} />
            {setup && step === 2 ? (
              <>
                <p className="muted" style={{ fontSize: 13.5 }}>Step 2 of 2 · the basics. You can change these in Settings later.</p>
                <Field label="Organisation name" htmlFor={ids.o} error={f.orgName}><input className="input" id={ids.o} value={org} onChange={(e) => setOrg(e.target.value)} autoFocus /></Field>
                <Field label="Head office time zone" htmlFor={ids.z} error={f.timezone} help={tz === device ? 'Detected from this device. Deadlines run on this clock.' : 'Deadlines run on this clock.'}>
                  <select className="select" id={ids.z} value={tz} onChange={(e) => setTz(e.target.value)}>
                    {[...new Set([device, ...zones])].map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
                  </select>
                </Field>
                <Field label="Deadlines end at" htmlFor={ids.c} error={f.cutoff} help="A script due on a day is on time until this time, head office time."><input className="input" type="time" id={ids.c} value={cutoff} onChange={(e) => setCutoff(e.target.value)} /></Field>
                <div className="row-flex s2">
                  <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
                  <Button type="submit" variant="primary pill lg" busy={busy}>Create workspace</Button>
                </div>
              </>
            ) : <>
            {setup && <Field label="Your name" htmlFor={ids.n} error={f.name}><input className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} {...inputProps(ids.n, f.name)} /></Field>}
            <Field label="Email" htmlFor={ids.e} error={f.email}><input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} {...inputProps(ids.e, f.email)} autoFocus /></Field>
            <Field label="Password" htmlFor={ids.p} error={f.password} help={setup ? 'At least 10 characters.' : undefined}><input className="input" type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} {...inputProps(ids.p, f.password)} /></Field>
            <Button type="submit" variant="primary pill lg block" busy={busy}>{setup ? 'Next: the basics' : 'Sign in'}</Button>
            {!setup && <p className="muted" style={{ fontSize: 12.5, textAlign: 'center' }}>Forgot your password? Ask your manager or admin to reset it.</p>}
            </>}
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
