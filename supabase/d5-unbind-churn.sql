-- ============================================================================
-- D5 v1.6 增量：解绑流水（identity_unbinds）——B25 churn 频控的计数源
-- 设计文档：handle-miniprogram/doc/account-guest-first-design.md §7.2 / B25
--
-- 为什么需要这张表：解绑 = 删 user_identities 行，删完无痕；绑定侧可以从
-- account_merges（合并即绑）数出来，解绑侧数不出来 → 30 天窗口内的
-- 「解绑+绑定 ≤3 次」无从判定。本表只服务计数与排障，不做业务读路径。
--
-- FK cascade：当事人日后注销，其流水随 auth.users 一起消失（对已死账号
-- 做 churn 判定无意义），不留孤儿。
--
-- 在 Supabase SQL Editor 执行一次；幂等。
-- ============================================================================

create table if not exists public.identity_unbinds (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  provider   text not null,
  unbound_at timestamptz not null default now()
);

create index if not exists identity_unbinds_churn_idx
  on public.identity_unbinds (user_id, provider, unbound_at);

alter table public.identity_unbinds enable row level security;
revoke all on public.identity_unbinds from anon, authenticated;
grant select, insert on public.identity_unbinds to service_role;
