-- ============================================================================
-- pro-fixture.sql —— 给**自测账号**插一条形状完整的会员账本（PRD v3 S-2 已判＝可以做）
--
-- 它是干什么的：B2-2 那两格真机判据需要一个"库里判得出会员"的账号——
--   ① 账户页第 0 面板看得到会员位（正本 8.3 关态判据第 3 条后半）；
--   ② 三页在两个开关都关时**不出现**余量行与撞墙引导（8.3 第 1、2 条）。
--   🔴 两格都不需要开任何一个开关：会员位走 `GET /api/pro/session` 的 `proUntil`，
--   而那条路径**不受两个会员开关门控**（8.3 第 4 条：到期告知属交易类通知）。
--
-- 为什么这不算 7.6 禁止的"手工发权益"：7.6 禁的是**给真实用户**无订单补权益（那笔钱没经过
-- 支付通道，且不可审计）。本文件每次只插**成对**的两行——一条 `status='paid'` 的订单 +
-- 一条指向它的账本行，形状与真链路落库的一致，`out_trade_no` 恒以 `FIXTURE-` 开头 ⇒
-- 后台一筛就看见、一句 DELETE 就撤干净。⚠️ 它插的是**判定输入**，不是判定结果：库里没有
-- `is_pro` 那种布尔位可涂（D-2＝读时折叠），这正是本文件存在的理由——想要"是会员"只能给账本。
--
-- 🔴 三条硬边界（跑之前读一遍）：
-- 1. **只对自测账号**。目标 openid 若已有非夹具的账本行，本文件**当场报错退出**，
--    不会碰真单一根毛（真单的 out_trade_no 不是 FIXTURE- 前缀）。
-- 2. 不产生任何支付事实：没有微信单号、没有钱。`goods_price` 填 1（＝¥0.01，只满足
--    `check (goods_price > 0)`），`wx_order_id` 留 null。别拿它做对账或营收统计（6.5 的口径
--    要按 out_trade_no 前缀把 FIXTURE 剔掉）。
-- 3. `v_env` 必须等于部署侧的 `PRO_ENV`（现网＝0）。填成 1 的话插进去的行**判定读不到**
--    （4.2 那条 env 隔离就是为"沙箱单不许发出真会员"设计的），症状是"跑了没效果"。
--
-- 幂等：按 FIXTURE- 前缀**先删后插** ⇒ 反复跑只会换成一新的覆盖窗口，不会叠成多档接龙。
-- 到期剩余天数想改成 20／7／1（验 3.6 那三个提示日）就改 `v_remaining_days` 重跑一次。
--
-- 用法：填好下面 DO 块开头的 v_email（或 v_user_id）与 v_ack，整份执行一次。
-- 🔴 填完**别把带值的文件提交回仓库**：`v_ack` 预填成确认串＝那道闸门形同不存在，
--    下一个人在账号 A 上跑过一次、下一个人顺手整体执行就会往账号 B 上插权益。
--    要留痕就留在 SQL Editor 的查询历史里（仓库这份恒是 REPLACE-ME 形状）。
-- ⚠️ Supabase 编辑器**只显示最后一条语句的结果**（B0 那轮的教训）⇒ 本文件的形状是
--    "DO 块 + 收尾一条证据 SELECT"，跑完看见的就是判定结果。失败一律走 RAISE EXCEPTION，
--    会以红色错误弹出来，不会被"没有结果集"糊过去。
-- ============================================================================

do $$
declare
  -- ▼▼▼ 只改这几行 ▼▼▼
  v_email          text        := 'REPLACE-ME@guest.invalid';  -- 自测账号邮箱（访客是 <id>@guest.invalid）
  v_user_id        uuid        := null;                        -- 或者填 uuid；填了就以它为准，v_email 忽略
  v_remaining_days integer     := 30;                          -- 想要的"还剩 N 天"；3.6 那三格填 20／7／1
  v_ack            text        := 'REPLACE-ME';                -- 确认串，必须逐字改成 FIXTURE-SELFTEST-ONLY
  -- ▲▲▲ 以下不用改 ▲▲▲

  v_openid    text;
  v_env       smallint := 0;      -- 必须等于 wrangler 的 PRO_ENV（现网 0）
  v_order_id  uuid;
  v_paid_at   timestamptz;
  v_duration  integer;
  v_otn       text;
  v_real_rows integer;
