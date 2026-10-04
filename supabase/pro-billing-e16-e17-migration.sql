-- ============================================================================
-- E-16 判乙 ＋ E-17 判丙 的连带迁移（2026-10-05；owner 拍板：E-16 乙、E-17 丙、E-18 甲）
--
-- 只做两件事：
--   ① `pro_ledger.order_id` → `not null`
--   ② `pro_orders.anomaly_reason` 的 CHECK 加一个值 `refunded_not_credited`
-- 整份可以重复执行（三条语句都是幂等的）。
--
-- 🔴 为什么必须先删那 14 行：`alter column ... set not null` 在任何一行仍为 null 时直接失败
--   （23502）。而 2026-10-05 回读时库里 14 行**全部** `order_id is null`——它们不是脏数据，
--   是 `pro-coverage-check.sql` 第 26 行那句没带这一列的 insert 留下的夹具行。
--   ⇒ 也就是说 E-16 说的"漏写"形状已经被我们自己的核对脚本实证过一次。那一份今天已同步改掉
--   （补了 `gen_random_uuid()`），所以删掉不丢东西：重跑一次核对脚本就会带着 order_id 重新插回来。
--
-- ⚠️ 这条约束买到的是什么、没买到什么（别说大）：
--   ✅ 买到"该写没写"——将来任何路径（包括在 Dashboard 手插 SQL）漏掉 order_id 都会被库拒。
--   ❌ 没买到"写的 order_id 指向一张真订单"——本表按 D-2／4.6 **刻意不建 FK**，
--      那一半仍然只有"三张表的写面收敛在 `functions/_lib/proStore.js` 一个模块"这条入口约束在兜。
--   ⚠️ 顺带一条会随本次迁移失效的判据：`pro-ops.sql` 的 A9 与 `pro-fixture.sql` 的"非夹具行"
--      定义里都写着 `order_id is null` 也算真单。迁移之后那一支**永远不成立**（成了死分支），
--      但**不改**：留着它，将来若有人把约束改回去或从别的库导数据，它还会生效。
-- ============================================================================

-- ① 清掉核对脚本留下的夹具行（它们没有 order_id，会挡住 set not null）。
--    🔴 只按 PROCHECK 前缀删，不碰 FIXTURE- 那批真账号夹具、更不碰任何有 order_id 的行。
delete from public.pro_ledger
 where order_id is null and payer_openid like 'PROCHECK%';

-- ② E-16 判乙：这一列从此必填。
alter table public.pro_ledger alter column order_id set not null;

-- ③ E-17 判丙：主动查单回"平台已退款"而我方从未入账 ⇒ 旧单标 anomaly（不是 closed、也不是 refunded），
--    所以 CHECK 要认这个值。原约束是列内联定义的，自动名就是 pro_orders_anomaly_reason_check。
alter table public.pro_orders drop constraint if exists pro_orders_anomaly_reason_check;
alter table public.pro_orders add constraint pro_orders_anomaly_reason_check
  check (anomaly_reason is null or anomaly_reason in (
    'amount_mismatch', 'product_mismatch', 'openid_mismatch',
    'appid_mismatch', 'env_mismatch', 'sign_invalid',
    'no_such_order', 'orphan', 'refunded_not_credited'));


-- ────────────────────────────────────────────────────────────────────────────
-- 证据（🔴 必须是最后一句：Supabase SQL Editor 只显示最后一条语句的结果）
-- 期望：**六行全 PASS**。任何一行 FAIL 都别往下走（尤其 ③④ 关系着 B4 撤账找不找得到行）。
-- ────────────────────────────────────────────────────────────────────────────
select '① order_id 已是 not null' as 检查项,
       case when is_nullable = 'NO' then 'PASS' else 'FAIL 仍是 ' || is_nullable end as 结果
  from information_schema.columns
 where table_schema = 'public' and table_name = 'pro_ledger' and column_name = 'order_id'
union all
select '② 缺 order_id 的账本行 = 0',
       case when count(*) = 0 then 'PASS' else 'FAIL 还有 ' || count(*) || ' 行' end
  from public.pro_ledger where order_id is null
union all
select '③ 账本行 order_id 仍是 unique',
       case when count(*) = 1 then 'PASS' else 'FAIL 找不到 unique 约束' end
  from pg_constraint
 where conrelid = 'public.pro_ledger'::regclass and contype = 'u'
   and conname = 'pro_ledger_order_id_key'
union all
select '④ anomaly CHECK 认 refunded_not_credited',
       case when pg_get_constraintdef(oid) like '%refunded_not_credited%' then 'PASS'
            else 'FAIL 现值 ' || pg_get_constraintdef(oid) end
  from pg_constraint
 where conrelid = 'public.pro_orders'::regclass and conname = 'pro_orders_anomaly_reason_check'
union all
-- 🔴 逐个点名八个旧值，不用"引号个数 ≥ N"那种代理判据（少一个值它照样过，那就不是核对）。
select '⑤ 旧八个值一个都没丢',
       case when (select count(*)
                    from unnest(array['amount_mismatch', 'product_mismatch', 'openid_mismatch',
                                      'appid_mismatch', 'env_mismatch', 'sign_invalid',
                                      'no_such_order', 'orphan']) as v
                   where position(('''' || v || '''') in pg_get_constraintdef(c.oid)) > 0) = 8
            then 'PASS'
            else 'FAIL 枚举里少了旧值：' || pg_get_constraintdef(c.oid) end
  from pg_constraint c
 where c.conrelid = 'public.pro_orders'::regclass and c.conname = 'pro_orders_anomaly_reason_check'
union all
select '⑥ 写这一列的入口没变（CF 侧仍只有 proStore）',
       '人工确认：见 handle-platform/scripts/test-pro-credit.mjs 第 9 节静态门'
union all
select '⑦ 现有账本行总数（迁移前后应当只少了 PROCHECK 那批）',
       count(*)::text || ' 行' from public.pro_ledger
order by 1;


-- ────────────────────────────────────────────────────────────────────────────
-- 迁移之后紧接着做的一件事（不在本文件里，因为它是另一份脚本）：
--   跑一遍 `supabase/pro-coverage-check.sql` ⇒ 期望仍是 **19/19 PASS**。
--   它现在会自己给夹具行补 `gen_random_uuid()`，所以在新约束下重跑是安全的；
--   如果它报 23502，说明这份迁移里的 ② 生效了而核对脚本没同步（那就是我改漏了）。
-- 收尾（可选，同一次编辑器会话里再执行一次即可）：
--   delete from public.pro_ledger where payer_openid like 'PROCHECK%';
-- ────────────────────────────────────────────────────────────────────────────
