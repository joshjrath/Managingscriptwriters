// App shell: inset sidebar, page header, notifications, search, account menu,
// mobile drawer, and the context that holds the signed-in bootstrap payload.

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isAdmin, isManager, ROLE_LABEL } from '../../../shared/workflow';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bell, Building2, CalendarDays, ClipboardCheck, Columns3, FolderOpen, KeyRound, LayoutDashboard, LogOut, Menu,
  Circle, Eye, Globe2, Library, MessageCircle, PanelLeftClose, PanelLeftOpen, PenLine, Plus, ScrollText, Search, Settings, Sparkles, Users, Wand2,
} from 'lucide-react';
import { LayoutGroup, m } from 'framer-motion';
import { api, queryClient, useSave } from '../api';
import type { Bootstrap, Notification, SearchResults } from '../../../shared/types';
import { fmtStamp, fmtTimeZoneAbbr } from '../../../shared/format';
import { nowInZone } from '../../../shared/dates';
import { Avatar, Button, Dialog, Field, FormError, inputProps, useFieldId, useToast } from './ui';
import { NewWorkDialog, type NewWorkTab, type NewWorkPreset } from './NewWork';
import { MomentsHost } from './Moments';
import { ModeBar, RecordingDialog, RecordingOffDialog, ViewAsDialog } from './ModeBar';
import { SPRING, setMotionEnabled, useMotionSetting } from '../motion';
import { LATEST_CHANGE } from '../../../shared/changelog';
import { ControlCenterLink } from '../control/Link';
import { ChatProvider, useInbox } from './Chat';
import { openTimezoneDialog, TimezonePrompt } from './TimezonePrompt';

// ── bootstrap context ────────────────────────────────────────────────────

const BootCtx = createContext<Bootstrap | null>(null);
export function useBoot(): Bootstrap {
  const b = useContext(BootCtx);
  if (!b) throw new Error('useBoot outside provider');
  return b;
}

/** The time zone to show times in: the person's own, or the workspace's until they've set one. */
export function useDisplayTz(): string {
  const b = useBoot();
  return b.timezone?.mine ?? b.settings.timezone;
}
export const useIsManager = () => isManager(useBoot().me.role);

const NewWorkCtx = createContext<(tab?: NewWorkTab, preset?: NewWorkPreset) => void>(() => {});
export const useNewWork = () => useContext(NewWorkCtx);

export function useUserName() {
  const { users } = useBoot();
  return useMemo(() => {
    const m = new Map(users.map((u) => [u.id, u.name]));
    return (id: number | null | undefined) => (id == null ? 'Unassigned' : m.get(id) ?? 'Unknown');
  }, [users]);
}

// ── shell ────────────────────────────────────────────────────────────────

export function AppShell({ boot }: { boot: Bootstrap }) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('sm.rail') === 'collapsed'; } catch { return false; }
  });
  const [expanded, setExpanded] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [newWork, setNewWork] = useState<{ tab: NewWorkTab; preset?: NewWorkPreset } | null>(null);
  const loc = useLocation();
  useEffect(() => { setDrawer(false); }, [loc.pathname]);
  useEffect(() => { window.scrollTo(0, 0); }, [loc.pathname]);

  const toggle = () => {
    // at medium widths the rail starts collapsed; the toggle expands it instead
    if (window.matchMedia('(max-width: 1180px)').matches) { setExpanded((e) => !e); return; }
    setCollapsed((c) => {
      try { localStorage.setItem('sm.rail', c ? 'open' : 'collapsed'); } catch { /* ignore */ }
      return !c;
    });
  };
  const railCollapsed = collapsed || (!expanded && typeof window !== 'undefined' && window.matchMedia('(max-width: 1180px)').matches);

  return (
    <BootCtx.Provider value={boot}>
      <NewWorkCtx.Provider value={(tab = 'shoot', preset) => setNewWork({ tab, preset })}>
        <ChatProvider>
        <div className={`app${collapsed ? ' collapsed' : ''}${expanded ? ' expanded' : ''}${boot.mode?.recording ? ' recording' : ''}`}>
          <aside className="sidebar" aria-label="Main navigation">
            <Rail onToggle={toggle} collapsed={railCollapsed} />
          </aside>
          <div className="mobile-bar">
            <button className="icon-btn" onClick={() => setDrawer(true)} aria-label="Open navigation"><Menu /></button>
            <span className="wordmark"><span className="full">Scale</span>&nbsp;<span>Media</span></span>
            <div className="end">
              {isManager(boot.me.role) && <button className="icon-btn" onClick={() => setNewWork({ tab: 'shoot' })} aria-label="New work"><Plus /></button>}
              <NotificationsButton />
            </div>
          </div>
          {drawer && <MobileNav onClose={() => setDrawer(false)} />}
          <main className="page-main" id="main">
            <div key={loc.pathname} className="page-enter"><Outlet /></div>
          </main>
        </div>
        <NewWorkDialog state={newWork} onClose={() => setNewWork(null)} />
        <MomentsHost />
        <TimezonePrompt />
        <ModeBar />
        </ChatProvider>
      </NewWorkCtx.Provider>
    </BootCtx.Provider>
  );
}

