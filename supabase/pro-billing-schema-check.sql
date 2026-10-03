-- ============================================================================
-- pro-billing-schema-check.sql · 只读 · 当前库与 pro-billing.sql 的结构一致性核对
--
-- 用法：Supabase SQL Editor 整体执行，**一条语句出一份表**（12 行 + 1 行总判定）。
--   status = PASS ⇒ 该项与 pro-billing.sql 的设计一致；
--   status = FAIL ⇒ 看 detail 与 actual 列，actual 给库里现值。
-- 全部 SELECT，零写入、零 DDL，可随时重跑；不建表 ⇒ 不会触发"Potential issue detected"弹窗。
--
-- ⚠ 为什么必须写成一条语句（2026-10-04 实测踩过）：这个编辑器**只显示最后一条语句的结果**。
--   原稿把 12 项写成 12 条独立语句，整体执行后 owner 贴回来的只有最后那行"说明"，
--   11 项判定全部看不见＝这一轮的排错成本白付。⇒ 判据文件的"能不能看见"也是判据的一部分
--   （同 [[supabase-editor-rls-if-not-exists]] 那条：工具的呈现行为会决定判据成不成立）。
--
-- 为什么这份文件里有些行"看起来多余"（owner 判据在 PRD v3）：
--   · 「三表零 FK」不是风格问题而是 N-1 的落地物——账本建 cascade 等于把
--     "注销销毁权益"写进库，所以它必须被**测出来**，不能只写在注释里。
--   · 「零 policy」+「只 service_role」是 4.6 的安全形状，任一条 policy 被手工
--     加进 Dashboard 就会静默打开一条绕过 CF 的读写面。
--   · 「pro_coverage 只有一个定义」＝验收 #39 的库侧一半（CF 侧那一半在代码里查）。
--   · 三条 partial unique index 是"挡双击"和"一笔单不能被撤两次账"的唯一强制处，
--     普通 create index 重跑不会报错，只有这里能发现它没建起来。
--
-- ⚠ 系统目录口径：只用 pg_class / pg_indexes / pg_policies / pg_constraint / pg_proc /
--   pg_get_userbyid / aclexplode，不碰 pg_trigger.tgtype（smallint 位掩码）、不碰 pg_proc_priv
--   ——这两个坑在 balances-schema-check.sql:26-27 已实测栽过。
-- ⚠ 不含任何"按名字解析对象"的运行时调用（has_table_privilege／'x'::regclass 全改成读
--   relacl／proacl）：那类调用对象缺失时抛错且**不带 LINE**，指不出哪一行。
--   ⚠ 但这不是上一轮 42P01 的成因——真因是编辑器的 RLS 建议弹窗把 `create table if not exists`
--     的表名读成 `if`（详见 pro-billing.sql 头部）。改读 ACL 只是因为它本身更好。
-- ============================================================================

with
-- ── 预期形状（一处列全，下面各段只算现值） ──────────────────────────────
tbls(t)                     as (values ('pro_orders'), ('pro_ledger'), ('pro_refund_requests')),
expect_cols(t, n)           as (values ('pro_orders', 25), ('pro_ledger', 10), ('pro_refund_requests', 10)),
expect_chk(t, n)            as (values ('pro_orders', 6), ('pro_ledger', 2), ('pro_refund_requests', 2)),
expect_idx(i, t)            as (values ('pro_orders_wx_order_uk',              'pro_orders'),
                                ('pro_orders_one_pending_per_openid',          'pro_orders'),
                                ('pro_refund_requests_order_active_uk',        'pro_refund_requests')),
expect_audit(c)             as (values ('operator'), ('note'), ('openid')),
expect_con(c)               as (values ('identity_unbinds_manual_note_required'),
                                ('identity_unbinds_manual_openid_required')),

-- ── 三表是否都在（03／05 要用：空集上的"零"是假绿） ──────────────────────
present as (
  select count(*) as n
  from pg_class
  where relnamespace = 'public'::regnamespace and relkind = 'r'
    and relname in (select t from tbls)
),

