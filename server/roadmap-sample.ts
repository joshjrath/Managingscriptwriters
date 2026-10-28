// The first roadmap the team uploaded (Scale Media, November 2026), as Claude reads it: the demo workspace starts
// with it, and the tests read it with a stand-in for Claude. Its shape is RoadmapSchema's in server/roadmaps.ts.

type Step = 'brief' | 'script' | 'approval' | 'thumbnail_draft' | 'film' | 'results' | 'rough_edit' | 'final_thumbnail' | 'final_edit' | 'schedule' | 'publish' | 'review';
type Role = 'approver' | 'writer' | 'host' | 'thumbnail' | 'editor';

/** One week's deliverables, from its days: brief, script, approval, film, rough edit, final thumbnail, final edit, publish, reviews. */
function week(d: { brief: string; script: string; approve: string; film: string; rough: string; thumb: string; final: string; publish: string; check: string; review: string }) {
  const t = (step: Step, title: string, date: string, role: Role, time: string | null = null) => ({ step, title, date, time, role });
  return [
    t('brief', 'Brief and title concept locked', d.brief, 'approver'),
    t('script', 'Script draft with sources', d.script, 'writer'),
    t('approval', 'Approve script', d.approve, 'approver'),
    t('thumbnail_draft', 'Thumbnail draft', d.approve, 'thumbnail'),
    t('film', 'Film and deliver footage', d.film, 'host'),
    t('rough_edit', 'Rough edit', d.rough, 'editor'),
    t('final_thumbnail', 'Final thumbnail', d.thumb, 'thumbnail'),
    t('final_edit', 'Final edit approved', d.final, 'approver', '12:00'),
    t('schedule', 'Upload checked and scheduled', d.final, 'approver'),
    t('publish', 'Publish', d.publish, 'approver', '12:00'),
    t('review', '48-hour check', d.check, 'approver'),
    t('review', '7-day review', d.review, 'approver'),
  ];
}