function MobileNav({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} className="nav-drawer drawer-nav" aria-label="Navigation" onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <Rail mobile />
    </dialog>
  );
}

function Rail({ onToggle, collapsed, mobile }: { onToggle?: () => void; collapsed?: boolean; mobile?: boolean }) {
  const boot = useBoot();
  const { me, counts, settings, mode } = boot;
  const manager = isManager(me.role);
  const inbox = useInbox();
  const items: { to: string; label: string; icon: ReactNode; count?: number; hot?: boolean; show?: boolean }[] = [
    ...(manager
      ? [{ to: '/overview', label: 'Overview', icon: <LayoutDashboard />, count: counts.attention || undefined, hot: counts.attention > 0 }, { to: '/my-work', label: 'My work', icon: <PenLine />, count: counts.myOpenScripts || undefined }]
      : [{ to: '/my-work', label: 'My work', icon: <PenLine />, count: counts.myOpenScripts || undefined }, { to: '/overview', label: 'Overview', icon: <LayoutDashboard /> }]),
    { to: '/production', label: 'Production', icon: <Columns3 /> },
    { to: '/calendar', label: 'Calendar', icon: <CalendarDays /> },
    { to: '/clients', label: 'Clients', icon: <Building2 /> },
    { to: '/review', label: 'Review queue', icon: <ClipboardCheck />, count: manager ? counts.reviewQueue || undefined : undefined },
    { to: '/writers', label: manager ? 'Writers' : 'Messages', icon: manager ? <Users /> : <MessageCircle />, count: (inbox.data?.unread ?? counts.unreadMessages) || undefined, hot: (inbox.data?.unread ?? counts.unreadMessages) > 0 },
    { to: '/scripts', label: 'Script bank', icon: <Library /> },
    { to: '/resources', label: 'Resources', icon: <FolderOpen /> },
  ];
  return (
    <div className="rail">
      <NavLink to={manager ? '/overview' : '/my-work'} className="wordmark" aria-label="Scale Media home">
        <span className="full">Scale</span>
        <span className="full">&nbsp;</span>
        <span>{collapsed && !mobile ? 'S' : 'Media'}</span>
      </NavLink>
      {isAdmin(me.role) && !mode?.viewingAs && !mobile && <ControlCenterLink />}
      <SearchBox />
      <LayoutGroup id={mobile ? 'nav-mobile' : 'nav'}>
        <nav className="nav">
          {items.map((it) => (
            <NavItem key={it.to} to={it.to} icon={it.icon} label={it.label} collapsed={collapsed}>
              {it.count != null && <span className={`count${it.hot ? ' hot' : ''}`} aria-label={`${it.count} ${it.to === '/review' ? 'awaiting review' : it.to === '/overview' ? 'need attention' : it.to === '/writers' ? 'unread messages' : 'open scripts'}`}>{it.count}</span>}
              {it.hot && <span className="dot-badge" aria-hidden />}
            </NavItem>
          ))}
          {manager && (
            <>
              <div className="nav-label">Manage</div>
              <NavItem to="/settings" icon={<Settings />} label="Settings" collapsed={collapsed} />
            </>
          )}
        </nav>
        <div className="side-foot">
          {settings.isDemo && <div className="demo-flag"><b>Demo workspace.</b> Sample data only — separate from your real workspace.</div>}
          {isAdmin(me.role) && (
            <nav className="nav" aria-label="Admin">
              <NavItem to="/log" icon={<ScrollText />} label="Master log" collapsed={collapsed} />
            </nav>
          )}
          <UserMenu />
          {onToggle && !mobile && (
            <button className="collapse-btn" onClick={onToggle} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
              {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
              <span className="label">Collapse</span>
            </button>
          )}
          <NavLink to="/whats-new" className={({ isActive }) => `collapse-btn whats-new${isActive ? ' on' : ''}`} title={collapsed ? 'What’s new' : undefined}>
            <Sparkles size={17} aria-hidden />
            <span className="label">What’s new</span>
            {boot.whatsNewSeen !== LATEST_CHANGE && <span className="new-dot" aria-label="New updates" />}
          </NavLink>
        </div>
      </LayoutGroup>
    </div>
  );
}

/** A sidebar link; the highlight glides between links as you move around. */
function NavItem({ to, icon, label, collapsed, children }: { to: string; icon: ReactNode; label: string; collapsed?: boolean; children?: ReactNode }) {
  return (
    <NavLink to={to} className={({ isActive }) => (isActive ? 'active' : '')} title={collapsed ? label : undefined}>
      {({ isActive }) => (
        <>
          {isActive && <m.span layoutId="nav-pill" className="nav-pill" transition={SPRING} />}
          {icon}
          <span className="label">{label}</span>
          {children}
        </>
      )}
    </NavLink>
  );
}

function UserMenu() {
  const { me, mode } = useBoot();
  const tzNow = useDisplayTz();
  const motionOn = useMotionSetting();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState(false);
  const [viewAs, setViewAs] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingOff, setRecordingOff] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false), open);
  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    queryClient.clear();
    window.location.href = '/';
  };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="me-card" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <Avatar name={me.name} id={me.id} />
        <span className="who">
          <b className="ellipsis">{me.name}</b>
          <span>{ROLE_LABEL[me.role]}</span>
        </span>
      </button>
      {open && (
        <div className="menu" role="menu">
          {mode && (
            <>
              <button role="menuitem" onClick={() => { setViewAs(true); setOpen(false); }}><Eye />View as…</button>
              <button role="menuitemcheckbox" aria-checked={!!mode.recording} onClick={() => { setOpen(false); if (mode.recording) setRecordingOff(true); else setRecording(true); }}>
                <Circle />Recording mode<span className={`switch${mode.recording ? ' on' : ''}`} aria-hidden><i /></span>
              </button>
            </>
          )}
          {!mode?.viewingAs && <button role="menuitem" onClick={() => { setPw(true); setOpen(false); }}><KeyRound />Change password</button>}
          {!mode?.viewingAs && <button role="menuitem" onClick={() => { setOpen(false); openTimezoneDialog(); }}><Globe2 />Time zone<span className="menu-hint">{fmtTimeZoneAbbr(tzNow)}</span></button>}
          <button role="menuitemcheckbox" aria-checked={motionOn} onClick={() => setMotionEnabled(!motionOn)}><Wand2 />Animations<span className={`switch${motionOn ? ' on' : ''}`} aria-hidden><i /></span></button>
          <button role="menuitem" onClick={logout}><LogOut />Sign out</button>
        </div>
      )}
      <PasswordDialog open={pw} onClose={() => setPw(false)} />
      {mode && <ViewAsDialog open={viewAs} onClose={() => setViewAs(false)} />}
      {mode && <RecordingDialog open={recording} onClose={() => setRecording(false)} />}
      {mode && <RecordingOffDialog open={recordingOff} onClose={() => setRecordingOff(false)} />}
    </div>
  );
}

function PasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const a = useFieldId('pw-cur');
  const b = useFieldId('pw-new');
  const save = useSave((v: { current: string; next: string }) => api('/api/me/password', { body: v }), {
    onSuccess: () => { toast('Password changed. Other sessions were signed out.'); setCurrent(''); setNext(''); onClose(); },
  });
  const f = save.error?.fields ?? {};
  return (
    <Dialog open={open} onClose={onClose} title="Change password" size="narrow"
      footer={<div className="form-actions"><Button onClick={onClose} variant="ghost">Cancel</Button><Button variant="primary" busy={save.isPending} onClick={() => save.mutate({ current, next })}>Save password</Button></div>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); save.mutate({ current, next }); }}>
        <FormError error={save.error && !Object.keys(f).length ? save.error : null} />
        <Field label="Current password" htmlFor={a} error={f.current}><input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} {...inputProps(a, f.current)} /></Field>
        <Field label="New password" htmlFor={b} error={f.next} help="At least 10 characters."><input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} {...inputProps(b, f.next)} /></Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function useOutside(ref: React.RefObject<HTMLElement | null>, fn: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) fn(); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') fn(); };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [active, fn, ref]);
}

// ── search ───────────────────────────────────────────────────────────────

function SearchBox() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  useOutside(ref, () => setOpen(false), open);
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 200); return () => clearTimeout(t); }, [q]);
  const res = useQuery({ queryKey: ['search', debounced], queryFn: () => api<SearchResults>(`/api/search?q=${encodeURIComponent(debounced)}`), enabled: debounced.length > 0 });
  const go = (path: string) => { setOpen(false); setQ(''); nav(path); };
  const r = res.data;
  const none = r && !r.clients.length && !r.batches.length && !r.resources.length;
  return (
    <div className="side-search" ref={ref} role="search">
      <Search aria-hidden />
      <input
        type="search" placeholder="Search…" value={q} aria-label="Search clients, batches and resources"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Enter' && r?.batches[0]) go(`/batches/${r.batches[0].id}`); }}
      />
      {open && debounced && (
        <div className="search-pop" aria-live="polite">
          {res.isLoading && <div className="empty">Searching…</div>}
          {res.isError && <div className="empty">Search failed. Try again.</div>}
          {none && <div className="empty">Nothing matches “{debounced}”.</div>}
          {!!r?.clients.length && <><h4>Clients</h4>{r.clients.map((c) => <button className="res" key={c.id} onClick={() => go(`/clients/${c.id}`)}><span className="t">{c.name}</span>{c.status === 'archived' && <span className="s">Archived</span>}{c.status === 'prospect' && <span className="s">Potential client</span>}</button>)}</>}
          {!!r?.batches.length && <><h4>Batches</h4>{r.batches.map((b) => <button className="res" key={b.id} onClick={() => go(`/batches/${b.id}`)}><span className="t">{b.title}</span><span className="s">{b.clientName}</span></button>)}</>}
          {!!r?.resources.length && <><h4>Resources</h4>{r.resources.map((x) => <button className="res" key={x.id} onClick={() => go(`/resources?q=${encodeURIComponent(x.title)}`)}><span className="t">{x.title}</span><span className="s">{x.clientName}</span></button>)}</>}
        </div>
      )}
    </div>
  );
}

