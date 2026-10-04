-- ============================================================================
-- pro-coverage-check.sql · 行为核对 · 验收 #46 六格与折叠的七条边界
--
-- 用法：Supabase SQL Editor **整体执行**，最后一份结果是一张 PASS/FAIL 表，整份贴回。
--   前置：pro-billing.sql 已在同一个库执行（表与函数都在）。
--   会写库：只往 public.pro_ledger 插 `payer_openid like 'PROCHECK%'` 的 fixture 行，
--   脚本开头先删残留 ⇒ 可反复重跑；结尾**不删**（否则编辑器只显示 DELETE 的结果，
--   看不到判定表）。fixture 是惰性的：判定要先经 user_identities 的 join 拿到真实
--   openid（4.4），而这些合成串不是合法 openid 形态、也不会出现在那张表里 ⇒ 永远不会
--   把任何账号判成会员。要清干净就跑文件末尾那一行 DELETE。
--
-- 为什么这份文件值得存在（PRD v3 的判据形状）：
--   · 4.3 的折叠是"读时算"，库里不落绝对区间 ⇒ 没有回归网的话，接龙／撤销／并发
--     三种重排只能靠真机买卡去撞。
--   · 🔴 #46⑥ 用**天数总量**（要 60、不是 59）判，而不是"看有没有 greatest 那一项"——
--     因为 `prev_last_day` 曾被误赋成"首日"，写起来像加了修正、算出来与完全没修正一样。
--   · #46⑤ 专门测 23:59:59.5 那一秒：判据必须是 `now < end_excl`（左闭右开），
--     用 `valid_until > now` 会留下每天最后一秒"既不算覆盖也不显示过期"的静默空洞。
--   · env 两格是"防沙箱单发真实会员"的唯一闸门（4.2 已注明 appid/env 的 anomaly 分支
--     是死的），所以它必须有测试，不能只靠代码里传参。
-- ============================================================================

delete from public.pro_ledger where payer_openid like 'PROCHECK%';

-- ---------- fixture（14 行；revoked 行直接用 revoked_at 造，不用 UPDATE，保证可反复重跑） ----------
insert into public.pro_ledger (provider, payer_openid, env, effective_at, duration_days, revoked_at, order_id) values
  -- 单档月卡：10-03 14:00 买 ⇒ 覆盖 10-03…11-01
  ('wechat_mp', 'PROCHECK-M',  0, '2026-10-03 14:00+08', 30, null, gen_random_uuid()),
  -- 接龙：11-01 当天续购（旧写法会让两档共用 11-01 ⇒ 合计只推 29 天）
  ('wechat_mp', 'PROCHECK-J',  0, '2026-10-03 14:00+08', 30, null, gen_random_uuid()),
  ('wechat_mp', 'PROCHECK-J',  0, '2026-11-01 14:00+08', 30, null, gen_random_uuid()),
  -- 到期之后再买：新周期从**付款时刻**起算（五矩阵"到期"那格），不接龙到 11-02
  ('wechat_mp', 'PROCHECK-G',  0, '2026-10-03 14:00+08', 30, null, gen_random_uuid()),
  ('wechat_mp', 'PROCHECK-G',  0, '2026-12-01 10:00+08', 30, null, gen_random_uuid()),
  -- 买两笔退第一笔（#11）：撤销行被排除 ⇒ 第二笔从**它自己的 effective_at** 起算
  ('wechat_mp', 'PROCHECK-R',  0, '2026-10-03 14:00+08', 30, '2026-11-04 09:00+08', gen_random_uuid()),
  ('wechat_mp', 'PROCHECK-R',  0, '2026-10-30 14:00+08', 30, null, gen_random_uuid()),
  -- 同一对行的基线（两笔都在 ⇒ 接龙到 12-01）
  ('wechat_mp', 'PROCHECK-R2', 0, '2026-10-03 14:00+08', 30, null, gen_random_uuid()),
  ('wechat_mp', 'PROCHECK-R2', 0, '2026-10-30 14:00+08', 30, null, gen_random_uuid()),
  -- 全部撤销 ⇒ 与"无任何行"同形
  ('wechat_mp', 'PROCHECK-AR', 0, '2026-10-03 14:00+08', 30, '2026-11-04 09:00+08', gen_random_uuid()),
  -- env 隔离：同一个人沙箱单与现网单各一行
  ('wechat_mp', 'PROCHECK-E0', 0, '2026-10-03 14:00+08', 30, null, gen_random_uuid()),
  ('wechat_mp', 'PROCHECK-E1', 1, '2026-10-03 14:00+08', 30, null, gen_random_uuid()),
  -- 并发同秒两笔（D-2 撤锁后的形状：靠 effective_at, id 排序接龙，无双花）
  ('wechat_mp', 'PROCHECK-S',  0, '2026-10-03 14:00+08', 30, null, gen_random_uuid()),
  ('wechat_mp', 'PROCHECK-S',  0, '2026-10-03 14:00+08', 30, null, gen_random_uuid());

