-- ============================================================================
-- cards-schema-check.sql · 当前库与 cards.sql 的结构一致性核对（只读，可随时重跑）
--
-- 用法：Supabase SQL Editor 整体执行，输出一张核对表：
--   status = PASS → 该项与 supabase/cards.sql 的设计一致；
--   status = FAIL → 看 detail 列：写明「缺失 / 多出 / 定义不一致」，actual 给出库内现值。
-- 全部 PASS 即当前库与 cards.sql 一致。
--
-- 口径说明：
--   · CHECK 表达式与 RLS 表达式按「小写 + 去空白 + 去括号」归一后比对，
--     不同 PG 版本反解析的括号排版差异不会误报；语义差异（字段、操作符）
--     会报 FAIL，此时对照 detail 与 cards.sql 源码判断。
--   · 唯一索引由约束检查覆盖（cards_user_key），索引节只查两个普通索引。
-- ============================================================================

with
-- ---------- 库内实际列 ----------
act_cols as (
  select column_name, data_type, is_nullable, column_default
  from information_schema.columns
  where table_schema = 'public' and table_name = 'cards'
),
-- ---------- cards.sql 预期列（14 列）----------
exp_cols(name, type, nullable, dflt) as (
  values
    ('id',                 'uuid',                   'NO',  'gen_random_uuid()'),
    ('user_id',            'uuid',                   'NO',  null),
    ('name',               'text',                   'NO',  null),
    ('start_date',         'date',                   'NO',  'CURRENT_DATE'),
    ('end_date',           'date',                   'NO',  null),
    ('total_sessions',     'integer',                'YES', null),
    ('remaining_sessions', 'integer',                'YES', null),
    ('auto_renew',         'boolean',                'NO',  'false'),
    ('billing_cycle',      'text',                   'YES', null),
    ('period_days',        'integer',                'YES', null),
    ('next_billing_date',  'date',                   'YES', null),
    ('muted',              'text',                   'NO',  '''none''::text'),
    ('created_at',         'timestamp with time zone','NO', 'now()'),
    ('updated_at',         'timestamp with time zone','NO', 'now()')
),
col_cmp as (
  select coalesce(e.name, a.column_name) as item,
         (e.name is null) as extra,
         (a.column_name is null) as missing,
         (a.column_name is not null and e.name is not null and (
            a.data_type <> e.type or a.is_nullable <> e.nullable
            or coalesce(a.column_default, '') <> coalesce(e.dflt, ''))) as diff,
         a.data_type, a.is_nullable, a.column_default
  from exp_cols e
  full join act_cols a on a.column_name = e.name
),
col_bad as (
  select string_agg(
           case when extra  then '多出列 ' || item
                when missing then '缺失列 ' || item
                else item || '（actual: ' || data_type || ' / nullable=' || is_nullable
                     || ' / default=' || coalesce(column_default, '∅') || '）' end,
           '；' order by item) as issues
  from col_cmp
  where extra or missing or diff
),
col_forbidden as (
  select string_agg(column_name, '、') as names
  from act_cols
  where column_name in ('merchant', 'indefinite', 'category')
     or column_name like 'source%'
),
-- ---------- 库内实际约束 ----------
act_cons as (
  select con.conname, con.contype, con.confrelid, con.conkey,
         lower(regexp_replace(pg_get_constraintdef(con.oid), '[\s()]', '', 'g')) as ndef,
         (select string_agg(a.attname, ',' order by a.attnum)
          from unnest(con.conkey) as u(attnum)
          join pg_attribute a on a.attrelid = con.conrelid and a.attnum = u.attnum) as cols
  from pg_constraint con
  where con.conrelid = to_regclass('public.cards')
),
-- ---------- cards.sql 预期 CHECK（归一化后；v3.1：trim 只兜 ASCII 空格）----------
-- 后五条是建表语句中的行内匿名 CHECK，PG 自动命名为 cards_<列名>_check
exp_checks(conname, ndef) as (
  values
    ('cards_end_after_start', 'checkend_date>=start_date'),
    ('cards_renew_complete',  'checkauto_renew=falseornext_billing_dateisnotnullandperiod_daysisnotnullorbilling_cycleisnotnull'),
    ('cards_cycle_exclusive', 'checknotperiod_daysisnotnullandbilling_cycleisnotnull'),
    ('cards_count_pair',      'checktotal_sessionsisnullorremaining_sessionsisnotnull'),
    ('cards_name_trimmed',    'checkname=btrimname'),
    ('cards_billing_cycle_check',      'checkbilling_cycleisnullorbilling_cycle=anyarray[''week''::text,''month''::text,''quarter''::text,''year''::text]'),
    ('cards_muted_check',              'checkmuted=anyarray[''none''::text,''cycle''::text,''forever''::text]'),
    ('cards_period_days_check',        'checkperiod_daysisnullorperiod_days>0'),
    ('cards_remaining_sessions_check', 'checkremaining_sessionsisnullorremaining_sessions>=0'),
    ('cards_total_sessions_check',     'checktotal_sessionsisnullortotal_sessions>0')
),
check_cmp as (
  select coalesce(e.conname, a.conname) as item,
         case when e.conname is null then '库内多出 CHECK：' || a.conname || ' → ' || a.ndef
              when a.conname is null then '库内缺失 CHECK：' || e.conname
              when a.ndef = e.ndef then null
              else '定义不一致 → actual: ' || a.ndef end as bad
  from exp_checks e
  full join (select * from act_cons where contype = 'c') a on a.conname = e.conname
),
-- ---------- 库内实际索引（非唯一——唯一由 cards_user_key 检查覆盖）----------
act_idx as (
  select c.relname as idxname,
         (select string_agg(a.attname, ',' order by k.ord)
          from unnest(i.indkey) with ordinality as k(attnum, ord)
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) as cols,
         (i.indpred is not null) as partial
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  where i.indrelid = to_regclass('public.cards')
    and not i.indisunique
),
-- ---------- 库内实际触发器 ----------
act_trg as (
  select tg.tgname, n.nspname || '.' || p.proname as func
  from pg_trigger tg
  join pg_proc p on p.oid = tg.tgfoid
  join pg_namespace n on n.oid = p.pronamespace
  where tg.tgrelid = to_regclass('public.cards') and not tg.tgisinternal
),
trg_cmp as (
  select coalesce(e.tgname, a.tgname) as item,
         case when e.tgname is null then '库内多出触发器：' || a.tgname || ' → ' || a.func
              when a.tgname is null then '库内缺失触发器：' || e.tgname
              when a.func = e.func then null
              else '触发函数不一致 → actual: ' || a.func end as bad
  from (values ('cards_touch_updated_at', 'extensions.moddatetime'),
               ('cards_muted_reset',      'public.cards_muted_reset')
       ) as e(tgname, func)
  full join act_trg a on a.tgname = e.tgname
),
-- ---------- 库内实际 RPC ----------
act_fn as (
  select p.oid, p.proname,
         lower(pg_get_function_arguments(p.oid)) as args,
         pg_get_function_result(p.oid) as result,
         p.prosecdef as sec_definer
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('settle_my_cards', 'import_my_cards')
),
-- ---------- 库内实际 RLS 策略 ----------
act_pol as (
  select policyname, cmd,
         lower(regexp_replace(coalesce(qual, '∅'), '[\s()]', '', 'g')) as qual,
         lower(regexp_replace(coalesce(with_check, '∅'), '[\s()]', '', 'g')) as wcheck
  from pg_policies
  where schemaname = 'public' and tablename = 'cards'
),
pol_cmp as (
  select coalesce(e.policyname, a.policyname) as item,
         case when e.policyname is null
                   then '库内多出策略：' || a.policyname || ' ' || a.cmd
              when a.policyname is null then '库内缺失策略：' || e.policyname
              when a.cmd = e.cmd and a.qual = e.qual and a.wcheck = e.wcheck then null
              else '定义不一致 → actual: ' || a.cmd || ' using=' || a.qual
                   || ' with_check=' || a.wcheck end as bad
  from (values
         ('cards_select_own', 'SELECT', 'user_id=auth.uid', '∅'),
         ('cards_insert_own', 'INSERT', '∅',              'user_id=auth.uid'),
         ('cards_update_own', 'UPDATE', 'user_id=auth.uid', 'user_id=auth.uid'),
         ('cards_delete_own', 'DELETE', 'user_id=auth.uid', '∅')
       ) as e(policyname, cmd, qual, wcheck)
  full join act_pol a on a.policyname = e.policyname
),
-- ---------- 库内表授权 ----------
tbl_grants as (
  select string_agg(privilege_type, ',' order by privilege_type) as got
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'cards'
    and grantee = 'authenticated'
)

-- ============================ 核对结果 ============================
select '表' as section, 'public.cards 存在' as item,
       case when to_regclass('public.cards') is not null then 'PASS' else 'FAIL' end as status,
       case when to_regclass('public.cards') is null
            then '表不存在——先在 Supabase SQL Editor 整体执行 cards.sql' else '' end as detail

union all
select '列', '14 列（名称/类型/可空/默认值）+ 无废弃列（merchant/indefinite/category/source_*）',
       case when (select issues from col_bad) is null
             and (select names  from col_forbidden) is null
            then 'PASS' else 'FAIL' end,
       coalesce(nullif(concat_ws('；',
                  (select issues from col_bad),
                  case when (select names from col_forbidden) is not null
                       then '不应存在的列：' || (select names from col_forbidden) end), ''), '')

union all
select '约束', 'FK user_id → auth.users(id) on delete cascade',
       case when exists (select 1 from act_cons
                         where contype = 'f' and cols = 'user_id'
                           and confrelid = 'auth.users'::regclass
                           and ndef like '%ondeletecascade%')
            then 'PASS' else 'FAIL' end,
       coalesce((select string_agg('actual: ' || ndef, '；' order by ndef)
                 from act_cons where contype = 'f' and cols = 'user_id'), '缺失')

union all
select '约束', '唯一键 cards_user_key (user_id, name)',
       case when exists (select 1 from act_cons
                         where contype = 'u' and conname = 'cards_user_key'
                           and cols = 'user_id,name')
            then 'PASS' else 'FAIL' end,
       coalesce((select string_agg('actual: ' || conname || ' ' || ndef, '；' order by conname)
                 from act_cons where contype = 'u'), '缺失')

union all
select 'CHECK约束', item,
       case when bad is null then 'PASS' else 'FAIL' end, coalesce(bad, '')
from check_cmp

union all
select '索引', 'cards_settle_idx (user_id, next_billing_date) 部分索引 where auto_renew',
       case when exists (select 1 from act_idx
                         where idxname = 'cards_settle_idx'
                           and cols = 'user_id,next_billing_date' and partial)
            then 'PASS' else 'FAIL' end,
       coalesce((select 'actual: ' || cols || ' / partial=' || partial
                 from act_idx where idxname = 'cards_settle_idx'), '缺失')

union all
select '索引', 'cards_user_ddl_idx (user_id, end_date)',
       case when exists (select 1 from act_idx
                         where idxname = 'cards_user_ddl_idx'
                           and cols = 'user_id,end_date' and not partial)
            then 'PASS' else 'FAIL' end,
       coalesce((select 'actual: ' || cols || ' / partial=' || partial
                 from act_idx where idxname = 'cards_user_ddl_idx'), '缺失')

union all
select '触发器', item,
       case when bad is null then 'PASS' else 'FAIL' end, coalesce(bad, '')
from trg_cmp

union all
select 'RLS', '表已启用行级安全',
       case when (select relrowsecurity from pg_class
                  where oid = to_regclass('public.cards'))
            then 'PASS' else 'FAIL' end,
       coalesce((select 'actual: relrowsecurity=' || relrowsecurity::text
                 from pg_class where oid = to_regclass('public.cards')), '')

union all
select 'RLS策略', item,
       case when bad is null then 'PASS' else 'FAIL' end, coalesce(bad, '')
from pol_cmp

union all
select '授权', 'authenticated 对 cards 的 select/insert/update/delete',
       case when lower((select got from tbl_grants)) = 'delete,insert,select,update'
            then 'PASS' else 'FAIL' end,
       coalesce((select 'actual: ' || got from tbl_grants), '无任何授权')

union all
select 'RPC', 'settle_my_cards(p_today date default null) → setof cards · security invoker · 恰一个重载',
       case when (select count(*) from act_fn where proname = 'settle_my_cards') = 1
             and exists (select 1 from act_fn
                         where proname = 'settle_my_cards'
                           and args like '%p_today date default null%'
                           and result = 'SETOF cards' and not sec_definer)
            then 'PASS' else 'FAIL' end,
       coalesce((select string_agg('actual: args=' || args || ' / result=' || result
                        || ' / security_definer=' || sec_definer, '；' order by args)
                 from act_fn where proname = 'settle_my_cards'), '缺失')

union all
select 'RPC', 'import_my_cards(p_rows jsonb) → setof cards · security invoker · 恰一个重载',
       case when (select count(*) from act_fn where proname = 'import_my_cards') = 1
             and exists (select 1 from act_fn
                         where proname = 'import_my_cards'
                           and args = 'p_rows jsonb'
                           and result = 'SETOF cards' and not sec_definer)
            then 'PASS' else 'FAIL' end,
       coalesce((select string_agg('actual: args=' || args || ' / result=' || result
                        || ' / security_definer=' || sec_definer, '；' order by args)
                 from act_fn where proname = 'import_my_cards'), '缺失')

union all
select '授权', 'authenticated 可执行两个 RPC',
       case when exists (select 1 from act_fn f
                         where f.proname = 'settle_my_cards'
                           and has_function_privilege('authenticated', f.oid, 'EXECUTE'))
             and exists (select 1 from act_fn f
                         where f.proname = 'import_my_cards'
                           and has_function_privilege('authenticated', f.oid, 'EXECUTE'))
            then 'PASS' else 'FAIL' end,
       coalesce((select string_agg(proname || ' execute=' ||
                         has_function_privilege('authenticated', oid, 'EXECUTE')::text,
                         '；' order by proname)
                 from act_fn), '')
order by section, item;
