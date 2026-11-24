-- ─────────────────────────────────────────────────────────────
-- 줍깅 땅따먹기 · Supabase 스키마
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 한 번 실행하면 끝.
-- (다시 실행해도 안전하도록 작성했습니다.)
-- ─────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- 1) 땅: 격자 한 칸 = 한 행. key는 "latIdx:lngIdx" (예: "37265:127000")
create table if not exists public.turfs (
  key          text primary key,
  lat          double precision not null,      -- 칸 중심 위도
  lng          double precision not null,      -- 칸 중심 경도
  owner        text not null,                  -- 현재 주인 닉네임
  claimed_at   timestamptz not null default now(),
  photo        text,                           -- 인증 사진 (720px JPEG data URL 또는 Storage URL)
  memo         text,                           -- 한 줄 메모
  claim_count  integer not null default 1,     -- 이 칸이 인증된 횟수
  prev_owner   text                            -- 직전 주인 (뺏기 기록용)
);

-- 2) 인증 기록: 뺏고 뺏긴 모든 이력 (피드)
create table if not exists public.claims (
  id          uuid primary key default gen_random_uuid(),
  turf_key    text not null references public.turfs(key) on delete cascade,
  nick        text not null,
  prev_owner  text,
  action      text not null check (action in ('claim', 'steal', 'defend')),
  memo        text,
  photo       text,
  created_at  timestamptz not null default now()
);

create index if not exists claims_created_idx on public.claims (created_at desc);
create index if not exists claims_turf_idx on public.claims (turf_key);
create index if not exists turfs_owner_idx on public.turfs (owner);

-- 3) 리더보드 뷰 (참고용 · 앱은 turfs를 집계해서 씁니다)
create or replace view public.leaderboard as
  select owner,
         count(*)::int          as tiles,
         max(claimed_at)        as last_claim
  from public.turfs
  group by owner
  order by tiles desc, last_claim asc;

-- ─────────────────────────────────────────────────────────────
-- 4) RLS (2026-11-25 적용): 읽기는 누구나, 쓰기는 로그인 사용자만,
--    삭제는 anon/authenticated 모두 차단(대시보드·service_role만 가능).
--    앱은 로그인 세션의 액세스 토큰으로 요청한다(app.js SB.headers 참고).
-- ─────────────────────────────────────────────────────────────
alter table public.turfs  enable row level security;
alter table public.claims enable row level security;

drop policy if exists "turfs_public_read"    on public.turfs;
drop policy if exists "turfs_public_insert"  on public.turfs;
drop policy if exists "turfs_public_update"  on public.turfs;
drop policy if exists "turfs_read_all"       on public.turfs;
drop policy if exists "turfs_insert_authed"  on public.turfs;
drop policy if exists "turfs_update_authed"  on public.turfs;

create policy "turfs_read_all" on public.turfs
  for select to anon, authenticated using (true);

-- 점령·뺏기·방어: 로그인 사용자면 누구나(남의 칸 덮어쓰기 = 뺏기)
create policy "turfs_insert_authed" on public.turfs
  for insert to authenticated with check (true);

create policy "turfs_update_authed" on public.turfs
  for update to authenticated using (true) with check (true);

drop policy if exists "claims_public_read"   on public.claims;
drop policy if exists "claims_public_insert" on public.claims;
drop policy if exists "claims_read_all"      on public.claims;
drop policy if exists "claims_insert_authed" on public.claims;

create policy "claims_read_all" on public.claims
  for select to anon, authenticated using (true);

create policy "claims_insert_authed" on public.claims
  for insert to authenticated with check (true);

-- 삭제 정책은 만들지 않는다 → anon·authenticated는 땅·피드 기록을 지울 수 없다.
-- (정책이 없으면 삭제 요청은 0행 처리되고 데이터는 그대로 남는다.
--  더 확실히 막고 싶으면 아래 두 줄의 주석을 풀어 권한까지 회수한다.)
-- revoke delete on public.turfs from anon, authenticated;
-- revoke delete, update on public.claims from anon, authenticated;

grant select, insert, update on public.turfs  to authenticated;
grant select, insert         on public.claims to authenticated;
grant select on public.turfs, public.claims, public.leaderboard to anon;

-- ─────────────────────────────────────────────────────────────
-- 5) Realtime: 땅이 바뀌면 접속한 모두의 화면에 즉시 반영
--    (이미 추가된 경우 오류가 나도 무시하고 넘어가면 됩니다)
-- ─────────────────────────────────────────────────────────────
alter publication supabase_realtime add table public.turfs;
alter publication supabase_realtime add table public.claims;

-- ─────────────────────────────────────────────────────────────
-- 6) (선택) 사진을 Storage에 올리고 싶을 때
--    Storage → New bucket → 이름 'claim-photos' → Public bucket 체크.
--    그 뒤 앱에서 photo 값에 공개 URL을 넣으면 됩니다.
--    MVP는 720px JPEG data URL을 photo 컬럼에 그대로 저장합니다(칸당 약 60~90KB).
-- ─────────────────────────────────────────────────────────────
