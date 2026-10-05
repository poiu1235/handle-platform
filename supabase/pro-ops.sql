-- ============================================================================
-- pro-ops.sql · Handle 会员体系运维查询与人工解绑模板
-- 设计文档：account-membership-prd-v3.md 6.5／8.2 #12／6.1／4.8／D-9／D-10
--
-- 先说清"告警"这个词的现行形态（6.5 第二十一轮口径清理）：V1 **没有推送型告警**——
-- 不新开调度器（lazy settlement 定案、V2 cron-worker 收编线），所以本文件的定位是
-- "每 1–2 天坐下集中执行退款时，顺手扫一遍的固定五段"。
-- 🔴 这五段必须预先写好、不要到时候现写：在只有一个人的运维里，"到时候现写"等于没有。
--
-- 节奏：A1–A5 与集中执行退款是**同一个动作**；A6–A8 上线后每周一遍。
-- 🔴 用法：**逐段选中执行**。这个文件是多条语句的脚本，整体执行时你只会看到其中一份
--   结果（具体哪一份取决于编辑器），所以它是"查询库"，不是一键体检。
-- 本文件全部只读。人工解绑模板在 pro-manual-unbind.sql（它会删行，刻意不放在这里）。
--
-- ⚠ 读法：所有金额列都是**分**（goods_price 单位＝分，PRD 4.2），下面已除 100 显示为元。
-- ⚠ env：0＝现网、1＝沙箱。自测/沙箱单与真实单**永远分开看**，这就是 4.2 那列存在的理由。
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- A1 待处理退款申请（按申请时刻排队；管理员去支付后台执行的就是这一列）
--    窗口以 requested_at 判（6.1 退款资格②），不是执行时刻 ⇒ 排得越久越可能超平台可退期。
-- ────────────────────────────────────────────────────────────────────────────
select rr.id                                             as 申请id,
       rr.order_id                                       as 订单id,
       o.out_trade_no                                    as 我方单号,
       o.product_id                                      as 道具,
       round(o.goods_price / 100.0, 2)                   as 金额_元,
       rr.kind                                           as 类型,
       rr.requested_at                                   as 申请时刻,
       now() - rr.requested_at                           as 已等待,
       o.paid_at                                         as 付款时刻,
       (o.paid_at is not null and rr.requested_at - o.paid_at <= interval '7 days') as 在申请时刻仍在7天窗口,
       o."operator"                                      as 订单侧留痕人,
       rr.note                                           as 申请备注
from public.pro_refund_requests rr
join public.pro_orders o on o.id = rr.order_id
where rr.status = 'pending'
order by rr.requested_at;


-- ────────────────────────────────────────────────────────────────────────────
-- A2 退款申请 pending > 3 天（6.1 退款执行⑤那条"防遗漏"，V1 形态＝这一行有没有人看见）
-- ────────────────────────────────────────────────────────────────────────────
select count(*)                                          as 超期未执行条数,
       min(rr.requested_at)                              as 最久一条的申请时刻,
       coalesce(string_agg(o.out_trade_no, ', ' order by rr.requested_at), '（无）') as 单号
from public.pro_refund_requests rr
join public.pro_orders o on o.id = rr.order_id
where rr.status = 'pending'
  and rr.requested_at < now() - interval '3 days';


-- ────────────────────────────────────────────────────────────────────────────
-- A3 异常单回访（anomaly／orphan 都要人看一眼：4.5 第 7 步"anomaly 必须有出边"）
--    ⚠ anomaly_reason 里 amount_mismatch／appid_mismatch／env_mismatch 是**死分支**
--      （R-9 证实推送带那些字段之前打不到），所以这一列只可能出现五个值（验收 #49）。
-- ────────────────────────────────────────────────────────────────────────────
select o.out_trade_no          as 我方单号,
       o.status                as 状态,
       o.anomaly_reason        as 原因,
       o.product_id            as 道具,
       o.payer_openid          as 付款微信,
       o.env                   as 环境,
       o.created_at            as 下单时刻,
       o.paid_at               as 付款时刻,
       o."operator"            as 处理人,
       o.note                  as 处理说明
from public.pro_orders o
where o.status = 'anomaly'
   or o.anomaly_reason = 'orphan'
order by o.created_at desc;


