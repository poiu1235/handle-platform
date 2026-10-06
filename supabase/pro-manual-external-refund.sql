-- pro-manual-external-refund.sql —— 人工登记一行"外部发起的退款"（`pro_refund_requests`，`kind='external'`）
--
-- 为什么要有这个文件：✅ E-30 判甲（owner 2026-10-05）定了接收器**不写这张表**——
--   `xpay_refund_notify` 只做三件事：撤账本行、把订单标 `refunded`、把回执号写进 `pro_orders.note`。
--   代价写在正本 6.1：🔴 **钱与申请行之间没有自动留痕**，所以"有多少人走过外部退款"这个数
--   在库里本来是空的。owner 2026-10-06 判："登记一行吧，区别开来"⇒ 本文件就是那条登记通道。
--
-- 为什么单独一个文件而不是并进 `pro-ops.sql`：那张是**只读**巡检，这一段会写行——
--   与 `pro-manual-unbind.sql` 同一个理由（"顺手整体执行"就会凭空多出一行 done）。
--   所以这里配了一道确认串（`v_ack`），形状照 `pro-fixture.sql`。
--
-- 与 4.6"CF 侧写这三张表的模块只有一个"的关系：那条约束管的是**代码**（防五个入口各写一份幂等）；
--   这一条是**人工**通道，是 E-30 判甲后已知的那个缺口的补法，不是第六个入口。
--   🔴 但它同样不许出现在代码里：任何端点想创建 `external` 行，都等于把"手工发一行记录"
--   接回自动链路，那正是 E-30 撤掉的形状。
--
-- ⚠️ 现网 CHECK 是否生效由 `pro-billing-schema-check.sql` 第 14 项判（E-29 的两条约束在 DDL 与
--   增量迁移里，迁移没跑就只有本文件的参数校验在挡）。两道都在，才是纵深。
--
-- 用法：逐字改 ▼▼▼ 那 5 行，整体执行一次，最后那一条 SELECT 是回读证据（Supabase 编辑器
--   只显示最后一条语句的结果 ⇒ 本脚本刻意写成"一个 DO 块 ＋ 一条 SELECT"）。

do $$
declare
  -- ▼▼▼ 只改这几行 ▼▼▼
  v_ack          text := 'REPLACE-ME';            -- 必须逐字改成 REGISTER-EXTERNAL-REFUND，否则下面直接停住
  v_lookup       text := 'REPLACE-ME';            -- 我方单号／平台单号（VPO…）／微信支付交易单号（4500…）任填一个
  v_refund_id    text := 'REPLACE-ME';            -- 后台那一笔退款的回执号（VPR…）；🔴 没有它就不许登记成 done
  v_operator     text := 'REPLACE-ME';            -- 谁登记的（追责用，写人名/账号，不写 platform）
  v_note         text := 'REPLACE-ME';            -- 怎么核实的：后台哪一屏看到的、退款时刻、部分退还是全额退
  -- ▲▲▲ 以下不用改 ▲▲▲

  v_order_id     uuid;
  v_order_no     text;
  v_matched      integer;
  v_existing     uuid;
