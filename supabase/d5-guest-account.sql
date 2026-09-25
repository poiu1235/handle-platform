-- ============================================================================
-- D5 账号体系（访客优先 + 绑定合并 + 删除流水线）· Supabase 迁移
-- 设计文档：handle-miniprogram/doc/account-guest-first-design.md（v1.5）
-- 在 Supabase SQL Editor 中整体执行一次；语句幂等，可重复跑。
--
-- 范围：
--   0. 只读前置核对（人工确认后再往下）
--   1. account_merges      —— 合并审计/撤销依据（设计 2.2）
--   2. pending_deletions   —— 删除流水线队列：先置无效位→定期清（设计 2.3）
--   2b. deletion_purges    —— 物理清除的最小留痕（v1.5 评审 #1）
--   3. merge_guest()       —— 访客→邮箱合并事务（设计 5.4，CF confirm 端点调用）
--   4. d5_deletion_pipeline() —— pg_cron 夜 job：空访客置位 + 到期复核 + 物理清
--   既有表零改动：user_identities / cards / notes / balances 结构与 RLS 均不动。
--
-- v1.5（2026-09-20 评审修订）：
--   评审#1 purge 前二次核验业务数据（置位后凭存活会话写入的访客不再被误删），
--         且每次物理清写 deletion_purges 留痕；
--   评审#3/#4 merge_guest 开头 FOR UPDATE 锁访客行——窗口期并发写被串行化后
--         显式失败（不静默丢数据），跨目标并发 confirm 第二笔明确报 not_guest；
--         另加 identity 搬移 row-count 断言。
--
-- ⚠️ 权限注记：两函数均 security definer（owner=postgres），删 auth.users 依赖
--    函数属主权限；若托管环境连 postgres 角色也被拒（rare），回退方案是物理删除
--    挪到 CF 侧走 GoTrue admin API（DELETE /admin/users），本文件其余不变。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. 前置核对（只读，预期结果写在注释里）
-- ---------------------------------------------------------------------------

-- 0.1 所有引用 auth.users 的外键必须 confdeltype='d'（cascade）——删除流水线
--     全押在级联上；出现 r/n/a 的表需先补 cascade 或把该行从队列语义里排除。
--     预期：cards / notes / user_identities / pending_deletions 全部 'd'。
--     balances 的 FK 形态以本查询实际输出为准（建表早于仓库化，需肉眼确认一次）。
select conrelid::regclass as table_name, conname, confdeltype
from pg_constraint
where contype = 'f' and confrelid = 'auth.users'::regclass
order by 1;

-- 0.2 带 (user_id, x) 唯一键的业务表清单——merge_guest 只为清单内的表做同名去重，
--     新增业务表若带此类唯一键，需同步在 3.2 里加一段。
--     预期：cards(user_id,name)、balances(user_id,app_name)、user_identities 两条。
select conrelid::regclass as table_name, conname,
  (select string_agg(att.attname, ',' order by k.ord)
     from unnest(conkey) with ordinality as k(colid, ord)
     join pg_attribute att on att.attrelid = conrelid and att.attnum = k.colid) as key_columns
from pg_constraint
where contype = 'u'
  and exists (
    select 1 from unnest(conkey) k
    join pg_attribute att on att.attrelid = conrelid and att.attnum = k
    where att.attname = 'user_id'
  )
order by 1;

-- ---------------------------------------------------------------------------
-- 1. account_merges（设计 2.2）
--    故意不加外键：source 用户随后即被删除，审计行必须比当事人活得更久。
-- ---------------------------------------------------------------------------

create table if not exists public.account_merges (
  id          uuid primary key default gen_random_uuid(),
  source_id   uuid not null,                    -- 被合并掉的访客 user_id（无 FK，理由见上）
  target_id   uuid not null,                    -- 接收数据的邮箱账号 user_id
  provider    text not null,                    -- 触发合并时访客携带的平台身份
  moved_rows  jsonb not null,                   -- {'cards': n, 'notes': n, 'balances': n}
  overwritten jsonb,                            -- 同名覆盖留痕（仅审计，不向用户同步）
  created_at  timestamptz not null default now()
);

