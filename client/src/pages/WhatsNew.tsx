// What's new: every change to the platform, newest first, since day one.
// Opening it clears the "new" dot in the sidebar for this person.

import { useEffect, useState } from 'react';
import { m } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import { api, queryClient } from '../api';
import type { Bootstrap } from '../../../shared/types';
import { CHANGELOG, LATEST_CHANGE, ONLY_FOR, TECHNICAL, type Audience, type ChangeTag } from '../../../shared/changelog';
import { isManager } from '../../../shared/workflow';
import { fmtDateYear } from '../../../shared/format';
import { PageHeader, useBoot } from '../components/Shell';
import { Chip, Panel, Seg } from '../components/ui';

const TAG: Record<ChangeTag, { label: string; color: string }> = {
  new: { label: 'New', color: 'mint' },
  improved: { label: 'Improved', color: 'cyan' },
  fixed: { label: 'Fixed', color: 'yellow' },
};

export function WhatsNewPage() {
  const { whatsNewSeen, me } = useBoot();
  // what was new before this visit, kept for the whole visit so the highlight survives the dot clearing
  const [firstUnseen] = useState(() => (whatsNewSeen ? Math.max(0, CHANGELOG.findIndex((e) => e.id === whatsNewSeen)) : Math.min(CHANGELOG.length, 5)));
  const mine: Audience = isManager(me.role) ? 'managers' : me.role === 'editor' ? 'editors' : 'writers';
  const [all, setAll] = useState(false);
  const forMe = (id: string) => !TECHNICAL.has(id) && (!ONLY_FOR[id] || ONLY_FOR[id].includes(mine));
  const shown = CHANGELOG.map((e, i) => ({ e, i })).filter(({ e }) => all || forMe(e.id));
  useEffect(() => {
    if (whatsNewSeen === LATEST_CHANGE) return;
    api('/api/me/whats-new', { body: { seen: LATEST_CHANGE } })
      .then(() => queryClient.setQueryData<Bootstrap>(['bootstrap'], (b) => (b ? { ...b, whatsNewSeen: LATEST_CHANGE } : b)))
      .catch(() => { /* the dot just stays until next time */ });
  }, [whatsNewSeen]);
  return (
    <>
      <PageHeader title="What’s new" sub={all ? `Every change to Scale Media since day one · ${CHANGELOG.length} updates` : `What changed for ${mine === 'managers' ? 'managers' : mine === 'editors' ? 'editors' : 'writers'} · ${shown.length} updates`} hideNewWork>
        <Seg role="group" aria-label="Which updates">
          <button aria-pressed={!all} onClick={() => setAll(false)}>For you</button>
          <button aria-pressed={all} onClick={() => setAll(true)}>Everything</button>
        </Seg>
      </PageHeader>
      <div className="changelog">
        {shown.map(({ e, i }) => (
          <m.div key={e.id} className="cl-entry" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: [0.23, 1, 0.32, 1], delay: Math.min(i, 6) * 0.06 }}>
            <div className="cl-date">
              <span className="dot" aria-hidden />
              <span>{fmtDateYear(e.date)}</span>
              {i < firstUnseen && <Chip color="salmon" solid icon={<Sparkles aria-hidden />}>New for you</Chip>}
            </div>
            <Panel title={e.title} sub={e.summary}>
              <ul className="cl-list">
                {e.changes.map((c, j) => (
                  <li key={j}><Chip color={TAG[c.tag].color}>{TAG[c.tag].label}</Chip><span>{c.text}</span></li>
                ))}
              </ul>
            </Panel>
          </m.div>
        ))}
      </div>
    </>
  );
}
