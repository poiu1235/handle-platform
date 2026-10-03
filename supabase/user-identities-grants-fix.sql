-- ============================================================================
-- user-identities-grants-fix.sql · 增量：撤掉 user_identities 上默认给出去的 anon／authenticated 全权
--
-- 起因（2026-10-04 会员体系 B0 的副产物，全库 ACL 探针查出来的，不是会员体系本身的问题）：
--   Supabase 在 public schema 上装了 `ALTER DEFAULT PRIVILEGES ... grant all on tables
--   to anon, authenticated, service_role` ⇒ **任何新表一落地就带着**
--   `anon=arwdDxtm / authenticated=arwdDxtm`。实测现值：
--     user_identities | 开了RLS=true | anon.SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN
--                     |              | authenticated.同上八项
--
-- 🔴 为什么"开了 RLS 就够了"是错的：行级安全只过滤 SELECT/INSERT/UPDATE/DELETE 的**行**，
--   管不住 **TRUNCATE／REFERENCES／TRIGGER／MAINTAIN**。所以那道 revoke 不是纵深防御，
--   是唯一防线。今天不可达（PostgREST 没有 TRUNCATE 动词），风险是放大器型的：将来任何一个
--   `security definer` 函数、一次直连、或"临时在 Dashboard 跑条语句"都会把它变成够得着。
--   而 user_identities 偏偏是 2.2 推论 2 那两条唯一约束的载体＝整个付费墙的承重墙
--   （account-membership-prd-v3.md 2.2／4.6）。
--
-- ✅ 为什么这一条是零影响（逐点扫过消费者，不是"看起来没人用"）：
--   全仓 8 个 /rest/v1/user_identities 访问点**全部**走 serviceRoleFetch：
--     auth/identities.js:17 · auth/identity-unbind.js:37,79 · auth/login.js:63,71,83,96,101
--     auth/wechat-bind.js:26,40,50,58 · auth/wechat-login.js:31 · _lib/guestUser.js:93
--   两个出现 SUPABASE_ANON_KEY 的文件（login.js:37、_lib/userAuth.js:73,92）打的是
--   `/auth/v1/token`、`/auth/v1/verify`（GoTrue），**不是** /rest/v1 ⇒ anon 角色不参与
--   这张表的任何一次读写。
--
-- owner 裁定（2026-10-04）＝**丙：只补 user_identities，业务三表只登记不撤**。
--   理由原话：「历史逻辑尽量少改动，日后碰到了再改」。
--
-- ⚠️ 不要照抄到 notes／cards／balances：那三张表的 `authenticated` **就是业务 DML 的实际角色**
--   （CF 侧带 anon key 只是入场券，PostgREST 的角色取自用户 JWT 的 role 声明）⇒
--   对它们写 `revoke all from authenticated` 会当场废掉整个 App。要撤也只能撤
--   truncate/references/trigger/maintain 那四项，而这一版**不做**。
-- ⚠️ 也不要"顺手"给 service_role 补一句 revoke 或 grant：它的权限同样来自默认授予，
--   撤它＝当场断掉身份链路；而 grant 只做加法、不收窄，补一句也不改变现状。
--
-- 在 Supabase SQL Editor 整体执行一次；幂等（revoke 可重复）。
-- 最后一句是验证：一份结果，既证明本文件生效，也把三条"已知限制"留在明面上。
-- ============================================================================

revoke all on public.user_identities from anon, authenticated;


-- ---------- 验证（单条语句、一份结果） ----------
-- 期望：user_identities 与三张 pro_* 表都**不出现**在明细里（＝已撤净）；
--       notes／cards／balances 仍在，判定列写"已知限制"＝有意保留，不是漏做。
with expect(t, need_clean, why) as (values
  ('user_identities',      true,  '本文件刚撤；它是付费墙两条唯一约束的载体'),
  ('pro_orders',           true,  'pro-billing.sql 第 4 节撤的'),
  ('pro_ledger',           true,  '同上'),
  ('pro_refund_requests',  true,  '同上'),
  ('identity_unbinds',     true,  'd5-unbind-churn.sql:26 撤的'),
  ('notes',                false, 'owner 判丙：登记不撤——authenticated 是业务 DML 的实际角色，只该撤 truncate/references/trigger/maintain 那四项，本版不做'),
  ('cards',                false, 'owner 判丙：登记不撤——同上（⚠ 本表 authenticated 实测只有 4 项，与另两张不同形，差异不来自仓库 SQL）'),
  ('balances',             false, 'owner 判丙：登记不撤——同上')),
bad as (
  select c.relname as t,
         count(*) as n,
         string_agg(distinct case when a.grantee = 0 then 'PUBLIC'
                                  else pg_get_userbyid(a.grantee) end
                     || '.' || a.privilege_type, ' ') as grants
  from pg_class c
  cross join lateral aclexplode(c.relacl) a
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon','authenticated'))
  group by c.relname
)
select e.t as 表,
       case when e.need_clean then '应撤净' else '已知限制（有意保留）' end as 期望,
       coalesce(b.n::text, '0') as 匿名或登录态持有的权限条数,
       coalesce(b.grants, '—') as 明细,
       case when e.need_clean and b.n is null then 'PASS'
            when e.need_clean then 'FAIL ⇒ 重跑本文件（或该表被别的路径重建过）'
            else '已知限制（2026-10-04 owner 判：登记，日后碰到再改）'
       end as 判定,
       e.why as 备注
from expect e
left join bad b using (t)
-- ⚠ 输出列别名只能当**裸排序键**用，不能出现在表达式里（PG 文档明写；写成
--   `order by (判定 = 'PASS')` 会 42703 column "判定" does not exist——这条又是
--   只有真库能发现、raw parser 查不出的那类）。⇒ 排序键重复一遍判定表达式本身。
order by (case when e.need_clean and b.n is null then 0 else 1 end), e.t;

-- ⚠️ 顺带一条给未来的判据：本文件与 pro-billing-schema-check.sql 第 06 项**覆盖面不同**——
--   第 06 项只判三张 pro_* 表，这张文件判"public 下所有表"。新建任何表之后重跑最后那句
--   SELECT 即可看见它有没有被默认授予全权（`need_clean` 想加就加一行）。