alter table public.account_merges enable row level security;
-- 无 policy：anon/authenticated 一律拒；只有 service_role（CF 端点）可读写。
revoke all on public.account_merges from anon, authenticated;
grant select, insert on public.account_merges to service_role;

-- ---------------------------------------------------------------------------
-- 2. pending_deletions（设计 2.3）
--    FK cascade：物理清删 auth.users 时队列行自动消失，不留孤儿。
-- ---------------------------------------------------------------------------

create table if not exists public.pending_deletions (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  reason      text not null check (reason in ('guest_cleanup', 'user_delete')),
  marked_at   timestamptz not null default now(),
  purge_after timestamptz not null
);

alter table public.pending_deletions enable row level security;
revoke all on public.pending_deletions from anon, authenticated;
-- service_role 全权：CF 的置位（注销）与撤位（冷却期内重新登录=撤销）都走 REST。
grant select, insert, update, delete on public.pending_deletions to service_role;

-- ---------------------------------------------------------------------------
-- 2b. deletion_purges（v1.5 评审 #1）
--     最小物理清除留痕：每一次「有人被删」都要可证明发生过、删时有多少数据。
--     无 FK（同上，审计行必须比当事人活得久）；user_id 不重用，primary key 成立。
-- ---------------------------------------------------------------------------

create table if not exists public.deletion_purges (
  user_id    uuid primary key,
  reason     text not null,
  marked_at  timestamptz not null,
  row_counts jsonb not null,   -- 物理删除前的业务行数快照
  purged_at  timestamptz not null default now()
);

alter table public.deletion_purges enable row level security;
revoke all on public.deletion_purges from anon, authenticated;
grant select, insert on public.deletion_purges to service_role;

-- ---------------------------------------------------------------------------
-- 3. merge_guest(p_guest, p_target, p_provider)（设计 5.4）
--    由 CF guest-upgrade-confirm 端点以 service_role 调用；ticket 验签、双会话
--    校验都在 CF 层完成，这里是数据库侧最后一道防线 + 原子执行体。
--    失败以 raise exception 抛出（单语句函数天然单事务，自动回滚），
--    CF 按消息文本映射结构化错误码：not_guest / bad_target / already_bound /
--    deletion_pending / no_identity。
--    同名覆盖规则（v1.3 定案）：双方都是完整行，「后覆盖前」= 整行败者弃；
--    胜出行原样保留。不做逐字段合并（那是部分行导入的语义，此处无「缺失」）。
--    胜负判据：(updated_at, id) 行比较，并列按 id 定序，确定性。
-- ---------------------------------------------------------------------------