-- ────────────────────────────────────────────────────────────────────────────
-- A4 未决单：pending 已过 expires_at（15 分钟）；🔴 再分清"是否已超 24 小时"
--    超 24 小时的单**进站查单那一层也不再兜**（6.4 第②层的条件是 24 小时内的 pending），
--    它是真·没人管的钱，必须人看一眼。
-- ────────────────────────────────────────────────────────────────────────────
select o.out_trade_no   as 我方单号,
       o.payer_openid   as 付款微信,
       o.product_id     as 道具,
       o.env            as 环境,
       o.created_at     as 下单时刻,
       o.expires_at     as 单有效期到,
       o.created_at < now() - interval '24 hours' as 进站查单已不再兜,
       o.attach         as 透传串
from public.pro_orders o
where o.status = 'pending'
  and o.expires_at < now()
order by o.created_at;


-- ────────────────────────────────────────────────────────────────────────────
-- A5 本月收款额：按 env 与"是否测试道具"分列（D-10 后果③：测试单要单列，别混进 GMV）
--    ⚠ 这只是**我方近似**：月收款 10 万那道限额是平台口径（平台自己的月界与结算规则），
--      真撞上限只能看后台——我方库里没有平台侧聚合。这条查询的作用是"看见趋势"。
--    ⚠ 'pro_test_day' 在这里是硬编码：✅ E-8 已判＝商品配置**不建表**，唯一来源是 CF 侧的
--      模块常量（B3 的 functions/_lib/proCatalog.js）⇒ 改测试道具 id 要同步两处（那处常量＋这一行）。
--      它不进 GET products，也不该混进真实 GMV。
-- ────────────────────────────────────────────────────────────────────────────
select date_trunc('month', o.paid_at at time zone 'Asia/Shanghai') as 北京月,
       o.env                                                      as 环境,
       (o.product_id = 'pro_test_day')                            as 测试道具,
       count(*)                                                   as 笔数,
       round(sum(o.goods_price) / 100.0, 2)                       as 金额_元,
       round(sum(case when o.status = 'refunded' then o.goods_price else 0 end) / 100.0, 2) as 其中已退款_元
from public.pro_orders o
where o.status in ('paid', 'refunded')
  and o.paid_at is not null
group by 1, 2, 3
order by 1 desc, 2, 3;


-- ────────────────────────────────────────────────────────────────────────────
-- A6 外部退款行对账（kind='external'：Apple／投诉／管理员直接在支付后台退，都不经我方申请表）
--    🔴 反向判据：这笔钱退了而会员还在＝验收 #41 不通过；这一列是"确实回流过"的证据面。
-- ────────────────────────────────────────────────────────────────────────────
select o.out_trade_no   as 我方单号,
       rr.requested_at  as 推送置done时刻,
       rr.executed_at   as 执行时刻,
       rr."operator"    as 记为,
       rr.note          as 推送原文摘要,
       o.payer_openid   as 付款微信,
       (select count(*) from public.pro_ledger l
         where l.order_id = o.id and l.revoked_at is null) as 该单仍生效的账本行数
from public.pro_refund_requests rr
join public.pro_orders o on o.id = rr.order_id
where rr.kind = 'external'
order by rr.requested_at desc;
-- 🔴 最后那一列必须是 0。非 0 ＝ 撤账事务没跑成（4.5 触发表），这就是"退了钱会员还在"。


-- ────────────────────────────────────────────────────────────────────────────
-- A7 上线后第一个要看的指标（6.1 末行／D-15）：当前存量已超**免费**上限的账号数
--    状态量，一条查询随时可跑 ⇒ 🔴 不为"撞过多少次墙"那种事件量开表（409 不落库，
--    见 functions/api/notes.js:92-94；第二十一轮"补"那条的结论就是按状态量取数）。
--    ⚠ 便利贴计数口径＝**物理全部行**：汇聚未做 ⇒ 没有 folded_at 列，现网就是全行计数
--      （3.4 现行口径）。僵尸行在撞墙那一刻占额度是已知后果（3.3），不是这条查询的 bug。
--    ⚠ 这一遍同时是 3.3 门槛④要求"上线前数一遍存量"的工具：D-5 已判不预告直接上线，
--      剩下的伤害面就是自测与 seed-notes-demo 灌出来的演示数据（>200 当场变能看不能记）。
-- ────────────────────────────────────────────────────────────────────────────
select '便利贴' as 页面, 200 as 免费上限, count(*) as 超限账号数,
       coalesce(max(n.cnt), 0) as 最大存量, coalesce(round(avg(n.cnt)::numeric)::text, '—') as 平均存量
