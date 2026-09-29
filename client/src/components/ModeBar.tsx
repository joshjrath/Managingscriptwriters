// Admin tools for recording tutorials: View as (see the site as anyone,
// view only) and Recording mode (a practice copy where anything goes and
// nothing is kept). The floating bar says which is on and can shrink to a
// small dot so it stays out of the way on camera.

import { useEffect, useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { Eye, Minimize2, Undo2, Users } from 'lucide-react';
import { api, ApiError, queryClient } from '../api';
import { isManager, ROLE_LABEL } from '../../../shared/workflow';
import type { SessionMode } from '../../../shared/types';
import type { Role } from '../../../shared/workflow';
import { Avatar, Button, Dialog, FormError } from './ui';
import { SPRING } from '../motion';
import { useBoot } from './Shell';

/** Reload into the new view, staying on this page when the new person can open it. */
function reloadAs(role: Role) {
  queryClient.clear();
  const path = window.location.pathname;
  const blocked = (path.startsWith('/log') && role !== 'owner') || (path.startsWith('/settings') && !isManager(role));
  if (blocked) window.location.assign(isManager(role) ? '/overview' : '/my-work');
  else window.location.reload();
}

export function useModeActions() {
  const [busy, setBusy] = useState<null | 'recording' | 'view'>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const run = async (kind: 'recording' | 'view', path: string, body: Record<string, unknown> = {}, role?: (s: SessionMode) => Role) => {
    setBusy(kind);
    setError(null);
    try {
      const s = await api<SessionMode>(path, { body });
      reloadAs(role ? role(s) : s.viewingAs?.role ?? 'owner');
    } catch (err) {
      setError(err as ApiError);
      setBusy(null);
    }
  };
  return {
    busy, error,
    viewAs: (userId: number) => run('view', '/api/admin/view-as', { userId }),
    stopViewing: () => run('view', '/api/admin/view-as/stop'),
    startRecording: () => run('recording', '/api/admin/recording/start'),
    stopRecording: () => run('recording', '/api/admin/recording/stop'),
  };
}

export function ModeBar() {
  const { mode } = useBoot();
  const [small, setSmall] = useState(() => {
    try { return sessionStorage.getItem('sm.modebar') === 'small'; } catch { return false; }
  });
  const [picker, setPicker] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const act = useModeActions();
  useEffect(() => {
    try { sessionStorage.setItem('sm.modebar', small ? 'small' : 'full'); } catch { /* ignore */ }
  }, [small]);
  if (!mode || (!mode.viewingAs && !mode.recording)) return null;
  const rec = !!mode.recording;
  const who = mode.viewingAs;

  return (
    <>
      <AnimatePresence mode="wait" initial={false}>
        {small ? (
          <m.button key="dot" className={`mode-dot${rec ? ' rec' : ''}`} onClick={() => setSmall(false)}
            initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={SPRING}
            aria-label={`${rec ? 'Recording mode is on' : ''}${rec && who ? ', ' : ''}${who ? `viewing as ${who.name}` : ''}. Show controls`}>
            {rec ? <i className="rec-dot" aria-hidden /> : <Eye size={16} aria-hidden />}
          </m.button>
        ) : (
          <m.div key="bar" className={`mode-bar${rec ? ' rec' : ''}`} role="region" aria-label={rec ? 'Recording mode' : 'Viewing as'}
            initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }} transition={SPRING}>
            {rec && (
              <span className="mode-part">
                <i className="rec-dot" aria-hidden />
                <span><b>Recording mode</b><span className="mode-sub">Practice copy · nothing is saved</span></span>
              </span>
            )}
            <span className="mode-part">
              {who ? <Avatar name={who.name} id={who.id} small /> : <Eye size={16} aria-hidden />}
              <span>
                <b>{who ? `Viewing as ${who.name}` : `You (${mode.realName})`}</b>
                <span className="mode-sub">{who ? `${who.roleLabel}${rec ? '' : ' · view only'}` : 'Admin'}</span>
              </span>
            </span>
            <span className="mode-actions">
              <Button variant="ghost sm" icon={<Users aria-hidden />} onClick={() => setPicker(true)}>Switch person</Button>
              {who && <Button variant="ghost sm" icon={<Undo2 aria-hidden />} busy={act.busy === 'view'} onClick={act.stopViewing}>Back to me</Button>}
              {rec && <Button variant="sm" onClick={() => setConfirmOff(true)}>Turn off</Button>}
              <button className="icon-btn sm" onClick={() => setSmall(true)} aria-label="Shrink to a dot" title="Shrink to a dot"><Minimize2 size={15} /></button>
            </span>
          </m.div>
        )}
      </AnimatePresence>
      <ViewAsDialog open={picker} onClose={() => setPicker(false)} />
      <Dialog open={confirmOff} onClose={() => setConfirmOff(false)} title="Turn off Recording mode?" size="narrow"
        footer={<div className="form-actions"><Button variant="ghost" onClick={() => setConfirmOff(false)}>Keep recording</Button><Button variant="primary" busy={act.busy === 'recording'} onClick={act.stopRecording}>Turn off and discard</Button></div>}>
        <p className="muted" style={{ margin: 0 }}>Everything you did while recording is thrown away, and you’re back on the real workspace exactly as you left it.</p>
        <FormError error={act.error} />
      </Dialog>
    </>
  );
}

/** Pick anyone on the team to see the site as them. */
export function ViewAsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { users, mode } = useBoot();
  const act = useModeActions();
  if (!mode) return null;
  const current = mode.viewingAs?.id ?? mode.realId;
  const people = users.filter((u) => u.active && !u.removed).sort((a, b) => (a.id === mode.realId ? -1 : b.id === mode.realId ? 1 : a.name.localeCompare(b.name)));
  return (
    <Dialog open={open} onClose={onClose} title="View as" size="narrow"
      sub={mode.recording ? 'In Recording mode you can click anything as them. It’s all thrown away when you turn recording off.' : 'See exactly what they see. It’s view only: turn on Recording mode to click through actions too.'}>
      <FormError error={act.error} />
      <div className="viewas-list">
        {people.map((u) => (
          <button key={u.id} className={`viewas-row${u.id === current ? ' on' : ''}`} disabled={!!act.busy} aria-current={u.id === current || undefined}
            onClick={() => (u.id === current ? onClose() : u.id === mode.realId ? act.stopViewing() : act.viewAs(u.id))}>
            <Avatar name={u.name} id={u.id} />
            <span className="who"><b>{u.id === mode.realId ? `${u.name} (you)` : u.name}</b><span>{ROLE_LABEL[u.role]}</span></span>
            {u.id === current && <span className="chip">Now</span>}
          </button>
        ))}
      </div>
    </Dialog>
  );
}

/** "Making a practice copy" while Recording mode starts. */
export function RecordingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const act = useModeActions();
  return (
    <Dialog open={open} onClose={onClose} title="Recording mode" size="narrow"
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={act.busy === 'recording'} onClick={act.startRecording}>Start recording mode</Button></div>}>
      <div className="stack s2">
        <p style={{ margin: 0 }}>Makes a private practice copy of the whole workspace for tutorials. Send scripts, approve, drag shoots, add clients, and view as anyone to click through what they’d do.</p>
        <p className="muted" style={{ margin: 0 }}>Nobody else sees any of it. When you turn it off, everything you did is thrown away. It also ends when you sign out.</p>
        <FormError error={act.error} />
      </div>
    </Dialog>
  );
}