create or replace function public.merge_guest(p_guest uuid, p_target uuid, p_provider text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r             record;
  v_type        text;
  v_idn         integer;
  v_cards       integer;
  v_notes       integer;
  v_balances    integer;
  v_moved       jsonb;
  v_overwritten jsonb := '[]'::jsonb;
begin
  -- 3.0 纵深防御校验（CF 已验一轮，这里防直调）
  if p_guest is null or p_target is null or p_guest = p_target then
    raise exception 'bad_target';
  end if;
  -- 锁访客行（v1.5 评审 #3/#4，一把锁修两个洞）：
  --   ① 窗口期写竞态——任何以 guest token 写的业务行，其 FK 要拿本行的 SHARE 锁，
  --     会被阻塞到本事务提交；提交后访客已删 → FK 违例显式报错，
  --     不可能出现「保存成功后毫秒级蒸发」（用户端看到失败，可重试到合并后的新会话）。
  --   ② 跨目标并发 confirm——同一访客的第二笔 merge_guest 阻塞在此，第一笔提交后
  --     行已消失 → 走 not_guest 明确失败，不会伪装成功。
  select raw_user_meta_data ->> 'account_type' into v_type
  from auth.users where id = p_guest
  for update;
  if v_type is distinct from 'guest' then
    raise exception 'not_guest';
  end if;
  if not exists (
    select 1 from auth.users u
    where u.id = p_target
      and u.email_confirmed_at is not null
      and coalesce(u.raw_user_meta_data ->> 'account_type', '') <> 'guest'
  ) then
    raise exception 'bad_target';
  end if;
  if exists (select 1 from pending_deletions where user_id in (p_guest, p_target)) then
    raise exception 'deletion_pending';
  end if;
  -- B3：目标在该 provider 上已有门钥匙 → 拒绝，绝不顶掉旧绑定
  if exists (select 1 from user_identities where user_id = p_target and provider = p_provider) then
    raise exception 'already_bound';
  end if;

  -- 3.1 cards 同名去重（撞 (user_id, name)）
  for r in
    select g.id as gid, c.id as tid, g.name as key,
           (g.updated_at, g.id) > (c.updated_at, c.id) as guest_wins
    from cards g
    join cards c on c.user_id = p_target and c.name = g.name
    where g.user_id = p_guest
  loop
    if r.guest_wins then
      delete from cards where id = r.tid;
    else
      delete from cards where id = r.gid;
    end if;
    v_overwritten := v_overwritten || jsonb_build_object(
      'table', 'cards', 'name', r.key,
      'dropped_id', case when r.guest_wins then r.tid else r.gid end,
      'kept_id',    case when r.guest_wins then r.gid else r.tid end);
  end loop;

  -- 3.2 balances 同名去重（撞 (user_id, app_name)，约定同上）
  for r in
    select g.id as gid, c.id as tid, g.app_name as key,
           (g.updated_at, g.id) > (c.updated_at, c.id) as guest_wins
    from balances g
    join balances c on c.user_id = p_target and c.app_name = g.app_name
    where g.user_id = p_guest
  loop
    if r.guest_wins then
      delete from balances where id = r.tid;
    else
      delete from balances where id = r.gid;
    end if;
    v_overwritten := v_overwritten || jsonb_build_object(
      'table', 'balances', 'app_name', r.key,
      'dropped_id', case when r.guest_wins then r.tid else r.gid end,
      'kept_id',    case when r.guest_wins then r.gid else r.tid end);
  end loop;

  -- 3.3 计数 + 逐表搬移（notes 无业务唯一键，直接搬）
  --     注：cards 的 moddatetime 触发器会把被搬行的 updated_at 刷成合并时刻——
  --     接受（合并本身即一次写入，与余额导入「更新时间统一为提交时刻」同约定）。
  select count(*) into v_cards    from cards    where user_id = p_guest;
  select count(*) into v_notes    from notes    where user_id = p_guest;
  select count(*) into v_balances from balances where user_id = p_guest;

  update cards    set user_id = p_target where user_id = p_guest;
  update notes    set user_id = p_target where user_id = p_guest;
  update balances set user_id = p_target where user_id = p_guest;
  v_moved := jsonb_build_object('cards', v_cards, 'notes', v_notes, 'balances', v_balances);

  -- 3.4 挪门钥匙：该访客的全部 identity 行（正常恒一条，多 provider 预留时同样成立；
  --     各行的 (user_id, provider) 冲突已在 3.0 按触发 provider 预检，其余 provider
  --     理论上不存在——guest 建号即绑单一平台身份）
  update user_identities set user_id = p_target where user_id = p_guest;
  -- v1.5 评审 #4：identity 必须真的被本事务挪动（访客建号即带 identity，0 行=异常），
  -- 拒绝「静默空搬」的伪装成功
  get diagnostics v_idn = row_count;
  if v_idn = 0 then
    raise exception 'no_identity';
  end if;

  -- 3.5 审计留痕（必须在删用户之前，当事人消失后仍要可查）
  insert into account_merges (source_id, target_id, provider, moved_rows, overwritten)
  values (p_guest, p_target, p_provider, v_moved,
          nullif(v_overwritten, '[]'::jsonb));

  -- 3.6 删除访客：refresh token、残余 identity（防御）、队列行全部级联清光
  delete from auth.users where id = p_guest;

  return jsonb_build_object('movedRows', v_moved, 'overwritten', v_overwritten);
end;
$$;

revoke all on function public.merge_guest(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.merge_guest(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. d5_deletion_pipeline()（设计 2.3 / B10）
--    夜 job 两段：①空访客置无效位（冷却 30 天）；②物理清到期行。
--    「无效位」的读侧强制（login / upgrade / bind 拒绝、免登撤销）在 CF 端点，
--    本函数只负责队列的生产与消费。
-- ---------------------------------------------------------------------------

create or replace function public.d5_deletion_pipeline()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_marked   integer := 0;
  v_purged   integer := 0;
  v_unmarked integer := 0;
  r            record;
begin
  -- 4.1 置位：guest + 三张业务表全空 + 30 天无活跃（last_sign_in_at 每次免登/签发
  --     会话都会刷新，活跃访客天然安全）+ 未在队列。有数据访客永不清理（B10）。
  insert into pending_deletions (user_id, reason, purge_after)
  select u.id, 'guest_cleanup', now() + interval '30 days'
  from auth.users u
  where u.raw_user_meta_data ->> 'account_type' = 'guest'
    and coalesce(u.last_sign_in_at, u.created_at) < now() - interval '30 days'
    and not exists (select 1 from pending_deletions pd where pd.user_id = u.id)
    and not exists (select 1 from cards    c where c.user_id = u.id)
    and not exists (select 1 from notes    n where n.user_id = u.id)
    and not exists (select 1 from balances b where b.user_id = u.id);
  get diagnostics v_marked = row_count;

  -- 4.2 到期逐条处置（v1.5 评审 #1）。量级极小（夜 job、单表扫描），循环换取
  --     每行独立的复核与留痕，比集合式删除更可审计。
  for r in
    select pd.user_id, pd.reason, pd.marked_at,
           (select count(*) from cards    c where c.user_id = pd.user_id) as n_cards,
           (select count(*) from notes    n where n.user_id = pd.user_id) as n_notes,
           (select count(*) from balances b where b.user_id = pd.user_id) as n_balances
    from pending_deletions pd
    where pd.purge_after <= now()
  loop
    if r.reason = 'guest_cleanup'
       and (r.n_cards + r.n_notes + r.n_balances) > 0 then
      -- 二次核验：置位后凭存活会话（不走冷启动，撤位路径没机会触发）又写了数据
      -- → 撤销清理位并跳过。「有数据访客永不清理」在 purge 时刻再执行一遍。
      delete from pending_deletions where user_id = r.user_id;
      v_unmarked := v_unmarked + 1;
    else
      delete from auth.users where id = r.user_id;   -- cascade 清 identity/队列/token
      insert into deletion_purges (user_id, reason, marked_at, row_counts)
      values (r.user_id, r.reason, r.marked_at,
              jsonb_build_object('cards', r.n_cards, 'notes', r.n_notes,
                                 'balances', r.n_balances));
      v_purged := v_purged + 1;
    end if;
  end loop;

  return jsonb_build_object('marked', v_marked, 'purged', v_purged,
                            'unmarked', v_unmarked);
end;
$$;

revoke all on function public.d5_deletion_pipeline() from public, anon, authenticated;
grant execute on function public.d5_deletion_pipeline() to service_role;

-- ---------------------------------------------------------------------------
-- 5. 定时注册（Supabase 需先在 Dashboard 启用 pg_cron extension）
--    每天 04:17 UTC 跑一轮流水线。
--    ⚠️ cron job 以调度者身份执行：请确认 SQL Editor 登录角色对 auth.users 有
--    DELETE 权限（postgres 默认有）；若无，把 4.2 段挪到 CF 定时端点走
--    service_role admin API，本文件其余不变。
-- ---------------------------------------------------------------------------

create extension if not exists pg_cron;

select cron.unschedule('d5-deletion-pipeline')
where exists (select 1 from cron.job where jobname = 'd5-deletion-pipeline');

select cron.schedule(
  'd5-deletion-pipeline',
  '17 4 * * *',
  $$select public.d5_deletion_pipeline();$$
);