// ── notifications ────────────────────────────────────────────────────────

const NOTE_COLOR: Record<string, string> = {
  overdue: 'var(--red)', blocker: 'var(--red)', deadline: 'var(--yellow)', deadline_change: 'var(--yellow)', review_request: 'var(--lavender)',
  revision_request: 'var(--pink)', planning: 'var(--salmon)', approval: 'var(--mint)', delivery: 'var(--mint)', assignment: 'var(--cyan)', todo: 'var(--salmon)', todo_done: 'var(--mint)',
};

export function NotificationsButton({ className = '' }: { className?: string }) {
  const displayTz = useDisplayTz();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  useOutside(ref, () => setOpen(false), open);
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api<{ notifications: Notification[]; unread: number }>('/api/notifications'), refetchInterval: 60_000 });
  const read = useSave((v: { ids?: number[]; all?: boolean }) => api('/api/notifications/read', { body: v }));
  const unread = q.data?.unread ?? 0;
  return (
    <div ref={ref} style={{ position: 'relative' }} className={className}>
      <button className="icon-btn bell" onClick={() => setOpen((o) => !o)} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} aria-haspopup="dialog">
        <Bell />
        {unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Notifications">
          <div className="popover-head">
            <h3>Notifications</h3>
            <span className="spacer" />
            {unread > 0 && <Button variant="ghost sm" onClick={() => read.mutate({ all: true })} busy={read.isPending}>Mark all read</Button>}
          </div>
          {q.isLoading && <div className="empty">Loading…</div>}
          {q.isError && <div className="empty">Couldn’t load notifications.</div>}
          {q.data && !q.data.notifications.length && <div className="empty"><b>You’re all caught up</b><span>Assignments, reviews, deadline changes and deliveries show up here.</span></div>}
          {q.data?.notifications.map((n) => (
            <button key={n.id} className={`notif${n.readAt ? ' read' : ''}`} style={{ ['--c' as string]: NOTE_COLOR[n.type] ?? 'var(--cyan)' }}
              onClick={() => { if (!n.readAt) read.mutate({ ids: [n.id] }); setOpen(false); if (n.link) nav(n.link); }}>
              <i className="d" aria-hidden />
              <span style={{ minWidth: 0 }}>
                <div className="t">{n.title}</div>
                {n.body && <div className="b">{n.body}</div>}
                <div className="w">{fmtStamp(n.createdAt, displayTz)}{n.readAt ? '' : ' · unread'}</div>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── page header ──────────────────────────────────────────────────────────

export function PageHeader({ title, sub, crumbs, children, hideNewWork }: { title: ReactNode; sub?: ReactNode; crumbs?: ReactNode; children?: ReactNode; hideNewWork?: boolean }) {
  const displayTz = useDisplayTz();
  const { me, settings } = useBoot();
  const openNew = useNewWork();
  useEffect(() => { if (typeof title === 'string') document.title = `${title} · Scale Media`; }, [title]);
  return (
    <header className="page-head">
      <div style={{ minWidth: 0 }}>
        {crumbs && <div className="crumbs">{crumbs}</div>}
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      <div className="head-tools">
        {children}
        <OrgDate tz={displayTz} hq={settings.timezone} />
        {isManager(me.role) && !hideNewWork && <Button variant="primary pill lg" icon={<Plus aria-hidden />} onClick={() => openNew('shoot')}>New work</Button>}
        <NotificationsButton />
      </div>
    </header>
  );
}

/** Today and the time in your own time zone; when that isn't HQ's, HQ's time underneath. */
function OrgDate({ tz, hq }: { tz: string; hq: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t); }, []);
  const { date, minutes } = nowInZone(tz, now);
  const d = new Date(date + 'T12:00:00Z');
  const label = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  // a different zone with the same clock (Toronto and New York) doesn't need a second line
  const at = nowInZone(hq, now);
  const sameClock = at.date === date && at.minutes === minutes;
  const hqTime = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: hq });
  const hqDay = at.date === date ? '' : ` · ${new Date(at.date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })}`;
  return (
    <span className="clock-stack">
      <time className="today-date" dateTime={date}>{label} · {time} {fmtTimeZoneAbbr(tz, now)}</time>
      {!sameClock && <span className="hq-time" title={`Workspace time zone: ${hq.replace(/_/g, ' ')}. Deadlines follow this time.`}><i aria-hidden />HQ · {hqTime} {fmtTimeZoneAbbr(hq, now)}{hqDay}</span>}
    </span>
  );
}
