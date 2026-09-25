-- ============================================================================
-- balances-recovery-fn-check.sql · 只读 · 把 RLS 策略里那个「仓库查不到」的函数照亮
--
-- 为什么值得跑（2026-09-25）：`balances-schema-check.sql` 查出现网那条策略的谓词不是
--   `auth.uid() = user_id`，而是 `((auth.uid() = user_id) AND (NOT is_recovery_session()))`。
--   ⇒ 隔离比方案里以为的**更硬**（恢复态在库里也被拒，不只在内网那层）；
--   ⇒ 但 `is_recovery_session()` 在 `handle-platform` 全仓**零命中**（已 grep 确认），
--     函数体和 `balances` 的 DDL 同一类：**跑在生产库上、没有任何文件描述它**。
--   本脚本跑三段：① 函数本体与它的 kind/volatility/权限形态 ② 还有哪些表的策略在用它
--   ③ 谁能 EXECUTE。⇒ 判断它是"全栈约定"还是"balances 独有"、以及它自己是不是一个新面。
--
-- 全部为 SELECT，零写入、零 DDL。整体执行，结果整份贴回。
-- 对应：doc/miniprogram-ai-s2-balance-prd.md 的 2.4.1 与 BR15
-- ============================================================================

-- ① 函数本体
select p.oid::regprocedure                                                     as sig,
       n.nspname                                                               as schema_name,
       l.lanname                                                               as lang,
       case p.prokind when 'f' then 'FUNCTION'    when 'p' then 'PROCEDURE'
                      when 'a' then 'AGGREGATE'   when 'w' then 'WINDOW'
                      else 'prokind=' || p.prokind::text end                   as kind,
       case p.provolatile when 'i' then 'IMMUTABLE' when 's' then 'STABLE'
                          when 'v' then 'VOLATILE'
                          else 'provolatile=' || p.provolatile::text end        as volatility,
       case when p.prosecdef then 'SECURITY DEFINER' else 'SECURITY INVOKER' end as invoker,
       -- ⚠ 取不到定义不代表函数不存在：内置/内部实现的函数 pg_get_functiondef 返回 NULL。
       --   真返回 NULL 时，退一步跑 `select prosrc from pg_proc where oid = p.oid` 看源码串。
       coalesce(pg_get_functiondef(p.oid), '（pg_get_functiondef 取不到定义）')  as def
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_language  l on l.oid  = p.prolang
where p.proname = 'is_recovery_session'
order by 1;

-- ② 还有哪些表的 RLS 策略在用它（判断它是"全栈约定"还是"balances 独有"）
select schemaname || '.' || tablename                                     as tbl,
       policyname                                                         as policy,
       cmd,
       (coalesce(qual,      '') ~ 'is_recovery_session')                  as in_qual,
       (coalesce(with_check, '') ~ 'is_recovery_session')                 as in_with_check
from pg_policies
where coalesce(qual,       '') like '%is_recovery_session%'
   or coalesce(with_check, '') like '%is_recovery_session%'
order by 1, 2;

-- ③ 这函数当前谁能 EXECUTE（只有第 ① 条查出它是 SECURITY DEFINER 时，这一行才有意义）
-- ⚠ 走 `pg_proc.proacl` + `aclexplode`（两者自 PG 9.0 就在）。**不用** `pg_proc_priv`：
--   那个目录到底存不存在我没有把握，而"拿一个未验证的目录名去查另一个未验证的对象"
--   正是本轮已经栽过三次的形状（tgtype 位掩码 / name[] 不能 cast / int2vector 伪数组）。
select n.nspname || '.' || p.oid::regprocedure                            as sig,
       coalesce(string_agg(
         (case when a.grantee = 0 then 'PUBLIC'
               else pg_get_userbyid(a.grantee) end)
         || ':' || a.privilege_type
         || '(Granted BY ' || pg_get_userbyid(a.grantor)
         || case when a.is_grantable then ', GRANT OPTION' else '' end || ')',
         ' / ' order by a.privilege_type),
         '（proacl 为 NULL ⇒ 没有显式授权，走默认：只有 owner 与超级用户可执行）'
       )                                                                    as who_can
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
left join lateral aclexplode(p.proacl) as a on true
where p.proname = 'is_recovery_session'
group by 1;
