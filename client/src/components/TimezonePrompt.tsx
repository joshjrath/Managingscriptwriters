// Everyone's own time zone. The first time someone opens the site after this
// arrived (or whenever their device moves to another zone) they're asked which
// time zone they're in, with their device's zone already picked. Saving it
// refreshes the site, so every time shown follows at once. It can be changed
// any time from the account menu ("Time zone").

import { useEffect, useMemo, useState } from 'react';
import { Globe2 } from 'lucide-react';
import { api, queryClient } from '../api';
import { cityLabel, CITIES, timeZoneList, zoneOffset } from '../../../shared/cities';
import { cutoffIn, fmtCutoff, fmtTimeZoneAbbr } from '../../../shared/format';
import { useBoot } from './Shell';
import { Button, Dialog, Field, FormError, useFieldId, useToast } from './ui';
import type { ApiError } from '../api';

const OPEN_EVENT = 'tz:open';
/** Opens the time zone dialog (from the account menu). */
export const openTimezoneDialog = () => window.dispatchEvent(new Event(OPEN_EVENT));

const deviceZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } };
const store = { get: (k: string) => { try { return localStorage.getItem(k) ?? sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string, session = false) => { try { (session ? sessionStorage : localStorage).setItem(k, v); } catch { /* ignore */ } } };

const zoneName = (tz: string) => {
  const city = CITIES.find((c) => c.timezone === tz);
  return `${tz.replace(/_/g, ' ')}${city ? ` (${cityLabel(city)})` : ''}`;
};

export function TimezonePrompt() {
  const { me, mode, timezone, settings } = useBoot();
  const device = deviceZone();
  const zones = useMemo(() => timeZoneList(), []);
  const [why, setWhy] = useState<null | 'first' | 'moved' | 'manual'>(null);

  // ask once: not confirmed yet, or the device is now somewhere else
  useEffect(() => {
    if (mode?.viewingAs) return;
    if (!timezone.confirmed) {
      if (!store.get(`sm.tz-later.${me.id}`)) setWhy('first');
    } else if (device && timezone.mine && device !== timezone.mine && zones.includes(device) && !store.get(`sm.tz-keep.${me.id}.${device}`)) {
      setWhy('moved');
    }
  }, [me.id, mode?.viewingAs, timezone.confirmed, timezone.mine, device, zones]);
  useEffect(() => {
    const on = () => setWhy('manual');
    window.addEventListener(OPEN_EVENT, on);
    return () => window.removeEventListener(OPEN_EVENT, on);
  }, []);

  if (!why) return null;
  const known = device && zones.includes(device) ? device : null;
  // first time: the device's zone is the best guess; afterwards, what they chose
  const initial = why === 'manual' ? timezone.mine ?? known ?? settings.timezone : known ?? timezone.mine ?? settings.timezone;
  const close = () => {
    if (why === 'first') store.set(`sm.tz-later.${me.id}`, '1', true);
    if (why === 'moved' && device) store.set(`sm.tz-keep.${me.id}.${device}`, '1');
    setWhy(null);
  };
  return <TimezoneDialog why={why} initial={initial} current={timezone.mine} device={device} zones={zones} onClose={close} onSaved={() => setWhy(null)} />;
}

function TimezoneDialog({ why, initial, current, device, zones, onClose, onSaved }: {
  why: 'first' | 'moved' | 'manual'; initial: string; current: string | null; device: string | null; zones: string[]; onClose: () => void; onSaved: () => void;
}) {
  const { settings, clock } = useBoot();
  const toast = useToast();
  const [tz, setTz] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const id = useFieldId('tz');
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t); }, []);
  const there = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', hour: 'numeric', minute: '2-digit' }).format(now);
  const cutoff = cutoffIn(settings.cutoff, settings.timezone, tz, clock.today);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      await api('/api/me/timezone', { body: { timezone: tz } });
      await queryClient.invalidateQueries();
      toast(`Times now show in ${fmtTimeZoneAbbr(tz)} (${tz.replace(/_/g, ' ')})`);
      onSaved();
    } catch (e) { setError(e as ApiError); } finally { setBusy(false); }
  };
  const title = why === 'moved' ? 'Are you in a new time zone?' : why === 'first' ? 'What time zone are you in?' : 'Your time zone';
  const sub = why === 'moved'
    ? `Your device is on ${device?.replace(/_/g, ' ')}, but your times show in ${current?.replace(/_/g, ' ')}.`
    : 'Messages, notifications, activity and the clock at the top will show in your time.';
  return (
    <Dialog open onClose={onClose} title={title} sub={sub} size="narrow"
      footer={<div className="form-actions">
        <Button variant="ghost" onClick={onClose}>{why === 'moved' ? `Keep ${current ? fmtTimeZoneAbbr(current) : 'mine'}` : why === 'first' ? 'Not now' : 'Cancel'}</Button>
        <Button variant="primary pill" busy={busy} icon={<Globe2 aria-hidden />} onClick={save}>{why === 'moved' ? 'Switch' : 'Use this time zone'}</Button>
      </div>}>
      <div className="form">
        <FormError error={error} />
        <Field label="Time zone" htmlFor={id} help={device && tz === device ? 'Detected from this device.' : undefined}>
          <select className="select" id={id} value={tz} onChange={(e) => setTz(e.target.value)}>
            {[...new Set([tz, ...(device ? [device] : []), ...zones])].map((z) => <option key={z} value={z}>{zoneName(z)} · {zoneOffset(z)}</option>)}
          </select>
        </Field>
        <div className="tz-preview">
          <b>It’s {there} there.</b>
          <span>{cutoff
            ? `Deadlines stay on the workspace’s time: due by ${fmtCutoff(settings.cutoff)} ${fmtTimeZoneAbbr(settings.timezone)}, which is ${cutoff} for you.`
            : `Deadlines are due by ${fmtCutoff(settings.cutoff)} ${fmtTimeZoneAbbr(settings.timezone)}, the same as your time.`}</span>
        </div>
      </div>
    </Dialog>
  );
}