-- ✅ E-16 判乙（2026-10-05）：`pro_ledger.order_id` 现在是 `not null unique`，上面每行都得自带
--   `gen_random_uuid()`——**不能改成"插完再 update 补上"**：`INSERT` 在写入那一刻就撞 23502，等不到后面
--   那句 UPDATE（这条是离线 PGlite 跑出来的，不是我推的：第一版就是这么写的，3.2 那格直接红）。
--   为什么补假 uuid 而不是给每个夹具配一行真订单：本表按 D-2／4.6 **刻意不建 FK** ⇒ "有没有指向真单"
--   从来不是库判据；而折叠只读 `effective_at`／`duration_days`／`revoked_at` 三列，`order_id` 对判定
--   完全中性 ⇒ 夹具要的是"每行一个互不相同的非空值"（好让 unique 也顺带被走到），不是"能 join 回订单"。
--   🔴 顺带一条自证：owner 2026-10-05 回读这张表时 14 行**全部** `order_id is null`，来源就是本文件
--   改之前的那句 insert——"漏写"这个形状不是假想，它已经在库里存在过。

-- ---------- 判定 ----------
with cases(name, provider, openid, env, p_now, exp_covered, exp_until, exp_remaining, why) as (
  values
  -- 🔴 验收 #46 六格
  ('46-① 覆盖到第 30 个自然日', 'wechat_mp', 'PROCHECK-M',  0, '2026-10-04 00:30+08'::timestamptz,
     true,  '2026-11-01 23:59:59+08'::timestamptz, 28,
     '10-03 下午买月卡 ⇒ 到 11-01 23:59:59，不是 11-02（D-13 已判＝甲，含生效当日）'),
  ('46-② 到期日全天仍是会员',   'wechat_mp', 'PROCHECK-M',  0, '2026-11-01 00:00:30+08'::timestamptz,
     true,  '2026-11-01 23:59:59+08'::timestamptz,  0,
     'remaining_days 到期当天算 0 ⇒ 3.6 提示与前置⑤读同一个整数'),
  ('46-② 次日 00:00 判出免费',   'wechat_mp', 'PROCHECK-M',  0, '2026-11-02 00:00:00+08'::timestamptz,
     false, '2026-11-01 23:59:59+08'::timestamptz, -1,
     '剩余天数**可以为负**（已过期）⇒ 消费侧别把负数渲染成"还剩 -1 天"'),
  ('46-③ 到期前第 20 天可买',   'wechat_mp', 'PROCHECK-M',  0, '2026-10-12 09:00+08'::timestamptz,
     true,  '2026-11-01 23:59:59+08'::timestamptz, 20,
     '恰好 20 天算可买；判据是 remaining_days<=20，不是与 20×24h 比（第二十轮评审第 20 条）'),
  ('46-④ 第 21 天该被拒',       'wechat_mp', 'PROCHECK-M',  0, '2026-10-11 09:00+08'::timestamptz,
     true,  '2026-11-01 23:59:59+08'::timestamptz, 21,
     '21 ⇒ 前置⑤ 拒绝，且提示里的"N 天"必须与账户页同一个整数'),
  ('46-⑤ 每天最后一秒不掉洞',   'wechat_mp', 'PROCHECK-M',  0, '2026-11-01 23:59:59.5+08'::timestamptz,
     true,  '2026-11-01 23:59:59+08'::timestamptz,  0,
     '🔴 抓"用 valid_until > now 比较"的写法：那一秒落在 23:59:59 与次日 00:00 之间'),
  ('46-⑥ 接龙不重叠不丢天',     'wechat_mp', 'PROCHECK-J',  0, '2026-10-04 00:30+08'::timestamptz,
     true,  '2026-12-01 23:59:59+08'::timestamptz, 58,
     '第二档覆盖 11-02…12-01（不是 11-01…11-30）⇒ 见下面"合计 60 天"那一格'),
  -- 其余边界
  ('到期后再买从付款时刻起算',   'wechat_mp', 'PROCHECK-G',  0, '2026-12-05 08:00+08'::timestamptz,
     true,  '2026-12-30 23:59:59+08'::timestamptz, 25,
     '12-01 10:00 买 ⇒ 覆盖 12-01…12-30；若写成 11-02 起算就是把空档也接了龙'),
  ('退款后第二笔顶上（撤销行排除）','wechat_mp','PROCHECK-R', 0, '2026-11-05 08:00+08'::timestamptz,
     true,  '2026-11-28 23:59:59+08'::timestamptz, 23,
     '#11/#15：退掉第一笔 ⇒ 第二笔从自身 effective_at(10-30) 起算，当场生效、不空一年'),
  ('两笔都在时接龙到 12-01',     'wechat_mp', 'PROCHECK-R2', 0, '2026-11-05 08:00+08'::timestamptz,
     true,  '2026-12-01 23:59:59+08'::timestamptz, 26,
     '与上一格同一对行、只差 revoked_at ⇒ 折叠"读时算"的全部价值就在这两格的差里'),
  ('全撤销＝与无行同形',         'wechat_mp', 'PROCHECK-AR', 0, '2026-10-04 00:30+08'::timestamptz,
     false, null, null,
     'valid_until／remaining_days 都回 null ⇒ 端上不得把 null 渲染成"永久／无限"（7.5 第 4 条）'),
  ('无任何账本行＝免费档',       'wechat_mp', 'PROCHECK-NONE', 0, '2026-10-04 00:30+08'::timestamptz,
     false, null, null,
     '🔴 这一格同时是"函数有没有按 openid 筛"的判据：若它返回 true，说明 p_openid 没用上'),
  ('env 现网单只被 env=0 看见',   'wechat_mp', 'PROCHECK-E0', 0, '2026-10-04 00:30+08'::timestamptz,
     true,  '2026-11-01 23:59:59+08'::timestamptz, 28,
     'PRO_ENV=0（现网）读现网单'),
  ('env 现网单不被 env=1 看见',   'wechat_mp', 'PROCHECK-E0', 1, '2026-10-04 00:30+08'::timestamptz,
     false, null, null,
     '🔴 反向也必须是 false，否则"沙箱判定读到现网权益"'),
  ('env 沙箱单只被 env=1 看见',   'wechat_mp', 'PROCHECK-E1', 1, '2026-10-04 00:30+08'::timestamptz,
     true,  '2026-11-01 23:59:59+08'::timestamptz, 28,
     'D-10 已判 V1 不依赖 env=1 发货，但这一列与这道隔离**保留**'),
  ('env 沙箱单不被 env=0 看见',   'wechat_mp', 'PROCHECK-E1', 0, '2026-10-04 00:30+08'::timestamptz,
     false, null, null,
     '🔴 这条就是"沙箱单发出真实会员"的闸门（anomaly_reason 的 env_mismatch 是死分支，靠的是这里）'),
  ('provider 不同 ⇒ 判不出',     'alipay',    'PROCHECK-M',  0, '2026-10-04 00:30+08'::timestamptz,
     false, null, null,
     '反例判据 3：查询必须限定 provider（unique(user_id,provider) 允许一个账号多条不同 provider 行）'),
  ('并发同秒两笔照样接龙',       'wechat_mp', 'PROCHECK-S',  0, '2026-10-04 00:30+08'::timestamptz,
     true,  '2026-12-01 23:59:59+08'::timestamptz, 58,
     'D-2 撤掉 openid 级锁的依据：排序键 effective_at,id 已足够，两笔不重叠也不丢天')
),
resolved as (
  -- 🔴 这里刻意用 PRD 4.4 写的**同一个调用形状** `(f()).列名`，而不是 `from f()`：
  --   一、本文件因此顺带证明"4.4 那句判定 SQL 在真库里 parse 得过、OUT 名字对得上"；
  --   二、函数声明是 `returns record` + OUT 参数，`from f()` 那条路依赖优化器从 OUT
  --   参数推导出元组描述符——我没有一手验证过它在本库版本上一定通过，而"猜一个没实测的
  --   调用形状"正是 balances-schema-check.sql:26-27 记过的那类栽法（tgtype / pg_proc_priv）。
  --   ⇒ 代价：同一行调三次函数。18 行 × 通常 1–3 条账本行，可忽略。
  -- ⚠ 第三个参数**不写 ::smallint**：函数的 p_env 已改成 integer（见 pro-billing.sql 里那条
  --   42883 实测），这里保持与运维/CF 一样自然的字面量写法，才能持续证明"字面量调用可用"。
  select c.*,
         (public.pro_coverage(c.provider, c.openid, c.env, c.p_now)).is_covered     as got_covered,
         (public.pro_coverage(c.provider, c.openid, c.env, c.p_now)).valid_until    as got_until,
         (public.pro_coverage(c.provider, c.openid, c.env, c.p_now)).remaining_days as got_remaining
  from cases c
)
select name as "用例",
       case when r.exp_until is null
              then 'covered=' || r.exp_covered::text || ' ｜ until=∅ ｜ remaining=∅'
            else 'covered=' || r.exp_covered::text
                 || ' ｜ until='  || to_char(r.exp_until at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')
                 || ' ｜ remaining=' || coalesce(r.exp_remaining::text, '∅')
       end as "期望",
       case when r.got_until is null
              then 'covered=' || coalesce(r.got_covered::text, 'NULL') || ' ｜ until=∅ ｜ remaining=∅'
            else 'covered=' || coalesce(r.got_covered::text, 'NULL')
                 || ' ｜ until='  || to_char(r.got_until at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')
                 || ' ｜ remaining=' || coalesce(r.got_remaining::text, '∅')
       end as "现值",
       case when r.got_covered = r.exp_covered
              and r.got_until is not distinct from r.exp_until
              and r.got_remaining is not distinct from r.exp_remaining
            then 'PASS' else 'FAIL' end as "判定",
       r.why as "这一格在防什么"
from resolved r

union all

-- 🔴 #46⑥ 的天数总量判据（不是"看有没有 greatest 那一项"）：两档不重复合计必须 60 天
select '46-⑥ 两档不重复合计天数', '60 天',
       ((r.got_until at time zone 'Asia/Shanghai')::date - date '2026-10-03' + 1)::text || ' 天',
       case when ((r.got_until at time zone 'Asia/Shanghai')::date - date '2026-10-03' + 1) = 60
            then 'PASS' else 'FAIL' end,
       '59 天 ⇒ prev_last_day 被赋成了"首日"，接龙共用一天、用户白花一张卡的一天'
from resolved r where r.name = '46-⑥ 接龙不重叠不丢天'

order by 1;

-- 清残留（想跑完就擦干净再执行这一行）：
-- delete from public.pro_ledger where payer_openid like 'PROCHECK%';
