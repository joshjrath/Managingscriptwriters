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
];
