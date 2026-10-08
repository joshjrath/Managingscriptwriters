// Review queue: one card per document a writer sent (or per writer's scripts
// when nothing was attached), with approve all / send back / approve with my
// edits. Below it, everything sent back that the writer still has to revise.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCheck, RotateCcw } from 'lucide-react';
import { api } from '../api';
import type { ReviewGroup, ReviewQueue } from '../../../shared/types';
import { isManager } from '../../../shared/workflow';
import { plural } from '../../../shared/format';
import { PageHeader, useBoot } from '../components/Shell';
import { Empty, ErrorState, Loading, Panel } from '../components/ui';
import { CardList, SendDialog, SentBackCard, WaitingCard } from '../components/Review';

export function ReviewPage() {
  const { me } = useBoot();
  const manager = isManager(me.role);
  const q = useQuery({ queryKey: ['review'], queryFn: () => api<ReviewQueue>('/api/review'), refetchInterval: 60_000 });
  const [resend, setResend] = useState<ReviewGroup | null>(null);
  const scripts = (gs: ReviewGroup[]) => gs.reduce((n, g) => n + g.scripts.length, 0);
  return (
    <>
      <PageHeader title="Review queue" sub={manager ? 'Each card is one document from one writer. Approve it, or send it back with your notes and edits.' : 'What’s waiting for a manager, and what’s been sent back.'} />
      {q.isLoading && <Loading />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && (
        <div className="stack" style={{ gap: 'var(--gap)' }}>
          <Panel title="In review" count={scripts(q.data.waiting) || undefined} sub={q.data.waiting.length ? `${plural(scripts(q.data.waiting), 'script')} in ${plural(q.data.waiting.length, 'document')}` : undefined}>
            {!q.data.waiting.length ? <Empty boxed icon={<CheckCheck />} title="Nothing in review">When a writer sends their scripts (a PDF or a Google Doc link), it shows up here as one card.</Empty> : (
              <div className="stack s4"><CardList groups={q.data.waiting}>{(g) => <WaitingCard group={g} />}</CardList></div>
            )}
          </Panel>
          <Panel title="Sent back" count={scripts(q.data.sentBack) || undefined} sub={q.data.sentBack.length ? `${plural(scripts(q.data.sentBack), 'script')} · waiting on the writer` : undefined}>
            {!q.data.sentBack.length ? <Empty boxed icon={<RotateCcw />} title="Nothing waiting on revisions" /> : (
              <div className="stack s4">
                <CardList groups={q.data.sentBack}>{(g) => <SentBackCard group={g} onResend={g.writerId === me.id ? () => setResend(g) : undefined} />}</CardList>
              </div>
            )}
          </Panel>
        </div>
      )}
      {resend && <SendDialog batchId={resend.batch.id} batchTitle={resend.batch.title} candidates={resend.scripts} preselect={resend.scripts.map((s) => s.id)} resend onClose={() => setResend(null)} />}
    </>
  );
}
