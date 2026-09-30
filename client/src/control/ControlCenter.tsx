// The Control Center route. Loaded on its own (with three.js) only when
// someone goes looking for it. Nothing is shown until the server says this
// sign-in is cleared, and the world itself is only served to a cleared one.

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource-variable/geist-mono';
import './control.css';
import { api, ApiError } from '../api';
import type { ControlStatus, ControlWorld } from '../../../shared/control';
import { clearDeparture, returnToSite } from './leave';
import { Experience, type SyncInfo } from './Experience';
import { sound } from './sound';

type Stage = 'wait' | 'portal' | 'denied' | 'init' | 'live';

export default function ControlCenter() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [stage, setStage] = useState<Stage>('wait');
  const [fresh, setFresh] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [engineReady, setEngineReady] = useState(false);
  const [bootGone, setBootGone] = useState(false);
  const sync = useRef<SyncInfo>({ at: Date.now(), skew: 0, ok: 0, total: 0, packets: 0 });

  useEffect(() => {
    // the public site has drained away; this black is ours now
    const t = setTimeout(clearDeparture, 60);
    const title = document.title;
    document.title = 'Control Center';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#010206');
    return () => { clearTimeout(t); document.title = title; document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#0B0B0D'); };
  }, []);

  const status = useQuery({
    queryKey: ['control-status'], queryFn: () => api<ControlStatus>('/api/control/status'), staleTime: 0, retry: 1, refetchOnWindowFocus: false,
  });
  useEffect(() => {
    const s = status.data;
    if (!s || stage !== 'wait') return;
    if (s.cleared) setStage('init');
    else if (s.signedIn && !s.eligible) setStage('denied');
    else setStage('portal');
  }, [status.data, stage]);

  const world = useQuery({
    queryKey: ['control-world'],
    queryFn: async () => {
      const sent = Date.now();
      sync.current.total++;
      const w = await api<ControlWorld>('/api/control/world');
      const got = Date.now();
      sync.current = { at: got, skew: new Date(w.generatedAt).getTime() - (sent + got) / 2, ok: sync.current.ok + 1, total: sync.current.total, packets: sync.current.packets + 1 };
      return w;
    },
    enabled: stage === 'init' || stage === 'live',
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    retry: (n, err) => !(err instanceof ApiError && err.status === 403) && n < 3,
  });
  // clearance ended (locked elsewhere, expired): back to the portal
  useEffect(() => {
    if (world.error instanceof ApiError && world.error.status === 403) {
      void qc.invalidateQueries({ queryKey: ['control-status'] });
      setStage('portal');
      setBootGone(false);
      setEngineReady(false);
    }
  }, [world.error, qc]);

  const exit = () => {
    setLeaving(true);
    sound.sleep();
    // signing in at the portal also signed in to the site: let it notice
    qc.removeQueries({ queryKey: ['auth-status'] });
    qc.removeQueries({ queryKey: ['bootstrap'] });
    setTimeout(() => returnToSite(() => nav('/')), 650);
  };
  const lock = async () => {
    await api('/api/control/lock', { method: 'POST', body: {} }).catch(() => {});
    qc.removeQueries({ queryKey: ['control-world'] });
    await qc.invalidateQueries({ queryKey: ['control-status'] });
    setBootGone(false);
    setEngineReady(false);
    setStage('portal');
  };

  const w = world.data;
  return (
    <div className="cc" style={leaving ? { opacity: 0, transition: 'opacity 600ms cubic-bezier(0.65,0,0.35,1)' } : undefined}>
      {w && (stage === 'init' || stage === 'live') && (
        <Experience world={w} live={stage === 'live'} returning={!fresh} sync={sync.current}
          onReady={() => setEngineReady(true)} onExit={exit} onLock={lock} />
      )}
      {!bootGone && (
        <div className={`cc-boot${stage === 'live' ? ' fade' : ''}`} onAnimationEnd={(e) => { if (e.target === e.currentTarget && stage === 'live') setBootGone(true); }}>
          {stage === 'wait' && (status.isError ? <Unreachable onRetry={() => status.refetch()} onExit={exit} /> : <Scanning />)}
          {stage === 'portal' && status.data && (
            <Portal status={status.data} onExit={exit} onDenied={() => setStage('denied')}
              onAuthorized={() => { setFresh(true); void qc.invalidateQueries({ queryKey: ['control-status'] }); setStage('init'); }} />
          )}
          {stage === 'denied' && <Denied onExit={exit} />}
          {stage === 'init' && (
            <Init fresh={fresh} operator={status.data?.operator?.callsign ?? null} world={w ?? null} error={world.isError && !(world.error instanceof ApiError && world.error.status === 403)}
              engineReady={engineReady} onDone={() => setStage('live')} />
          )}
        </div>
      )}
    </div>
  );
}

function Scanning() {
  return <div className="cc-portal" aria-busy="true"><div className="req"><i />ESTABLISHING CHANNEL</div></div>;
}

function Unreachable({ onRetry, onExit }: { onRetry: () => void; onExit: () => void }) {
  return (
    <div className="cc-denied" role="alert">
      <b>NETWORK UNREACHABLE</b>
      <p>THE CONTROL CENTER COULDN’T REACH THE SERVER. CHECK THE CONNECTION AND TRY AGAIN.</p>
      <div className="actions" style={{ display: 'flex', gap: 28 }}><button onClick={onRetry}>RETRY</button><button onClick={onExit}>← RETURN</button></div>
    </div>
  );
}

