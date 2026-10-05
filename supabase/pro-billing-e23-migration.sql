-- ============================================================================
-- E-23 判甲 的迁移（2026-10-05；owner 拍板：「我也建议加，采纳甲方案」）
--
-- 只做一件事：`pro_orders` 加一列 `wxpay_order_id text`（可空）＋ 一条**非唯一** partial index。
-- 整份可以重复执行（两条都是幂等的）。
--
-- 为什么要有这一列（一手事实，正本附录甲 2026-10-05 那一行）：一笔**已付**单的查单回包里
-- 同时有三个单号——`wx_order_id`（`VPO…`，未付就有 ⇒ 平台侧订单号）、`channel_order_id`（`2026…`）、
-- **`wxpay_order_id`（`4500…`）**。最后这一个才是后台「交易订单」里"交易单号"那一列的样子，
-- 也是客服／对账实际会报给我们的那一个。我方原来只存了第一个 ⇒ 想按交易单号反查这一行，
-- 只能去翻后台截图。
--
-- 🔴 为什么**不加 unique**（这条是这次决定的边界，别"顺手补上"）：
--   这一列由查单回填，走的是 `markOrderPaid` 那条 PATCH。给它加唯一约束 ⇒ 万一平台让两行
--   共用一个交易号（同一笔钱被两次认领、或平台侧改了归属），PATCH 会撞 23505 抛错 ⇒
--   按 4.5 的形状"状态没改成 ⇒ 账本也不写"，结果就是**一笔已付的钱入不了账**，
--   而那比"两个单号重复"坏得多（前者用户付了钱没会员，后者只是留痕不漂亮）。
--   要不要拿它当真正的幂等键，等 B4 真见过两笔同交易号的单再说。
--
-- ⚠️ 回填的边界：`GET /api/pro/orders/:no` 只在 `status='pending'` 时才查单 ⇒ **已付的历史单不会被
--   自动补上这一列**。今天库里那两笔（`T179117876795633e1852d` 已付、`T17911411665627c4f6928` 已退）
--   的交易号已经在探针回包里见过，要留痕就手工 UPDATE 那两行（值不在本文件里，避免把真实单号
--   写进仓库当模板被人整体执行）。
-- ============================================================================

-- 🔴 两条改动包在**一个 DO 块**里（理由同 E-16/E-17 那份：Supabase SQL Editor 只显示最后一条
--   语句的结果 ⇒ 独立语句时"跑过了"与"跑砸了"在屏幕上长得一样）。
do $mig$
begin
  execute 'alter table public.pro_orders add column if not exists wxpay_order_id text';

  -- 非唯一 + partial：只为"按交易单号反查"服务，不承诺唯一性（见文件头那段）。
  execute 'create index if not exists pro_orders_wxpay_order_idx
             on public.pro_orders (wxpay_order_id)
             where wxpay_order_id is not null';
end
$mig$;


-- ────────────────────────────────────────────────────────────────────────────
-- 证据（🔴 必须是最后一句：编辑器只显示最后一条语句的结果）
-- 期望：**六行里没有一行 FAIL**。
-- ────────────────────────────────────────────────────────────────────────────
select '⓪ 迁移到底跑没跑（看形状，不看屏幕有没有报错）' as 检查项,
       case when exists(select 1 from information_schema.columns x
                         where x.table_schema = 'public' and x.table_name = 'pro_orders' and x.column_name = 'wxpay_order_id')
            then 'PASS 跑了'
            else 'FAIL 没跑：列不在 ⇒ 上面那个 DO 块没执行（或执行失败被回滚）' end as 结果
union all
select '① 新列是 text 且可空（可空是刻意的：未付单根本没有交易号）',
       case when data_type = 'text' and is_nullable = 'YES' then 'PASS'
            else 'FAIL 现值 ' || data_type || '／is_nullable=' || is_nullable end
  from information_schema.columns
 where table_schema = 'public' and table_name = 'pro_orders' and column_name = 'wxpay_order_id'
union all
select '② 反查用的 partial index 在，且带 WHERE（全表索引会白吃一份写放大）',
       -- ⚠️ `pg_indexes.indexdef` 回的是**规范化后**的文本：关键字是大写的（`WHERE (wxpay_order_id IS NOT NULL)`）
       --    ⇒ 判它一律 `lower(...) like`，按小写字面量比会得到一条假 FAIL（这份文件第一版就踩了）。
       case when (select count(*) from pg_indexes
                   where schemaname = 'public' and tablename = 'pro_orders'
                     and indexname = 'pro_orders_wxpay_order_idx'
                     and lower(indexdef) like '%where%'
                     and lower(indexdef) like '%wxpay_order_id is not null%') = 1
            then 'PASS'
            else 'FAIL 没找到，或它不是 partial 的：' ||
                 coalesce((select indexdef from pg_indexes where indexname = 'pro_orders_wxpay_order_idx'), '（无此索引）') end
union all
-- 🔴 这一格钉的是这次决定本身：加了唯一约束就是"已付的钱入不了账"那颗雷，所以要判它在不在。
--    ⚠️ 两种"唯一"都要数：`add unique` 落进 pg_constraint，而 `create unique index` **不落**（partial 的
--       那条尤其容易忘——`pro_orders_wx_order_uk` 就是索引不是约束，按 pg_constraint 查它会永远数到 0）。
select '③ 🔴 新列上不许有 unique（回填撞唯一＝一笔已付的钱入不了账）',
       case when (select count(*) from pg_constraint c
                   join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
                  where c.conrelid = 'public.pro_orders'::regclass and c.contype = 'u'
                    and a.attname = 'wxpay_order_id')
                 + (select count(*) from pg_indexes i
                     where i.schemaname = 'public' and i.tablename = 'pro_orders'
                       and lower(i.indexdef) like '%unique%'
                       and lower(i.indexdef) like '%wxpay_order_id%') = 0
            then 'PASS 没有'
            else 'FAIL 有人加了 unique ⇒ 立刻撤掉，见文件头那段' end
union all
select '④ 旧那条 wx_order_uk 仍是 unique 索引（本次没顺手动它；E-22 只降级了语义，没撤约束）',
       case when exists(select 1 from pg_indexes i
                         where i.schemaname = 'public' and i.tablename = 'pro_orders'
                           and i.indexname = 'pro_orders_wx_order_uk'
                           and lower(i.indexdef) like '%unique%')
            then 'PASS' else 'FAIL 不见了' end
union all
select '⑤ 已付单里这一列还空着几行（历史单不会被自动回填，见文件头）',
       case when count(*) = 0 then 'PASS 0 行' else 'PASS（预期内）' || count(*)::text || ' 行是本次之前的历史单' end
  from public.pro_orders where status = 'paid' and wxpay_order_id is null
order by 1;


-- ────────────────────────────────────────────────────────────────────────────
-- 迁移之后紧接着做的两件事（都不在本文件里）：
--   1. 跑 `supabase/pro-billing-schema-check.sql` ⇒ 期望 **14/14 PASS**（第 13 项就是这一列）；
--   2. 部署新的 CF 代码 ⇒ 从下一次入账起，`markOrderPaid` 会把查单回包里的 `wxpay_order_id` 写进来。
--      取证格＝验收 #71①（tail 里那行 `[proCredit] notify_provide_goods`）之后，
--      `select out_trade_no, wx_order_id, wxpay_order_id from pro_orders where status='paid' order by paid_at desc limit 3;`
--      要能看到 `4500…` 那一个真的落进了新列。
-- ────────────────────────────────────────────────────────────────────────────