-- ── 各段现值 ────────────────────────────────────────────────────────────
s01 as (
  select count(*) filter (where x.found) as n,
         coalesce(string_agg(t.t || case when x.found then '' else '（缺）' end, ',' order by t.t), '') as got
  from tbls t
  left join (select table_name as tn, true as found
             from information_schema.tables
             where table_schema = 'public'
               and table_name in ('pro_orders','pro_ledger','pro_refund_requests')) x on x.tn = t.t
),
s02 as (
  -- 🔴 bool_and 会**跳过 NULL**：a.n 为 NULL（表根本没建）时 `a.n = e.n` 是 NULL ⇒ 被忽略 ⇒
  --   其余两表对上就判 PASS＝假绿。coalesce(…, false) 把"缺表"变成明确的 false。
  select bool_and(coalesce(a.n = e.n, false)) as ok,
         coalesce(string_agg(e.t || '=' || coalesce(a.n::text, '∅') || '（期望' || e.n::text || '）', ' ' order by e.t), '') as got
  from expect_cols e
  left join (select table_name as tn, count(*)::int as n
             from information_schema.columns
             where table_schema = 'public'
               and table_name in ('pro_orders','pro_ledger','pro_refund_requests')
             group by table_name) a on a.tn = e.t
),
s03 as (
  select count(*) as n,
         coalesce(string_agg(t.relname || ' → ' || c.conname, '；'), '') as got
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid and t.relnamespace = 'public'::regnamespace
  where c.contype = 'f'
    and t.relname in ('pro_orders','pro_ledger','pro_refund_requests')
),
s04 as (
  select count(*) as n, bool_and(c.relrowsecurity) as ok,
         coalesce(string_agg(c.relname || '=' || case when c.relrowsecurity then 'on' else 'off' end,
                             ' ' order by c.relname), '') as got
  from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    and c.relname in ('pro_orders','pro_ledger','pro_refund_requests')
),
s05 as (
  select count(*) as n,
         coalesce(string_agg(p.tablename || ' 的 policy ' || p.policyname, '；'), '') as got
  from pg_policies p
  where p.schemaname = 'public'
    and p.tablename in ('pro_orders','pro_ledger','pro_refund_requests')
),
s06 as (
  select count(*) filter (where pg_get_userbyid(a.grantee) = 'service_role' and a.privilege_type = 'SELECT') as sr_sel,
         count(*) filter (where pg_get_userbyid(a.grantee) = 'service_role' and a.privilege_type = 'INSERT') as sr_ins,
         count(*) filter (where pg_get_userbyid(a.grantee) = 'service_role' and a.privilege_type = 'UPDATE')  as sr_upd,
         count(*) filter (where pg_get_userbyid(a.grantee) = 'service_role' and a.privilege_type = 'DELETE')  as sr_del,
         count(*) filter (where a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon','authenticated'))      as leaked,
         coalesce(string_agg(a.tbl || ':' ||
                  case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
                  || '.' || a.privilege_type, ' ' order by a.tbl, a.grantee, a.privilege_type),
                  '（relacl 为 NULL ⇒ 没有任何显式授权，只有 owner 可操作＝CF 会拿 42501）') as got
  from (select c.relname as tbl, x.grantee, x.privilege_type
        from pg_class c
        cross join lateral aclexplode(c.relacl) as x
        where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
          and c.relname in ('pro_orders','pro_ledger','pro_refund_requests')) a
),
s07 as (
  -- 🔴 缺失项的标签不能用 `i || '（缺）'`：i 为 NULL 时整个表达式是 NULL，string_agg 会**跳过它**
  --   ⇒ 恰恰把"哪一条没建起来"这个最需要显示的信息吞掉。所以把"期望名"与"实际名"分两列带出来。
  select bool_and(coalesce(x.actual_i is not null and x.is_unique and x.has_where, false)) as ok,
         coalesce(string_agg(x.expected_i || case when x.actual_i is null then '（缺）'
                                                  when not x.is_unique then '（非唯一）'
                                                  when not x.has_where then '（缺 WHERE 条件）'
                                                  else '（ok）' end, ' ' order by x.expected_i), '') as got
  from (select e.i as expected_i, ix.indexname as actual_i,
               (ix.indexdef ilike '%unique%') as is_unique,
               (ix.indexdef ilike '%where%')  as has_where
        from expect_idx e
        left join pg_indexes ix on ix.schemaname = 'public' and ix.indexname = e.i) x
),
s08 as (
  -- 🔴 同 s02：bool_and 跳过 NULL，缺表时 `a.n = e.n` 为 NULL 会被忽略＝假绿
  select bool_and(coalesce(a.n = e.n, false)) as ok,
         coalesce(string_agg(e.t || '=' || coalesce(a.n::text, '∅') || '（期望' || e.n::text || '）', ' ' order by e.t), '') as got,
         coalesce(string_agg(e.t || '：' || coalesce(a.defs, '（无）'), ' /// ' order by e.t), '') as defs
  from expect_chk e
  left join (select t.relname as tn, count(*)::int as n,
                    string_agg(pg_get_constraintdef(c.oid), ' ｜ ') as defs
             from pg_constraint c
             join pg_class t on t.oid = c.conrelid and t.relnamespace = 'public'::regnamespace
             where c.contype = 'c'
               and t.relname in ('pro_orders','pro_ledger','pro_refund_requests')
             group by t.relname) a on a.tn = e.t
),
s09 as (
  select count(*) as n,
         coalesce(string_agg(p.oid::regprocedure::text, ' / ' order by p.oid::regprocedure::text), '（函数不存在）') as got
  from pg_proc p where p.proname = 'pro_coverage'
),
s10 as (
  -- ⚠ 不写 bool_and(privilege_type='EXECUTE')：owner（postgres）在 proacl 里是 `=UX`，
  --   aclexplode 会拆出一条 USAGE 行 ⇒ 那种"全部行都必须是 EXECUTE"的写法必然假红。
  --   真正要判的是两件事：service_role 有 EXECUTE、且 anon／authenticated／PUBLIC 一条都没有。
  select coalesce(count(*) filter (where pg_get_userbyid(a.grantee) = 'service_role'
                                       and a.privilege_type = 'EXECUTE'), 0) >= 1    as sr_can,
         coalesce(count(*) filter (where a.grantee = 0
                                       or pg_get_userbyid(a.grantee) in ('anon','authenticated')), 0) as leaked,
         coalesce(string_agg(case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
                             || ':' || a.privilege_type, ' / '),
                    '（proacl 为 NULL 或函数不存在 ⇒ 只有 owner 能执行＝CF 会拿 42501）')
         || ' ｜ 重载数=' || (select count(*)::text from pg_proc where proname = 'pro_coverage')
         || ' ｜ ' || coalesce((select case p.provolatile when 'i' then 'IMMUTABLE'
                                                       when 's' then 'STABLE'
                                                       when 'v' then 'VOLATILE' end
                                   || ' / ' || case when p.prosecdef then 'SECURITY DEFINER'
                                                    else 'SECURITY INVOKER' end
                                from pg_proc p where p.proname = 'pro_coverage' limit 1), '（无）') as got
  from (select x.grantee, x.privilege_type
        from pg_proc p
        cross join lateral aclexplode(p.proacl) as x
        where p.proname = 'pro_coverage') a
),
s11 as (
  select bool_and(x.column_name is not null) as ok,
         coalesce(string_agg(e.c || case when x.column_name is null then '（缺）' else '（ok）' end,
                             ' ' order by e.c), '') as got
  from expect_audit e
  left join information_schema.columns x
    on x.table_schema = 'public' and x.table_name = 'identity_unbinds' and x.column_name = e.c
),
s11b as (
  select bool_and(x.conname is not null) as ok,
         coalesce(string_agg(e.c || case when x.conname is null then '（缺）' else '（ok）' end,
                             ' ' order by e.c), '') as got
  from expect_con e
  left join pg_constraint x
    on x.conname = e.c
   and x.conrelid = (select oid from pg_class
                      where relname = 'identity_unbinds' and relnamespace = 'public'::regnamespace)
),

-- ── 十二行判定（每行一项，一次全出） ─────────────────────────────────────
rows_ as (
  select '01 表存在'::text as item, '三张表都在 public 下'::text as expected,
         coalesce(nullif(s01.got, ''), '三张表都在')::text as actual,
         case when s01.n = 3 then 'PASS' else 'FAIL' end::text as status,
         '缺表＝pro-billing.sql 没跑或跑在别的 schema'::text as detail from s01
  union all
  select '02 列数', 'pro_orders 25／pro_ledger 10／pro_refund_requests 10', s02.got,
         case when s02.ok then 'PASS' else 'FAIL' end,
         '⚠ create table if not exists 重跑不会补列 ⇒ 改过结构要 drop 重建（自测库）或写增量文件' from s02
  union all
  select '03 零外键', '三表都在，且 0 条 FK', coalesce(nullif(s03.got, ''), '0 条 FK'),
         -- 🔴 光看 count=0 会在"表根本没建"的空集上判 PASS＝假绿 ⇒ existence 一起判
         case when present.n = 3 and s03.n = 0 then 'PASS' else 'FAIL' end,
         '先例＝deletion_purges 不建 FK；反例＝identity_unbinds 建 cascade 只因它服务 churn 计数（N-1／U-20）' from s03, present
  union all
  select '04 RLS 开启', 'relrowsecurity = true ×3', s04.got,
         case when s04.n = 3 and s04.ok then 'PASS' else 'FAIL' end,
         '开了 RLS 又不建 policy ⇒ anon/authenticated 读写一律拒（4.6 的形状）' from s04
  union all
  select '05 零 policy', '三表都在，且 0 条 policy', coalesce(nullif(s05.got, ''), '0 条 policy'),
         case when present.n = 3 and s05.n = 0 then 'PASS' else 'FAIL' end,
         '出现任何一条都要先问"是谁为了什么加的"——用户能自助读订单表＝4.6 走 CF 的理由作废' from s05, present
  union all
  select '06 表权限', 'service_role 的 SELECT/INSERT/UPDATE/DELETE 各 3 表；anon／authenticated／PUBLIC 一条都没有', s06.got,
         case when s06.sr_sel = 3 and s06.sr_ins = 3 and s06.sr_upd = 3 and s06.sr_del = 3 and s06.leaked = 0
              then 'PASS' else 'FAIL' end,
         'authenticated 拿到任何权限＝端上能用 Bearer 直读订单表；缺某一权限＝重跑 pro-billing.sql 第 4 节。'
         || '⚠ actual 里 service_role 带 TRUNCATE/REFERENCES/TRIGGER/MAINTAIN 是**预期的**：Supabase 的'
         || 'ALTER DEFAULT PRIVILEGES 在建表当场就给了全权，我们的 grant 只做加法不收窄 ⇒ 真正要判的是'
         || 'leaked=0（anon／authenticated／PUBLIC 一条都不剩），而 RLS 管不住 TRUNCATE，所以那道 revoke 是唯一防线' from s06
  union all
  select '07 部分唯一索引', '三条都在且是 UNIQUE 且带 WHERE', s07.got,
         case when s07.ok then 'PASS' else 'FAIL' end,
         'order_active_uk 的语义＝"一笔单不能被撤两次账"，不是"一笔单只能有一条退款记录"（4.5 触发表）' from s07
  union all
  select '08 CHECK 条数', 'pro_orders 6／pro_ledger 2／pro_refund_requests 2', s08.got,
         case when s08.ok then 'PASS' else 'FAIL' end,
         '定义原文：' || s08.defs from s08
  union all
  select '09 判定函数唯一', 'pg_proc 里 proname=pro_coverage 恰好 1 个重载', s09.got,
         case when s09.n = 1 then 'PASS' else 'FAIL' end,
         '多个重载＝"一处真相"形状上还有第二处（pro-billing.sql 已先 drop function if exists）；验收 #39 库侧' from s09
  union all
  select '10 判定函数权限', 'EXECUTE 只给 service_role；STABLE + SECURITY INVOKER', s10.got,
         case when s09.n = 1 and s10.sr_can and s10.leaked = 0 then 'PASS' else 'FAIL' end,
         'INVOKER 是有意的：表上零 policy，非 service_role 即使拿到 execute 也读不到行 ⇒ fail-closed' from s10, s09
  union all
  select '11 解绑流水留痕列', 'identity_unbinds 有 operator／note／openid 三列', s11.got,
         case when s11.ok then 'PASS' else 'FAIL' end,
         '缺 operator ⇒ identity-unbind.js 的 `operator is null` 过滤写不出来，人工解绑会挤掉用户额度；缺 openid ⇒ 删完行库里再没有"解掉了哪个微信"（S-7）' from s11
  union all
  select '11b 留痕约束', '两条 "operator 非空 ⇒ 该项必填" 的 CHECK 都在', s11b.got,
         case when s11b.ok then 'PASS' else 'FAIL' end,
         '抓得住"写了流水但字段空"；抓不住"根本没写流水就删了行"——后者只有 pro-manual-unbind.sql 的模板与 4.8 路径清点能管（验收 #34）' from s11b
)

-- 🔴 UNION 的 ORDER BY 只许用结果列名，不许用表达式（0A000：Only result column names can be
--   used, not expressions or functions）⇒ 把整个 UNION 包进 FROM 再排。
select * from (
  select item, expected, actual, status, detail from rows_
  union all
  select '99 总判定'::text, '12 项全 PASS'::text,
         ((select count(*)::text from rows_) || ' 项里 FAIL ' ||
          (select count(*)::text from rows_ where status = 'FAIL'))::text,
         (case when (select count(*) from rows_ where status = 'FAIL') = 0
               then 'PASS' else 'FAIL' end)::text,
         '结构 PASS 不代表折叠算术对（pro-coverage-check.sql 也要跑）；反之它全绿也不代表 RLS／授权后来没被人在 Dashboard 手改过'::text
) u
order by (item = '99 总判定'), item;