function Denied({ onExit }: { onExit: () => void }) {
  useEffect(() => { sound.denied(); }, []);
  return (
    <div className="cc-denied" role="alert">
      <b>CLEARANCE INSUFFICIENT</b>
      <p>THIS SYSTEM IS LIMITED TO THE ADMIN OF THE SCALE MEDIA NETWORK.</p>
      <button onClick={onExit}>← RETURN TO THE SITE</button>
    </div>
  );
}

function Portal({ status, onAuthorized, onDenied, onExit }: { status: ControlStatus; onAuthorized: () => void; onDenied: () => void; onExit: () => void }) {
  const needsEmail = !status.signedIn;
  const [email, setEmail] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [shake, setShake] = useState(0);
  const keyRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  useEffect(() => { (needsEmail ? emailRef : keyRef).current?.focus(); }, [needsEmail]);
  const submit = async () => {
    if (!key || (needsEmail && !email)) return;
    setBusy(true);
    setMsg({ text: 'VERIFYING' });
    try {
      await api('/api/control/authorize', { body: needsEmail ? { email, password: key } : { password: key } });
      sound.authorized();
      setMsg({ text: 'IDENTITY VERIFIED' });
      setTimeout(onAuthorized, 380);
    } catch (e) {
      const err = e as ApiError;
      setKey('');
      setBusy(false);
      if (err.code === 'clearance') { onDenied(); return; }
      sound.denied();
      setShake((n) => n + 1);
      setMsg({ err: true, text: err.code === 'throttled' ? 'CHANNEL LOCKED · RETRY IN 15 MIN' : err.status === 401 ? 'KEY REJECTED' : err.status === 400 ? (err.fields.email ? 'IDENTIFY YOURSELF' : 'KEY REQUIRED') : err.status === 0 ? 'NETWORK UNREACHABLE' : 'AUTHORIZATION FAILED' });
      keyRef.current?.focus();
    }
  };
  return (
    <div className={`cc-portal${shake ? ' shake' : ''}`} key={shake}>
      <div className="hd">
        <b>SCALE MEDIA</b>
        <span>INTERNAL NETWORK</span>
      </div>
      <div className="req"><i aria-hidden />AUTHORIZATION REQUIRED</div>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {needsEmail && (
          <div className="cc-field">
            <label htmlFor="cc-op">OPERATOR</label>
            <input ref={emailRef} id="cc-op" type="email" autoComplete="username" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
          </div>
        )}
        <div className="cc-field">
          <label htmlFor="cc-key">{status.operator ? `KEY · ${status.operator.callsign}` : 'KEY'}</label>
          <input ref={keyRef} id="cc-key" type="password" autoComplete="current-password" value={key} onChange={(e) => setKey(e.target.value)} disabled={busy} style={{ caretColor: 'var(--ice)' }} />
          <span className="scan" aria-hidden />
        </div>
        <div className={`msg${msg?.err ? ' err' : ''}`} role="status" aria-live="assertive">{msg?.text ?? ''}</div>
        <div className="actions">
          <button type="button" onClick={onExit}>← RETURN</button>
          <button type="submit" disabled={busy || !key || (needsEmail && !email)}>AUTHORIZE</button>
        </div>
      </form>
      <div className="note">
        {status.operator ? `OPERATOR ${status.operator.name.toUpperCase()} · CONFIRM WITH YOUR PASSWORD` : 'ADMIN ONLY · SIGN IN WITH YOUR PLATFORM ACCOUNT'}
        {status.demo ? <><br />DEMO WORKSPACE · THE DEMO PASSWORD WORKS HERE</> : null}
      </div>
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The initialization sequence: each line is a real step finishing, never a fake wait. */
function Init({ fresh, operator, world, error, engineReady, onDone }: { fresh: boolean; operator: string | null; world: ControlWorld | null; error: boolean; engineReady: boolean; onDone: () => void }) {
  const lines = [
    { label: fresh ? 'IDENTITY VERIFIED' : 'CLEARANCE ACTIVE', value: operator ?? '', done: true },
    { label: 'OPENING PRIVATE NETWORK', value: world ? world.source.kind === 'simulated' ? 'SIMULATED' : 'LIVE' : '', done: !!world },
    { label: 'LOCATING GLOBAL NODES', value: world ? pad(world.writers.length) : '', done: !!world },
    { label: 'SYNCHRONIZING TIMEZONES', value: world ? `${pad(new Set(world.writers.map((w) => w.timezone)).size)} ZONES` : '', done: !!world },
    { label: 'LINKING ACTIVE OPERATIONS', value: world ? pad(world.projects.filter((p) => !p.archived).length) : '', done: !!world },
    { label: 'CONTROL CENTER ONLINE', value: '', done: !!world && engineReady },
  ];
  const [shown, setShown] = useState(1);
  const step = fresh ? 210 : 110;
  useEffect(() => {
    if (shown < lines.length && lines[shown - 1].done) {
      const t = setTimeout(() => setShown((n) => n + 1), step);
      return () => clearTimeout(t);
    }
    if (shown === lines.length && lines[lines.length - 1].done) {
      const t = setTimeout(onDone, fresh ? 420 : 200);
      return () => clearTimeout(t);
    }
  });
  const doneCount = lines.slice(0, shown).filter((l) => l.done).length;
  return (
    <div className="cc-init" role="status" aria-live="polite">
      {lines.slice(0, shown).map((l) => (
        <div key={l.label} className={l.done ? 'done' : ''}>
          <b>{l.label}</b>
          <span>{l.done ? l.value || '✓' : error ? 'RETRYING' : '···'}</span>
        </div>
      ))}
      <div className="bar"><i style={{ transform: `scaleX(${doneCount / lines.length})` }} /></div>
    </div>
  );
}