from (select user_id, count(*) as cnt from public.notes group by user_id) n
where n.cnt >= 200

union all
select '余额', 50, count(*), coalesce(max(b.cnt), 0), coalesce(round(avg(b.cnt)::numeric)::text, '—')
from (select user_id, count(*) as cnt from public.balances group by user_id) b
where b.cnt >= 50

union all
select '会员卡', 50, count(*), coalesce(max(c.cnt), 0), coalesce(round(avg(c.cnt)::numeric)::text, '—')
from (select user_id, count(*) as cnt from public.cards group by user_id) c
where c.cnt >= 50;


-- ────────────────────────────────────────────────────────────────────────────
-- A8 "到期后会不会回来续购"的两个粗指标（6.1 末行登记的那件待验证的事）
--    🔴 这里刻意**不自己算折叠**：验收 #39 判的就是"全仓不得出现第二处折叠／接龙计算"，
--      运维文件也算一处。⇒ 精确的"到期后 30 天续购率"等 B1 把 pro_coverage 的读法接进 CF
--      之后由同一个函数出数；V1 先看这两个不需要折叠的形状：
--      ① 曾经付过款、但名下再没有任何未撤销账本行的主体数（流失面）
--      ② 同一付款微信出现 2 笔及以上已付单的主体数（回购面）
-- ────────────────────────────────────────────────────────────────────────────
select '① 曾有权益、现无任何未撤销账本行的付款微信' as 指标,
       count(distinct o.payer_openid)::text          as 值
from public.pro_orders o
where o.status in ('paid', 'refunded')
  and not exists (select 1 from public.pro_ledger l
                   where l.payer_openid = o.payer_openid and l.revoked_at is null)

union all
select '② 已付单 ≥2 笔的付款微信（回购）', count(*)::text
from (select o.payer_openid, count(*) as n
      from public.pro_orders o
      where o.status in ('paid', 'refunded')
      group by o.payer_openid
      having count(*) >= 2) t;


-- ────────────────────────────────────────────────────────────────────────────
-- A9 夹具候选账号（pro-fixture.sql 靠这一条挑目标；B2-2 真机两格要用）
--    一行一个"绑着微信的账号"：有没有账本行、其中是不是已经有真单、此刻判出什么。
--    🔴 只挑 fixture_ok='OK 可插' 的那几行——'已有真单 夹具会拒' 那些是现网事实，别拿它当测试面。
--    访客账号的邮箱形如 <id>@guest.invalid（端上 src/api/env.ts 的 GUEST_EMAIL_SUFFIX）。
--    ⚠️ env 这里写死 0＝与 wrangler 的 PRO_ENV 同值；填 1 看到的是判定**读不到**的那批行（4.2 的隔离）。
--    ⚠️ 这条与夹具的"非夹具行"定义逐字同口径（order_id 为 null 也算真单），两处不一致就会
--       出现"A9 说可插、夹具却拒"。
-- ────────────────────────────────────────────────────────────────────────────
select
  i.user_id,
  u.email                                                      as "邮箱",
  right(i.openid, 6) || '…'                                    as "openid 尾",
  (select count(*)
     from public.pro_ledger l
    where l.provider = i.provider and l.payer_openid = i.openid and l.env = 0) as "账本行数",
  (pro_coverage(i.provider, i.openid, 0, now())).is_covered     as "覆盖中",
  (pro_coverage(i.provider, i.openid, 0, now())).remaining_days as "剩余自然日",
  case when not exists (
         select 1 from public.pro_ledger l
          where l.provider = i.provider and l.payer_openid = i.openid and l.env = 0
            and (l.order_id is null
                 or l.order_id not in (select id from public.pro_orders
                                        where out_trade_no like 'FIXTURE-%')))
       then 'OK 可插' else '已有真单 夹具会拒' end                as "fixture_ok"
from public.user_identities i
left join auth.users u on u.id = i.user_id
where i.provider = 'wechat_mp'
order by "账本行数" desc, "邮箱";


