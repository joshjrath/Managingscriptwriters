// Ordered migrations. Never edit a shipped migration; append a new one.

export const MIGRATIONS: string[] = [
  /* 1 · initial schema */ `
create table settings (
  id int primary key default 1 check (id = 1),
  org_name text not null default 'Scale Media',
  timezone text not null default 'America/New_York',
  cutoff text not null default '23:59',
  draft_offset_days int not null default 5 check (draft_offset_days between 0 and 60),
  final_offset_days int not null default 3 check (final_offset_days between 0 and 60),
  day_mode text not null default 'calendar' check (day_mode in ('calendar', 'business')),
  working_days jsonb not null default '[1,2,3,4,5]',
  reminder_lead_days int not null default 2 check (reminder_lead_days between 0 and 14),
  is_demo boolean not null default false,
  reminders_last_run_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into settings (id) values (1);

create table users (
  id bigint generated always as identity primary key,
  email text not null,
  name text not null,
  role text not null check (role in ('manager', 'writer')),
  password_hash text not null,
  active boolean not null default true,
  capacity_per_day numeric check (capacity_per_day is null or capacity_per_day > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index users_email_key on users (lower(email));

create table sessions (
  token_hash text primary key,
  user_id bigint not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now()
);
create index sessions_user_idx on sessions (user_id);

create table clients (
  id bigint generated always as identity primary key,
  name text not null,
  status text not null default 'active' check (status in ('active', 'archived')),
  owner_id bigint references users(id),
  description text,
  brand_voice text,
  guidance text,
  created_by bigint references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index clients_name_key on clients (lower(name));

create table files (
  id bigint generated always as identity primary key,
  filename text not null,
  mime text not null,
  size int not null,
  sha256 text not null,
  data bytea not null,
  uploaded_by bigint not null references users(id),
  created_at timestamptz not null default now()
);

create table briefings (
  id bigint generated always as identity primary key,
  client_id bigint not null references clients(id),
  title text not null,
  call_date date,
  recording_url text,
  document_url text,
  summary text,
  instructions text,
  created_by bigint references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index briefings_client_idx on briefings (client_id);

create table shoots (
  id bigint generated always as identity primary key,
  client_id bigint not null references clients(id),
  title text,
  start_date date not null,
  end_date date,
  location text,
  notes text,
  created_by bigint references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cancelled_at timestamptz,
  check (end_date is null or end_date >= start_date)
);
create index shoots_client_idx on shoots (client_id);

create table batches (
  id bigint generated always as identity primary key,
  client_id bigint not null references clients(id),
  shoot_id bigint references shoots(id),
  title text not null,
  brief text,
  target_count int not null check (target_count between 1 and 500),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  planned_start date,
  draft_due date,
  draft_due_mode text not null default 'manual' check (draft_due_mode in ('auto', 'manual')),
  final_due date,
  final_due_mode text not null default 'manual' check (final_due_mode in ('auto', 'manual')),
  needs_date_review boolean not null default false,
  date_review_note text,
  blocked boolean not null default false,
  blocker_note text,
  blocked_at timestamptz,
  blocked_by bigint references users(id),
  next_action text,
  created_by bigint references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index batches_client_idx on batches (client_id);
create index batches_shoot_idx on batches (shoot_id);

create table batch_briefings (
  batch_id bigint not null references batches(id) on delete cascade,
  briefing_id bigint not null references briefings(id) on delete cascade,
  primary key (batch_id, briefing_id)
);

create table deliveries (
  id bigint generated always as identity primary key,
  batch_id bigint not null references batches(id),
  confirmed_by bigint not null references users(id),
  confirmed_at timestamptz not null default now(),
  timeliner_url text,
  note text
);
create index deliveries_batch_idx on deliveries (batch_id);

create table scripts (
  id bigint generated always as identity primary key,
  batch_id bigint not null references batches(id),
  number int not null check (number > 0),
  title text,
  assignee_id bigint references users(id),
  status text not null default 'not_started'
    check (status in ('not_started', 'in_progress', 'ready_for_review', 'revisions_needed', 'approved', 'delivered')),
  doc_url text,
  timeliner_url text,
  notes text,
  version int not null default 1,
  submitted_at timestamptz,
  approved_at timestamptz,
  approved_by bigint references users(id),
  delivered_at timestamptz,
  delivered_by bigint references users(id),
  delivery_id bigint references deliveries(id),
  removed_at timestamptz,
  removed_by bigint references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, number)
);
create index scripts_batch_idx on scripts (batch_id);
create index scripts_assignee_idx on scripts (assignee_id);

create table revision_requests (
  id bigint generated always as identity primary key,
  script_id bigint not null references scripts(id),
  batch_id bigint not null references batches(id),
  note text not null,
  requested_by bigint not null references users(id),
  requested_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by bigint references users(id),
  resolution text
);
create index revisions_script_idx on revision_requests (script_id);
create index revisions_open_idx on revision_requests (batch_id) where resolved_at is null;

create table resources (
  id bigint generated always as identity primary key,
  client_id bigint not null references clients(id),
  briefing_id bigint references briefings(id),
  batch_id bigint references batches(id),
  kind text not null check (kind in ('link', 'file')),
  category text not null default 'other' check (category in ('folder', 'example', 'asset', 'recording', 'document', 'other')),
  title text not null,
  url text,
  file_id bigint references files(id),
  notes text,
  created_by bigint not null references users(id),
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  check ((kind = 'link' and url is not null) or (kind = 'file' and file_id is not null))
);
create index resources_client_idx on resources (client_id);

create table activity (
  id bigint generated always as identity primary key,
  client_id bigint references clients(id),
  batch_id bigint references batches(id),
  entity_type text not null,
  entity_id bigint,
  actor_id bigint references users(id),
  action text not null,
  summary text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index activity_batch_idx on activity (batch_id, created_at desc);
create index activity_client_idx on activity (client_id, created_at desc);

create table notifications (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  link text,
  dedupe_key text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create unique index notifications_dedupe_key on notifications (user_id, dedupe_key);
create index notifications_user_idx on notifications (user_id, created_at desc);
`,

  /* 2 · owner role, readable temporary passwords, removing people from the team */ `
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('owner', 'manager', 'writer'));
alter table users add column temp_password text;
alter table users add column removed_at timestamptz;
update users set role = 'owner' where id = (select min(id) from users where role = 'manager');
`,

  /* 3 · scripts sent as one document, reviews with attachments, master log */ `
create table submissions (
  id bigint generated always as identity primary key,
  batch_id bigint not null references batches(id),
  writer_id bigint references users(id),
  submitted_by bigint not null references users(id),
  version int not null default 1,
  previous_id bigint references submissions(id),
  url text,
  file_id bigint references files(id),
  note text,
  created_at timestamptz not null default now(),
  check (url is not null or file_id is not null)
);
create index submissions_batch_idx on submissions (batch_id);
create table submission_scripts (
  submission_id bigint not null references submissions(id) on delete cascade,
  script_id bigint not null references scripts(id),
  primary key (submission_id, script_id)
);
create index submission_scripts_script_idx on submission_scripts (script_id);
create table reviews (
  id bigint generated always as identity primary key,
  batch_id bigint not null references batches(id),
  submission_id bigint references submissions(id),
  action text not null check (action in ('approved', 'revisions')),
  script_ids jsonb not null,
  note text,
  url text,
  file_id bigint references files(id),
  reviewed_by bigint not null references users(id),
  created_at timestamptz not null default now()
);
create index reviews_batch_idx on reviews (batch_id);
alter table revision_requests add column review_id bigint references reviews(id);
create table audit_log (
  id bigint generated always as identity primary key,
  user_id bigint references users(id),
  kind text not null check (kind in ('view', 'auth', 'denied')),
  summary text not null,
  link text,
  ip text,
  created_at timestamptz not null default now()
);
create index audit_log_created_idx on audit_log (created_at desc);
create index audit_log_user_idx on audit_log (user_id, created_at desc);
`,
  // 4 · celebration moments (shown once, the next time someone opens the app), What's new, and writers' progress counters
  `
create table moments (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id),
  kind text not null check (kind in ('approved','revisions','drafts_done','batch_done','team_drafts_done','team_batch_done')),
  batch_id bigint references batches(id),
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text unique,
  created_at timestamptz not null default now(),
  seen_at timestamptz
);
create index moments_unseen_idx on moments (user_id, created_at) where seen_at is null;
alter table users add column whats_new_seen text;
-- a writer's own "written so far" count: an update for their manager, separate from script statuses
create table writer_progress (
  batch_id bigint not null references batches(id),
  user_id bigint not null references users(id),
  written int not null check (written >= 0),
  updated_at timestamptz not null default now(),
  primary key (batch_id, user_id)
);
`,
  // 5 · shoots can be scheduled before their scripts are planned; remind managers ahead of time
  `
alter table settings add column plan_reminder_days int not null default 14 check (plan_reminder_days between 3 and 60);
`,
  // 6 · potential clients: tracked alongside clients until they sign
  `
alter table clients drop constraint if exists clients_status_check;
alter table clients add constraint clients_status_check check (status in ('prospect', 'active', 'archived'));
alter table clients add column became_client_at timestamptz;
`,
  // 7 · store file contents uncompressed so downloads can be streamed in pieces cheaply
  `
alter table files alter column data set storage external;
`,
  // 8 · past scripts: documents from before the platform, added to the Script bank by hand
  `
create table past_documents (
  id bigint generated always as identity primary key,
  client_id bigint not null references clients(id),
  title text not null,
  file_id bigint references files(id),
  url text,
  writer_id bigint references users(id),
  writer_name text,
  script_count int check (script_count between 1 and 1000),
  written_on date,
  note text,
  created_by bigint not null references users(id),
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  check (file_id is not null or url is not null)
);
create index past_documents_client_idx on past_documents (client_id) where removed_at is null;
`,
  // 9 · a manager's delivery covers the whole batch: catch up batches where a manager
  // confirmed delivery before that rule, so the other writers' approved scripts go too
  `
create temporary table catch_up on commit drop as
  select distinct on (x.batch_id) x.id, x.batch_id, x.confirmed_by, x.confirmed_at, x.timeliner_url
    from deliveries x join users u on u.id = x.confirmed_by
   where u.role in ('owner', 'manager')
     and exists (select 1 from scripts s where s.batch_id = x.batch_id and s.status = 'approved' and s.removed_at is null)
   order by x.batch_id, x.confirmed_at desc, x.id desc;
insert into activity (client_id, batch_id, entity_type, entity_id, actor_id, action, summary, detail)
  select b.client_id, b.id, 'batch', b.id, d.confirmed_by, 'scripts.deliver',
         'Delivered the rest of the batch: ' || count(s.id) || ' approved script' || case when count(s.id) = 1 then '' else 's' end || ' (a manager’s delivery covers the whole batch)',
         jsonb_build_object('action', 'deliver', 'scripts', jsonb_agg(s.number order by s.number), 'deliveryId', d.id, 'catchUp', true)
    from catch_up d join batches b on b.id = d.batch_id
    join scripts s on s.batch_id = d.batch_id and s.status = 'approved' and s.removed_at is null
   group by b.client_id, b.id, d.confirmed_by, d.id;
update scripts s
   set status = 'delivered', delivered_at = d.confirmed_at, delivered_by = d.confirmed_by, delivery_id = d.id,
       timeliner_url = coalesce(s.timeliner_url, d.timeliner_url), version = s.version + 1, updated_at = now()
  from catch_up d
 where s.batch_id = d.batch_id and s.status = 'approved' and s.removed_at is null;
update batches set updated_at = now() where id in (select batch_id from catch_up);
`,
  // 10 · Control Center: a sign-in's clearance to open it, and where each team member works from
  `
alter table sessions add column control_until timestamptz;
alter table users add column city text;
alter table users add column city_code text;
alter table users add column country text;
alter table users add column lat double precision;
alter table users add column lon double precision;
alter table users add column timezone text;
alter table users add column work_start smallint check (work_start between 0 and 23);
alter table users add column work_end smallint check (work_end between 1 and 47);
`,
  // 11 · editors: people shown in the Control Center with their city and hours, who don't use the platform
  `
create table editors (
  id bigint generated always as identity primary key,
  name text not null,
  city text not null,
  city_code text not null,
  country text not null,
  lat double precision not null,
  lon double precision not null,
  timezone text not null,
  work_start smallint not null check (work_start between 0 and 23),
  work_end smallint not null check (work_end between 1 and 47),
  created_by bigint references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz
);
`,
  // 12 · where each writer's counter stood at the start of the day, so managers can see "+3 today"
  `
alter table writer_progress add column day date;
alter table writer_progress add column day_start int;
`,
];