begin
  -- 闸门①：确认串。留成占位值＝没读过本文件顶部那三条边界，直接拒。
  if v_ack <> 'FIXTURE-SELFTEST-ONLY' then
    raise exception 'pro-fixture 未确认：把 v_ack 逐字改成 FIXTURE-SELFTEST-ONLY 再跑（这道闸挡的是"顺手跑一下就把会员插进一个真账号"）';
  end if;

  -- 闸门②：账号定位。给了 v_user_id 就用它，否则按 auth.users.email 找。
  if v_user_id is null then
    select id into v_user_id from auth.users where email = v_email;
  end if;
  if v_user_id is null then
    raise exception '找不到账号（v_email=% / v_user_id=%）：改其一再跑；候选清单见 pro-ops.sql 的 A9',
      v_email, coalesce(v_user_id::text, '(未填)');
  end if;

  -- 闸门③：这个账号必须**当前绑着**一条 wechat_mp identity。判定按 openid 锚（2.2），
  -- 没绑微信就没有 openid 可挂 ⇒ 插了也判不出来，与其静默无效不如当场说清。
  select openid into v_openid
  from public.user_identities
  where user_id = v_user_id and provider = 'wechat_mp'
  limit 1;
  if v_openid is null or v_openid = '' then
    raise exception '账号 % 没有 wechat_mp 绑定，取不到 openid ⇒ 会员判定按 openid 锚（正本 2.2），插了也判不出来。请用真机那个微信账号（pro-ops.sql A9 能列出来）', v_user_id;
  end if;

  -- 闸门④：这个 openid 上**已经有真单入账的覆盖**就退出——那是现网事实，不该被夹具干扰，
  -- 而且"删掉 FIXTURE 行之后还剩什么"会变成需要人记的东西。
  select count(*) into v_real_rows
  from public.pro_ledger
  where payer_openid = v_openid and provider = 'wechat_mp' and env = v_env
    and (order_id is null or order_id not in (
      select id from public.pro_orders where out_trade_no like 'FIXTURE-%'
    ));
  if v_real_rows > 0 then
    raise exception 'openid 尾 %… 上已有 % 条非夹具账本行（可能是真单），本文件拒绝在这种账号上跑，换一个干净的自测账号',
      right(v_openid, 6), v_real_rows;
  end if;

  -- 参数体检：remaining 是"到期当天算 0"的自然日差（4.3），今天生效 ⇒ duration = remaining + 1。
  if v_remaining_days < 0 or v_remaining_days > 3650 then
    raise exception 'v_remaining_days=% 不合理（0～3650）', v_remaining_days;
  end if;
  v_duration := v_remaining_days + 1;

  -- 先清本夹具先前留下的行（先账本后订单：账本用 order_id 指回订单）。
  delete from public.pro_ledger
  where order_id in (select id from public.pro_orders where out_trade_no like 'FIXTURE-%');
  delete from public.pro_orders where out_trade_no like 'FIXTURE-%';

  v_paid_at := now();
  -- 单号带账号尾号与时刻 ⇒ 一眼能看出是谁、哪一次跑的；前缀 FIXTURE- 是清理与剔除的抓手。
  v_otn := 'FIXTURE-' || substr(v_user_id::text, 1, 8) || '-' || to_char(now(), 'YYYYMMDDHH24MISS');

  insert into public.pro_orders (
    user_id, provider, payer_openid, platform, out_trade_no,
    product_id, goods_price, currency_type, env, buy_quantity,
    status, expires_at, paid_at, note
  ) values (
    v_user_id, 'wechat_mp', v_openid, 'unknown', v_otn,
    'pro_fixture', 1, 'CNY', v_env, 1,
    'paid', v_paid_at + interval '15 minutes', v_paid_at,
    'B2-2 真机夹具（非支付事实）：验账户页会员位与关态不画余量行。撤除＝删 out_trade_no=' || quote_literal(v_otn)
  )
  returning id into v_order_id;

  insert into public.pro_ledger (
    provider, payer_openid, order_id, buyer_user_id, env, effective_at, duration_days
  ) values (
    'wechat_mp', v_openid, v_order_id, v_user_id, v_env, v_paid_at, v_duration
  );

  raise notice 'pro-fixture 已插：user=% openid=…% 目标剩余 % 天（duration=%）单号 %',
    v_user_id, right(v_openid, 6), v_remaining_days, v_duration, v_otn;
end $$;


-- ── 证据（编辑器里唯一看得见的那一条）：库里折叠算出来的三样 ──────────────
-- 期望：is_covered=true、remaining_days 等于你填的数、valid_until 是北京 23:59:59 那一秒。
-- 🔴 这一条同时是 SQL 侧 `(f()).col` 形状可用的旁证；而 PostgREST 的 HTTP 回包形状**已结案**
--    （2026-10-04 真机 tail 到的是单个对象 ⇒ 见正本 R-9 ⑯ 与 proCoverage.js 那段注释）。
select
  (pro_coverage('wechat_mp', i.openid, 0, now())).is_covered    as "是否覆盖",
  (pro_coverage('wechat_mp', i.openid, 0, now())).valid_until   as "到期时刻（展示口径）",
  (pro_coverage('wechat_mp', i.openid, 0, now())).remaining_days as "剩余自然日",
  i.user_id                                                     as "账号",
  right(i.openid, 6) || '…'                                     as "openid 尾",
  o.out_trade_no                                                as "夹具单号",
  l.effective_at                                                as "生效时刻",
  l.duration_days                                               as "档期天数"
from public.user_identities i
join public.pro_ledger l on l.payer_openid = i.openid and l.provider = i.provider
join public.pro_orders o on o.id = l.order_id
where i.provider = 'wechat_mp'
  and o.out_trade_no like 'FIXTURE-%'
order by l.effective_at desc
limit 5;


-- ── 撤除（#61 第⑤步：整段选中执行一次）────────────────────────────────────
-- 只删 FIXTURE- 前缀的订单与指向它们的账本行 ⇒ 真单（`out_trade_no` 不带这个前缀）一根毛都不碰。
-- 撤完再跑一次上面那条证据 SELECT：应当返回 **0 行**——空结果就是"已清空"的判据。
--   delete from public.pro_ledger
--    where order_id in (select id from public.pro_orders where out_trade_no like 'FIXTURE-%');
--   delete from public.pro_orders where out_trade_no like 'FIXTURE-%';
-- ⚠️ 撤完之后端上不会立刻变：`pullPro` 只挂在会话落定点上 ⇒ 要**冷启动**（杀掉小程序重进）
--    才会看到账户页那一块消失（8.1 那条边界）。