-- ────────────────────────────────────────────────────────────────────────────
-- A10 客服反查：用户／后台报来的**任一个号**都要能定位到那一行
--    🔴 三个号语义不同、别混（2026-10-05 一手回包，正本附录甲）：
--      `out_trade_no`＝我方单号（T…）／`wx_order_id`＝平台侧订单号（VPO…，**未付就有**）／
--      `wxpay_order_id`＝微信支付交易单号（4500…，＝后台「交易订单」那一列"交易单号"，付款之后才有）。
--    E-23 判甲之前只有第一个能查 ⇒ 用户报"交易单号"时只能翻后台截图。
--    ⚠️ 把 REPLACE-ME 换成手里那一个号（任一个都行）；🔴 别把真实单号提交回这份文件。
--    ⚠️ 这一列从本次部署起才有值 ⇒ 历史已付单可能是 null，那不代表"没这笔钱"，去后台看那一屏。
-- ────────────────────────────────────────────────────────────────────────────
select
  o.out_trade_no                                               as "我方单号",
  o.status                                                     as "我方状态",
  o.payer_openid                                               as "付款微信 openid",
  o.product_id, o.goods_price                                  as "单价(分)",
  o.paid_at, o.expires_at, o.wx_order_id, o.wxpay_order_id,
  o.is_duplicate, o.paid_after_close, o.anomaly_reason, o."operator", o.note,
  (select l.duration_days from public.pro_ledger l where l.order_id = o.id limit 1)          as "天数(账本行)",
  (select count(*) from public.pro_ledger l where l.order_id = o.id)                          as "账本行数",
  (select count(*) from public.pro_ledger l where l.order_id = o.id and l.revoked_at is not null) as "未撤销账本行"
from (
  select x.id, x.out_trade_no, x.status, x.payer_openid, x.product_id, x.goods_price, x.paid_at, x.expires_at,
         x.wx_order_id, x.wxpay_order_id, x.is_duplicate, x.paid_after_close, x.anomaly_reason, x."operator", x.note
    from public.pro_orders x
   where x.out_trade_no = 'REPLACE-ME' or x.wx_order_id = 'REPLACE-ME' or x.wxpay_order_id = 'REPLACE-ME'
) o
order by o.paid_at desc nulls last;


-- ────────────────────────────────────────────────────────────────────────────
-- B. 人工解绑（会删行）——不在这份文件里
--    模板见同目录 pro-manual-unbind.sql：它带两道门（v_who 必填／v_note 必填；openid 自 S-7
--    起由 identity_unbinds.openid 列本身承载，不用抄进 note），
--    核实判据是 7.6 末节那句"客服会话 openid ＝ 订单 payer_openid"（⏸ R-9 ⑭）。
--    为什么值得单独成文件：这份 A1–A10 是"每 1–2 天坐下扫一遍"的只读库，
--    而解绑是**一次一个账号、要先把四个值改对**的动作，两者混在一份脚本里迟早出事。
-- ────────────────────────────────────────────────────────────────────────────


-- ────────────────────────────────────────────────────────────────────────────
-- C. 4.8 要求的"会改变 user_identities 的路径清点"（上线前做一次，逐条问：写没写流水）
-- 🔴 人工解绑模板已移到 **pro-manual-unbind.sql**（它会删 user_identities 的行，
--   不放在这份只读巡检库里，避免"顺手整体执行"造成解绑）。


-- ────────────────────────────────────────────────────────────────────────────
-- C. 4.8 要求的"会改变 user_identities 的路径清点"（上线前做一次，逐条问：写没写流水）
--
-- | 路径                                   | 对 identity 做什么          | 写流水？                                   |
-- | -------------------------------------- | --------------------------- | ------------------------------------------ |
-- | functions/auth/wechat-bind.js          | 插入绑定                    | 不需要（绑不是解绑；上限计数看 merges+unbinds） |
-- | functions/auth/identity-unbind.js      | 删行（自助解绑）            | ✅ 写 identity_unbinds（:79-80）            |
-- | auth/guest-upgrade-confirm.js          | merge_guest 整行搬到目标    | ✅ 写 account_merges（"合并即绑"，计入上限） |
-- | 注销（delete-account.js / D5 冷静期）   | cascade 删 identity         | 流水一并 cascade（有意：对已死账号做 churn 判定无意义，见 d5-unbind-churn.sql:9-10） |
-- | Supabase Dashboard 手工删行            | 只删行                      | 🔴 **不写** ⇒ 必须走 pro-manual-unbind.sql 的模板 |
-- | 管理端改绑                             | ——                          | ❌ 不存在这样的端点，且 7.6 铁律**永不允许**改锚／手工发权益 |
--
-- ⇒ 已知缺口只有"Dashboard 手工删"这一条，pro-manual-unbind.sql 就是它的答案（owner 判 ⓐ 补记流水）。
-- ────────────────────────────────────────────────────────────────────────────