begin
  if v_ack <> 'REGISTER-EXTERNAL-REFUND' then
    raise exception '确认串没改（v_ack 要逐字改成 REGISTER-EXTERNAL-REFUND）——这一行会写进 pro_refund_requests，是 A6 对账口径的输入';
  end if;

  -- 🔴 五个参数都不许是占位符或空白。校验写在代码里而不是靠库侧 CHECK，是因为 CHECK 抛的 23514
  --   读不出"到底哪一样没填"，而这一条是人工执行的：报错要能直接指出该改哪一行。
  if btrim(v_lookup) = '' or v_lookup like 'REPLACE-ME%'
     or btrim(v_refund_id) = '' or v_refund_id like 'REPLACE-ME%'
     or btrim(v_operator) = '' or v_operator like 'REPLACE-ME%'
     or btrim(v_note) = '' or v_note like 'REPLACE-ME%' then
    raise exception '五个参数都要真值（v_ack／v_lookup／v_refund_id／v_operator／v_note）——缺任一样就不登记';
  end if;

  -- 定位那一笔订单：三个号任填一个都能命中（与 `pro-ops.sql` A10 同一条口径）。
  -- 🔴 命中 0 行要停，命中 >1 行也要停——号有歧义时猜一个就是给别人的钱补一行记录。
  -- ⚠️ 这里分两条查询而不是 `select count(*), min(id) …`：PG **没有 `min(uuid)` 这个聚合**
  --   （42883，PGlite 上跑出来的——写这条时以为 uuid 有 btree 就能 min，事实是不能）。
  select count(*)::int into v_matched
  from public.pro_orders o
  where o.out_trade_no = v_lookup
     or (o.wx_order_id is not null and o.wx_order_id = v_lookup)
     or (o.wxpay_order_id is not null and o.wxpay_order_id = v_lookup);

  select o.id, o.out_trade_no into v_order_id, v_order_no
  from public.pro_orders o
  where o.out_trade_no = v_lookup
     or (o.wx_order_id is not null and o.wx_order_id = v_lookup)
     or (o.wxpay_order_id is not null and o.wxpay_order_id = v_lookup)
  limit 1;

  if v_matched = 0 then
    raise exception '库里查不到这个号：%；先跑 pro-ops.sql 的 A10 确认号抄对了没有', v_lookup;
  end if;
  if v_matched > 1 then
    raise exception '这个号命中 % 行，有歧义 ⇒ 停住不登记（换成 out_trade_no 再跑一次）', v_matched;
  end if;

  -- 🔴 这一单上已经有 pending／done 的申请行 ⇒ **停住，不插也不改**。
  --   为什么连"顺手把 kind 改成 external"都不许：那一行很可能是**用户自己点出来的**
  --   （`no_reason`／`duplicate`），而 3.x 的"每个付款微信一次"额度判据数的正是这些行的 kind 与状态
  --   ⇒ 覆盖 kind 会把他用掉的那次额度**悄悄还回去**，还能让 A1/A2/A6 三个口径的分母同时变形。
  --   外部退款与用户申请撞在同一单上时，收尾通道本来就有两条，都不在这里：
  --     · 管理员在 `/admin/pro-refunds` 标 `done`（必填 `wx_refund_id`＋operator＋note）；
  --     · 后台直退时 `xpay_refund_notify` 到达，接收器按 E-36 判甲**关掉那条 pending 行**并回填回执号。
  --   同一 order_id 上 pending／done 合计只许一行（partial unique `pro_refund_requests_order_active_uk`），
  --   所以"已经有一行"这件事在这里是**可读的**，不靠撞约束才发现。
  select r.id into v_existing
  from public.pro_refund_requests r
  where r.order_id = v_order_id and r.status in ('pending', 'done')
  limit 1;

  if v_existing is not null then
    raise exception '这一单（%）已经有一条申请行（id %）⇒ 停住不登记。那是用户自己申请的那一笔，'
      '改它的 kind 会动到"每微信一次"的额度分母；要收尾请走 /admin/pro-refunds 或等退款回流自动关行',
      v_order_no, v_existing;
  end if;

  -- 无既有行才插：requested_at 用的是**登记时刻**——这一条没有真实的"用户申请时刻"（人没申请，
  -- 钱是外部退的）。⚠️ 所以 A2 那句"pending 超 3 天"对它无意义（一进来就是 done），
  --   而 7 天窗口判定本来就不看 external 这一类（资格判据只算 no_reason）。
  insert into public.pro_refund_requests (
    order_id, kind, status, requested_at, executed_at, wx_refund_id, "operator", note
  ) values (
    v_order_id, 'external', 'done', now(), now(), v_refund_id, v_operator,
    '人工补登（pro-manual-external-refund.sql）：' || v_note || '｜登记人 ' || v_operator
  );
  raise notice '登记完成：inserted 一行 external／done｜单号 %｜回执 %', v_order_no, v_refund_id;
end
$$;

-- 回读证据（最后一条语句＝编辑器里唯一看得见的那一份）：这一单现在到底有几行、什么状态。
-- ⚠️ 下面那个号要再填一次（DO 块里的变量出不了那个块，这是刻意的——不留"隐式复用"的假象）。
-- 🔴 期望：恰好 1 行、kind='external'、status='done'、wx_refund_id 与 operator 与 note 都非空。
--   出现 2 行＝上面那条防重没生效（partial unique `pro_refund_requests_order_active_uk` 没建上？
--   跑 `pro-billing-schema-check.sql` 第 08／14 项）。
select o.out_trade_no                            as 我方单号,
       o.status                                  as 订单状态,
       o.paid_at                                 as 付款时刻,
       r.kind                                    as 类型,
       r.status                                  as 申请状态,
       r.wx_refund_id                            as 回执号,
       r."operator"                              as 登记人,
       r.requested_at                            as 登记时刻,
       r.executed_at                             as 执行时刻,
       coalesce(r.note, '') <> ''                as 留痕非空,
       count(r.id) over (partition by o.id)      as 这一单的申请行数
from public.pro_orders o
left join public.pro_refund_requests r on r.order_id = o.id
where o.out_trade_no = 'REPLACE-ME'              -- ▼ 把 v_lookup 里那个我方单号（out_trade_no）填这儿
order by r.requested_at desc nulls last
limit 10;