export const NOVEMBER_2026_ROADMAP = {
  title: 'Scale Media November 2026 YouTube Roadmap',
  month: '2026-11',
  brand: 'Scale Media',
  summary: '4 weekly uploads for law firm owners and dental practice owners. Build on the revenue ceilings video with practical demonstrations: each upload gives owners a specific decision to consider and invites them to book a Scale Media strategy call.',
  timezone: 'America/New_York',
  defaultTime: '17:00',
  standardTimes: 'All dates are in 2026. Deadlines are 5 PM Eastern unless shown otherwise. Film Tuesday from 10 AM to 12 PM. Approve the final edit Monday by 12 PM and schedule the upload by 5 PM. Publish Tuesday at 12 PM.',
  roles: [
    { key: 'approver', label: 'Josh', person: 'Josh', responsibility: 'Approve briefs and releases; return consolidated feedback.' },
    { key: 'writer', label: 'Writer', person: null, responsibility: 'Research and scripts; update Week 1 with the real results.' },
    { key: 'host', label: 'Host', person: null, responsibility: 'Film the episode and capture thumbnail photos.' },
    { key: 'thumbnail', label: 'Thumbnail designer', person: null, responsibility: 'Draft and final thumbnail based on the agreed concept.' },
    { key: 'editor', label: 'Assigned editor', person: null, responsibility: 'Edit all 4 uploads; check footage and deliver final exports.' },
  ],
  videos: [
    {
      title: 'I Let 10 Strangers Choose Their Lawyer', publishDate: '2026-11-03', publishTime: '12:00', tag: 'Lawyers',
      format: 'A real choice experiment', runtime: '10–14 min',
      idea: 'Give 10 people the same fictional car accident scenario. Show them 3 real personal injury firms in 1 city. Ask who they would contact and why.',
      why: 'An owner can predict the winner, then see which details actually influence the participants. Their responses give us specific parts of a firm’s presentation to improve.',
      beats: [
        { title: 'Set up the choice', body: 'Show the 3 firms. Ask viewers to pick a winner and record the host’s prediction.' },
        { title: 'Watch the decisions', body: 'Show participants browsing the firms’ public pages and explaining their choices.' },
        { title: 'Reveal the result', body: 'Count the selections and explain what influenced this group.' },
        { title: 'Demonstrate a fix', body: 'Rebuild 1 weak point exposed by the responses, such as a confusing profile or introduction video.' },
      ],
      thumbnailText: 'WHO GETS THE CASE?',
      thumbnailConcept: 'The host beside 3 firm cards and a selection cursor. Save the winner for the video.',
      prep: 'Choose the city and firms by October 22. Recruit participants and capture the pages by October 26. Use the same prompt and equivalent browsing access for everyone; rotate the order of the firms. Record consent to use the responses. The first script covers the setup and interview questions; add the real results after filming and match the published title to the actual participant count.',
      tasks: [
        ...week({ brief: '2026-10-22', script: '2026-10-23', approve: '2026-10-26', film: '2026-10-27', rough: '2026-10-29', thumb: '2026-10-30', final: '2026-11-02', publish: '2026-11-03', check: '2026-11-05', review: '2026-11-10' }),
        { step: 'results', title: 'Results and closing analysis', date: '2026-10-28', time: '12:00', role: 'writer' },
      ],
    },
    {
      title: 'I Built a Dentist’s Marketing Plan From Their Competitors’ Worst Reviews', publishDate: '2026-11-10', publishTime: '12:00', tag: 'Dentists',
      format: 'A research and strategy demonstration', runtime: '10–14 min',
      idea: 'Read recent low rated reviews across competing practices in 1 local market. Use recurring complaints to build a marketing plan for a demonstration dental practice.',
      why: 'Owners see specific patient concerns turned into useful content. The finished plan shows how we would give a practice a clear reason for patients to choose it.',
      beats: [
        { title: 'Find the pattern', body: 'Open with a recurring complaint and show the review sample behind it.' },
        { title: 'Choose an opportunity', body: 'Identify a concern the demonstration practice can truthfully address, such as unclear fees.' },
        { title: 'Build the content', body: 'Write a positioning statement, 6 video concepts, and 1 complete opening on screen.' },
        { title: 'Reveal the plan', body: 'Show the finished calendar and the evidence needed to support its promises.' },
      ],
      thumbnailText: 'THEY TOLD YOU WHY',
      thumbnailConcept: 'The host turning a large 1 star review card into a content calendar. Blur reviewer identities and unrelated practice details.',
      prep: 'Choose the market and a fixed sampling method by October 29. Save the sources and dates. Preserve context when paraphrasing reviews and describe them as reported experiences. Prepare the source sheet and finished plan before the shoot, and define what the demonstration practice can deliver.',
      tasks: week({ brief: '2026-10-29', script: '2026-10-30', approve: '2026-11-02', film: '2026-11-03', rough: '2026-11-05', thumb: '2026-11-06', final: '2026-11-09', publish: '2026-11-10', check: '2026-11-12', review: '2026-11-17' }),
    },
    {
      title: '$0 vs $3,000 vs $10,000 Law Firm Marketing', publishDate: '2026-11-17', publishTime: '12:00', tag: 'Lawyers',
      format: 'A budget exercise', runtime: '12–16 min',
      idea: 'Build a marketing plan for the same hypothetical law firm at $0, $3,000, and $10,000 in monthly cash spending. Keep the city, practice area, and goals consistent.',
      why: 'An owner can compare the plans with their current spending. Each budget reveals what we would fund next and how much work the owner would still need to do.',
      beats: [
        { title: 'Set the challenge', body: 'Introduce the firm and show 3 budget columns. Every expense must solve a defined problem.' },
        { title: 'Build the $0 plan', body: 'Use the owner’s time and existing equipment. Show the weekly workload and enquiry route.' },
        { title: 'Allocate $3,000', body: 'Choose what to delegate first and show the tradeoff with spending on distribution.' },
        { title: 'Allocate $10,000', body: 'Build a larger system, explain when to expand distribution, and compare all 3 workloads.' },
      ],
      thumbnailText: 'WHAT WOULD YOU BUY?',
      thumbnailConcept: 'The same law firm beneath 3 budget columns. Use the episode’s whiteboard or screen as the visual basis.',
      prep: 'Define the hypothetical firm and available owner time by November 5. Build all 3 plans and check their totals. Amounts are illustrative monthly USD budgets; display cost assumptions and use verified quotes for named suppliers. Keep owner time visible in the $0 plan and show assumptions for any projected returns.',
      tasks: week({ brief: '2026-11-05', script: '2026-11-06', approve: '2026-11-09', film: '2026-11-10', rough: '2026-11-12', thumb: '2026-11-13', final: '2026-11-16', publish: '2026-11-17', check: '2026-11-19', review: '2026-11-24' }),
    },
    {
      title: 'If a Celebrity Dentist Opened Next Door, I’d Do This', publishDate: '2026-11-24', publishTime: '12:00', tag: 'Dentists',
      format: 'A hypothetical competitive challenge', runtime: '10–14 min',
      idea: 'A celebrity dentist with a major online audience opens beside a small local practice. Give the host a fixed set of resources and build the smaller practice’s 30 day response.',
      why: 'Owners can picture the threat and compare the host’s decisions with their own. The challenge shows how we would build a recognizable local presence under pressure.',
      beats: [
        { title: 'Introduce the threat', body: 'Place both practices on a map. Explain the hypothetical scenario and the local practice’s limits.' },
        { title: 'Choose an advantage', body: 'Pick a patient group the practice can serve well and a strength it can demonstrate.' },
        { title: 'Build the response', body: 'Develop a recurring series and write its first opening. Explain how viewers reach the practice.' },
        { title: 'Reveal the 30 day plan', body: 'Show the calendar and first posts. Decide where the next dollar or hour should go.' },
      ],
      thumbnailText: 'NEXT DOOR?',
      thumbnailConcept: 'A huge creator profile beside a modest local dental office, with the host between them. Use an invented celebrity dentist for the scenario.',
      prep: 'Build the fictional map and both practice briefs by November 12. Fix the smaller practice’s capabilities and budget before scripting. Support every promise with evidence available within the scenario. Prepare the finished calendar and example posts before the shoot.',
      tasks: week({ brief: '2026-11-12', script: '2026-11-13', approve: '2026-11-16', film: '2026-11-17', rough: '2026-11-19', thumb: '2026-11-20', final: '2026-11-23', publish: '2026-11-24', check: '2026-11-26', review: '2026-12-01' }),
    },
  ],
  workflow: [
    { when: 'Thursday and Friday', what: 'Lock the brief on Thursday. Deliver the full script draft with sources on Friday by 5 PM.' },
    { when: 'Monday', what: 'Josh returns notes by 10 AM. Approve the script and first thumbnail draft by 5 PM.' },
    { when: 'Tuesday and Wednesday', what: 'Film Tuesday from 10 AM to 12 PM; hand off footage by 5 PM. Flag missing files Wednesday by 10 AM.' },
    { when: 'Thursday and Friday', what: 'Deliver the rough edit Thursday by 5 PM. Josh returns notes Friday by 12 PM; final thumbnail is due by 5 PM.' },
    { when: 'Following Monday and Tuesday', what: 'Revised edit is due Monday at 10 AM; approve by 12 PM. Schedule by 5 PM for Tuesday at 12 PM.' },
  ],
  checklist: [
    'Watch the full export and complete upload checks',
    'Confirm the title, thumbnail, captions, and any chapters',
    'Test the booking link on mobile; use a tracked link for each video',
    'Check the live page after publication',
  ],
  contingency: [
    'For Week 1, confirm participant access by October 26. Add the real results by October 28 at 12 PM and match the title to the participant count.',
    'If interviews fall through, swap with the review episode and bring its research forward.',
    'Flag missing research or approvals as soon as the gap is clear. Adjust the scope in the brief while keeping the video’s central promise.',
  ],
  notes: [
    'Close every video with an invitation to book a Scale Media strategy call.',
    'Move the November 26 check to November 25 if the team is off for US Thanksgiving.',
    'Compare click through rate within the same traffic sources and retention through the reveal. Record booking visits and qualified enquiries where available.',
    'Research reference: American Dental Association, Online Reviews.',
  ],
};
