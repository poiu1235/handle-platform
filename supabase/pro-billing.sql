-- ============================================================================
-- pro-billing.sql · Handle 会员体系数据面（三表 + 一个判定函数 + 一笔连带迁移）
-- 设计文档：handle-miniprogram/doc/account-membership-prd-v3.md 第四章
--          （4.2 三表／4.3 判定规则／4.6 权限面／4.8 迁移落点）
-- 配套核对文件：pro-billing-schema-check.sql（结构）、pro-coverage-check.sql（行为）
--
-- 三条形状要点是 owner 判过的，不是实现者偏好，改之前先读：
--   1. 三表**都不建外键**。权益属于"付款微信"，账号只是此刻绑着它的人（2.1 公理）：
--      账本建 cascade 等于把"注销销毁权益"写进库（N-1），订单则要活得比账号久
--      （merge_guest 末尾会 delete from auth.users ⇒ 订单 user_id 必然悬空，只作留痕）。
--      ⚠ 这与仓库既有表**故意相反**：identity_unbinds 用 cascade 只因它服务 churn 计数。
--   2. 开 RLS 而**不建任何 policy** + 只 service_role（照抄 user-identities.sql 的安全形状）。
--      订单页也不开行级 policy：行级策略拦不住列（payer_openid／callback_raw 会被一并读到）。
--   3. 账本**不落 valid_from／valid_until**（D-2＝ⓐ 读时折叠）。绝对区间由 pro_coverage()
--      算出来，库里只有 effective_at + duration_days 两个事实列 ⇒ 不存在"某条路径忘了重算"。
--      🔴 全文出现的 valid_until 一律指那个函数的返回值，**不是列名**。
--
-- 在 Supabase SQL Editor 整体执行一次；幂等可重跑。
-- 🔴 会弹「Potential issue detected: This query creates a table without enabling Row Level
--    Security ... may be able to access `if`」⇒ **一律选 "Run without RLS"**。
--    那个 `if` 就是证据：编辑器的 RLS 建议把 `create table if not exists public.pro_orders`
--    的表名读成了 `if`。选 "Run and enable RLS" 会替这张**不存在的表**补一句
--    `alter table if enable row level security` ⇒ 当场 42P01 relation "if" does not exist
--    （2026-10-04 实测踩过）。而且"帮你开 RLS"本来就是多余且落错对象的：本文件第 4 节
--    已经自己 enable row level security，并**刻意不建任何 policy**（4.6 的安全形状）。
-- ⚠ 幂等的边界：`create table if not exists` 重跑**不会**补上后来新增的列或约束。
--   本文件改了表结构后：自测库 drop 重建，现网另写增量文件——不能指望重跑生效。
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 0. 连带迁移：identity_unbinds 补 operator／note 两列（D-9／D-9a）
--    为什么算会员体系的依赖：锚点改到 openid 上之后，"解绑"就是搬权益的入口，
--    而客服在 Dashboard 手工删 user_identities 行时**不经过** identity-unbind.js
--    ⇒ 既不写流水、也不被 30 天 3 次的计数看见（D-9 的根）。owner 判 ⓐ：补记流水，
--    但 D-9a 判"不占用户额度" ⇒ 计数处要按 operator is null 过滤，人工那次必须写 note。
--    ⇒ 这两列今天**不存在**（d5-unbind-churn.sql:15-20 只有 id/user_id/provider/unbound_at），
--      所以 add column 必须在 identity-unbind.js 加过滤之前先落。
--    流水只在后台可见：不进账户页绑定历史、不进订单页（owner 明确"人工触发、异步处理"）。
-- ---------------------------------------------------------------------------

-- 前置：本假设 d5-unbind-churn.sql 已执行（identity_unbinds 存在）。缺那张表这一节会直接报错，
--   那是"环境不对"，不是本文件的 bug——不要去吞它。
alter table public.identity_unbinds add column if not exists "operator" text;
alter table public.identity_unbinds add column if not exists note      text;
-- ✅ S-7 已判＝加列（owner 2026-10-04）：这张表原本只有 (user_id, provider, unbound_at)，
--   解绑＝物理删行 ⇒ "哪天解掉了哪个微信"在库里查不到（自助路径同样不记）。而新模型下
--   解绑就是搬权益的入口，取证必须有这一列，不能全靠 note 里抄一句。
--   🔴 连带一条 B1 代码改动：identity-unbind.js 的自助 insert 现在只写 (user_id, provider)
--      ⇒ 必须把删掉那行的 openid 一并写进来，否则新列对自助路径永远是 null（列白加）。
alter table public.identity_unbinds add column if not exists openid    text;

-- 🔴 把 D-9a 那句"人工那次必须写 note"下沉成库约束（验收 #34 要的"note 为空应被拒"）。
-- 自助路径写进来的行 operator 恒为 null ⇒ 不受这条影响；只有人工补记才被要求填 note。
-- ⚠ 这条约束抓得住"写了流水但没写理由"，**抓不住"根本没写流水就删了行"**——后者只能靠
--   pro-ops.sql 的模板与 4.8 要求的路径清点（多路径状态位优先从事实派生，这里派生不出来）。
-- ⚠ 标识符全部加双引号：`operator` 在 PG 关键字表里，我没有一手确认过它的分档
--   （reserved / non-reserved / "可作函数或类型名"），而"拿一个未验证的写法去赌解析"
--   正是 balances-schema-check.sql:26-27 记过的那类栽法。加引号两种情况下都能解析。
--   ⇒ 连带给 B1 的口径：SQL 片段里写 "operator"，PostgREST 查询串里写 operator=is.null
--     （query 参数是列名字符串，不涉及解析）。
alter table public.identity_unbinds drop constraint if exists identity_unbinds_manual_note_required;
alter table public.identity_unbinds
  add constraint identity_unbinds_manual_note_required
  check ("operator" is null or char_length(btrim(coalesce(note, ''))) > 0);

-- 🔴 同向第二道：人工那行必须带 openid——取证的对象正是"被搬走的那把门钥匙"。
--   这条只约束 operator 非空的人工行 ⇒ 历史行（operator 为 null、openid 也为 null）不受影响，
--   所以能今天就落，不会被既有数据卡住迁移。
alter table public.identity_unbinds drop constraint if exists identity_unbinds_manual_openid_required;
alter table public.identity_unbinds
  add constraint identity_unbinds_manual_openid_required
  check ("operator" is null or openid is not null);

comment on column public.identity_unbinds."operator" is
  '人工解绑的执行者；非空即"客服在后台删的行"，不计入用户自己的 30 天额度（D-9a）';
comment on column public.identity_unbinds.note is
  '人工解绑必填：用户主张是什么 + 我们怎么核实的（人工通道不受上限约束，note 是唯一限速依据）';
comment on column public.identity_unbinds.openid is
  '被解绑的那个 openid（S-7 加列）。人工行必须带；自助行由 identity-unbind.js 在 B1 补写——删行之后库里就只剩这里还留着openid';


-- ---------------------------------------------------------------------------
-- 1. pro_orders —— 一笔下单一行，记"钱"
-- ---------------------------------------------------------------------------

create table if not exists public.pro_orders (
  id               uuid primary key default gen_random_uuid(),

  -- 🔴 下单时的账号，只作留痕与客服检索，**不参与**"谁能看／谁能退"的判定（4.7）。
  --    值由服务端从会话取，绝不信客户端传值。不建 FK：钱要活得比账号久。
  user_id          uuid        not null,

  -- 来源锚点＝openid 本体（解绑＝删行、重绑同微信＝新 uuid ⇒ 锚在行主键上，
  -- 最正常的恢复路径会永远走不通）。V1 购买必填、与账本同形。
  provider         text        not null check (provider = 'wechat_mp'),
  payer_openid     text        not null,

  -- ✅ D-12：开放平台已绑定 ⇒ 可填真值。🔴 永不参与权益判定（判定只认 openid），
  --   它只是将来"按 unionid 改写账本主体"那次一次性作业的对账线索。
  payer_unionid    text,

  -- 留痕与统计。🔴 来源＝端上上报 ⇒ 用户可伪造 ⇒ 绝不允许进入任何判定或写判据
  -- （D-11 若落"按渠道分退款"，必须先有可信来源＝R-9 ⑬）。
  platform         text        not null default 'unknown'
                              check (platform in ('android', 'ios', 'unknown')),

  -- 幂等键①：我方单号（官方 outTradeNo，8–32 位、不以 _ 开头、不可复用）
  out_trade_no     text        not null unique,

  -- 幂等键②：微信侧单号。⚠ 官方推送只列 MchOrderNo（＝商户单号＝我们的 out_trade_no），
  -- 所以这一列很可能要由 /pay/query 回填而非取自推送＝⏸ R-9 ③。
  -- 别叫 transaction_id，那是普通微信支付商户体系的名。
  wx_order_id      text,

  product_id       text        not null,
  goods_price      integer     not null check (goods_price > 0),  -- 单位＝分（官方 goodsPrice 就是分，零换算）
  currency_type    text        not null default 'CNY',            -- 与"分"成对
  env              smallint    not null default 0,                -- 0 现网／1 沙箱；判定只认 PRO_ENV
  buy_quantity     integer     not null default 1,                -- V1 恒 1，但它是签名组成部分 ⇒ 留痕才能还原原文
  attach           text,                                          -- 我方透传串（下单时的 user_id）

  -- 退款**进行中**由 pro_refund_requests 表达（避免两处状态各写一半）；完成后置 refunded。
  status           text        not null default 'pending'
                              check (status in ('pending', 'paid', 'closed', 'anomaly', 'refunded')),

  expires_at       timestamptz not null,                          -- 下单时写"当前 + 15 分钟"：未付单的有效期

  is_duplicate     boolean     not null default false,            -- 并发多付 ⇒ 只用于退款分类（duplicate 类不耗额度）
  paid_after_close boolean     not null default false,            -- 迟到推送命中 closed 后复活 ⇒ 不落字段就统计不到

  -- 🔴 可触发性标注（第二十轮评审第 4 条）：按 6.3 实证的推送字段，当前真能命中的只有
  --   product_mismatch／openid_mismatch／sign_invalid／no_such_order／orphan 五个。
  --   amount_mismatch（无 ActualPrice）与 appid_mismatch／env_mismatch（推送不带这两个字段）
  --   在 R-9 证实前是**死分支**：枚举值保留，但代码里不得写对应判据（验收 #49）。
  --   "防沙箱单发真会员"的真实闸门是 env 列 + PRO_ENV，不是这里。
  -- ✅ E-17 判丙（owner 2026-10-05）新增第六个**可命中**的值 `refunded_not_credited`：
  --   主动查单回"平台已退款"而我方这张单从没入过账 ⇒ 既不能按 `closed` 关（那语义是"没付过"），
  --   也不该把用户永久挡在门外。标这一档 + 建新单，A3 巡检看得见（它不是退款状态机：
  --   不撤账、不写 `refunded`，那是 B4 的 `xpay_refund_notify` 那一支）。
  anomaly_reason   text        check (anomaly_reason is null or anomaly_reason in (
                                 'amount_mismatch', 'product_mismatch', 'openid_mismatch',
                                 'appid_mismatch', 'env_mismatch', 'sign_invalid',
                                 'no_such_order', 'orphan', 'refunded_not_credited')),

  "operator"       text,                                          -- 人工把 anomaly 翻成 paid／补写账本必须留痕（引号原因见第 0 节）
  note             text,

  -- 🔴 7 天退款窗口的起点 ⇒ 取支付完成时间，查不到才退回推送到达时刻（⏸ R-9 ①），
  --   绝不取落库时刻。
  paid_at          timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),            -- paid_at − created_at ＝ 回调晚了多久

  callback_raw     jsonb,                                         -- 只作排障取证：落库前剥掉鉴权字段，🔴 永不下发给端上

  check (status not in ('paid', 'refunded') or paid_at is not null)
);

create index if not exists pro_orders_payer_openid_idx
  on public.pro_orders (payer_openid, paid_at desc);   -- 订单页与退款资格
create index if not exists pro_orders_user_id_idx
  on public.pro_orders (user_id);                      -- 客服检索
create index if not exists pro_orders_status_expires_at_idx
  on public.pro_orders (status, expires_at);           -- 未决单（前置③与关单）

-- 微信侧单号："唯一 + 条件"在 PG 里**只能是 partial index**，不能写成表约束。
create unique index if not exists pro_orders_wx_order_uk
  on public.pro_orders (wx_order_id)
  where wx_order_id is not null;

-- 🔴 挡双击／并发重复下单要落到库：应用层"有则复用"在并发两下时会留两张 pending 单。
-- 连带效果（实施须知）：这条索引使 4.5 前置④的"换档位必须先查单确认未付、把旧单置
-- closed、再新建一单"**由库强制**，不是操作纪律——同主体下第二张 pending 单插不进去。
create unique index if not exists pro_orders_one_pending_per_openid
  on public.pro_orders (provider, payer_openid)
  where status = 'pending';


-- ---------------------------------------------------------------------------
-- 2. pro_ledger —— 一笔生效一行，记"天数"，主体是 openid 不是账号
-- ---------------------------------------------------------------------------

create table if not exists public.pro_ledger (
  id            uuid primary key default gen_random_uuid(),

  -- 复合业务主体，与 user_identities 那两条唯一约束同形；带 provider 成本 0，
  -- 将来接支付宝／抖音不改表形状（但跨渠道权益互通是产品问题，见 §十）。
  provider      text        not null check (provider = 'wechat_mp'),
  payer_openid  text        not null,

  -- 🔴 这个 unique 把"已退款的单被回调重放"做成库约束（比"记得判一下 refunded_at"可靠）。
  -- ✅ E-16 判乙（owner 2026-10-05）：从 `uuid null` 改成 **not null**。理由是 Postgres 的
  --   `unique` 对多行 NULL **不设防** ⇒ "该写没写"这一类失误原形状挡不住，而漏写的后果是
  --   三样同时失效：双入账闸门、B4 撤账的寻址、6.5 对账口径（`pro-ops.sql` 把 `order_id is null`
  --   算作真单）。⚠️ 这条约束**只**关"漏写"这一格：本表按 D-2／4.6 刻意不建 FK ⇒
  --   "写了一个不存在的 order_id"仍然只能靠"只有 `proStore.insertLedgerRow` 能写"这条入口约束兜。
  --   实证：2026-10-05 回读这张表，14 行**全部** `order_id is null`，来源就是本目录
  --   `pro-coverage-check.sql` 第 26 行那句没带这一列的 insert——漏写的形状已被自己的核对脚本跑出来过。
  order_id      uuid        not null unique,

  -- 记"当初由哪个账号下的单"。🔴 只用于 4.7 那句"暂未生效"的展示判断，**不参与权益判定**
  -- ——一旦参与就变回邮箱锚。不建 FK。
  buyer_user_id uuid,

  env           smallint    not null,                -- 抄自订单；判定只认部署常量 PRO_ENV 对应的行
  effective_at  timestamptz not null,                -- ＝订单 paid_at，折叠的排序键

  -- 由 product_id 查服务端配置后写入的**快照** ⇒ 将来改商品期限不影响已入账的行。
  duration_days integer     not null check (duration_days > 0),

  -- 退款只作废被退那一笔；标 revoked 不删行 ⇒ 被拒时"还回去"成本≈0（置回 null）。
  revoked_at    timestamptz,

  created_at    timestamptz not null default now()

  -- 🔴 不建 valid_from／valid_until（D-2＝ⓐ）；不建 kind／compensation 枚举列
  --   （无订单手工发权益与改锚已被 7.6 判为不允许 ⇒ 留一个列名就是给将来开方便之门）。
);

-- 折叠扫描的索引：4.3 的代价登记里"每次判定要扫该 openid 的行（V1 通常 1–3 行）"，
-- 而它出现在每次会话接口上 ⇒ env 进索引，否则沙箱单多了就要回表。
create index if not exists pro_ledger_subject_idx
  on public.pro_ledger (provider, payer_openid, env, effective_at, id);


-- ---------------------------------------------------------------------------
-- 3. pro_refund_requests —— 一次申请一行
-- ---------------------------------------------------------------------------

create table if not exists public.pro_refund_requests (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null,

  -- 🔴 external 是第二十轮评审第 2 条新增：退款由外部发起（Apple／微信投诉／管理员
  --   直接在支付后台退）时，xpay_refund_notify 到达而本表没有申请行 ⇒ 补一行
  --   kind='external'、status='done'、operator='platform'。这是"钱已退、我方没有申请
  --   记录"唯一的留痕处，也是 4.5 撤账事务的入口凭据。
  kind         text not null check (kind in ('no_reason', 'duplicate', 'manual', 'external')),

  -- pending＝已申请、权益已撤、待管理员执行（点了就撤，U-11 已判）。
  status       text not null check (status in ('pending', 'done', 'rejected')),

  -- 🔴 7 天窗口**以 requested_at 判**（人工集中执行时可能已超平台可退期）。
  requested_at timestamptz not null default now(),
  executed_at  timestamptz,

  wx_refund_id text,
  "operator"   text,   -- 人工执行必留（与 note 一起；引号原因见第 0 节）
  note         text,

  created_at   timestamptz not null default now()
);

-- 待处理退款列表（管理端按 requested_at 排队）＋ pending > 3 天那条人工巡检。
create index if not exists pro_refund_requests_pending_idx
  on public.pro_refund_requests (status, requested_at);

-- 🔴 这条索引的语义要钉死：目的＝**"一笔单不能被撤两次账"**，不是"一笔单只能有一条退款记录"。
-- 被拒后再申请本来就是多行 ⇒ 实现时不要拿它当业务唯一性去排重；
-- 撤销的幂等判据在账本侧（pro_ledger.order_id unique + revoked_at is null）。
-- 也正因为它是 partial unique，外部退款回流撞上已有 pending 申请行时**必须更新那一行而不是
-- 插新行**（4.5 触发表：有则更新、无则插入、标 done 幂等；验收 #53）。
create unique index if not exists pro_refund_requests_order_active_uk
  on public.pro_refund_requests (order_id)
  where status in ('pending', 'done');


-- ---------------------------------------------------------------------------
-- 4. 权限面（4.6）：三张表同形——开 RLS、不建 policy、只 service_role
--
-- 🔴 这条 revoke **不是纵深防御，是唯一防线**（2026-10-04 真库实测，机制已复现）：
--   Supabase 在 public schema 上装了 `ALTER DEFAULT PRIVILEGES ... grant all on tables
--   to anon, authenticated, service_role` ⇒ 任何新建表**一落地就带着**
--   `anon=arwdDxtm / authenticated=arwdDxtm`（a 插 r 选 w 改 d 删 D 截断 x 引用 t 触发器 m 维护）。
--   两条后果：
--   ① RLS 只过滤 SELECT/INSERT/UPDATE/DELETE 的行，**管不住 TRUNCATE／REFERENCES／TRIGGER**
--     ⇒ "开了 RLS 就不必 revoke"是错的，那道 revoke 才是把这三项关掉的东西。
--   ② 下面那句 `grant select, insert, update, delete to service_role` 只做**加法**、不会收窄
--     默认给出去的 ALL ⇒ service_role 实际持有全权（它是可信的服务端角色，多出来的不构成洞，
--     但别以为这句把权限限成了四项）。
--   ⇒ 推论（适用于本仓所有表，不只会员表）：**任何绕过迁移文件建表的路径**（Dashboard 手写
--     CREATE TABLE、将来新迁移漏写第 4 节）都会让 anon/authenticated 当场拿到全权。
--     顺序必须是"建表 → 开 RLS → revoke → grant"，且 pro-billing-schema-check.sql 第 06 项
--     要定期跑（第 06 项的 leaked=0 就是抓这个的）。
--   ⚠️ 覆盖面要说清，别以为它管全库：**第 06 项只判三张 pro_* 表**。全库审计在
--     `user-identities-grants-fix.sql`（2026-10-04 探针查出 notes／cards／balances／
--     user_identities 四张表各被 anon/authenticated 持有 8 项权限）。
--     ⇒ owner 判＝**丙：只补 user_identities，业务三表登记为已知限制、日后碰到再改**
--       （原话「历史逻辑尽量少改动」）。撤 user_identities 的可证零影响：全仓 8 个
--       /rest/v1/user_identities 访问点全部走 serviceRoleFetch，anon key 只打 /auth/v1/*。
--       ⚠️ 那三张业务表**不能照抄**：authenticated 是业务 DML 的实际角色。
-- ---------------------------------------------------------------------------

alter table public.pro_orders           enable row level security;
alter table public.pro_ledger           enable row level security;
alter table public.pro_refund_requests  enable row level security;

-- 不创建任何 policy：anon／authenticated 一律拒；用户不得对订单表有任何写权限。
revoke all on public.pro_orders, public.pro_ledger, public.pro_refund_requests
  from anon, authenticated;

grant select, insert, update, delete
  on public.pro_orders, public.pro_ledger, public.pro_refund_requests to service_role;


-- ---------------------------------------------------------------------------
-- 5. pro_coverage —— 判定的一处真相（4.3）
--    pro_coverage(provider, openid, env, now) → { is_covered, valid_until, remaining_days }
--
--    折叠语义：取该主体下 revoked_at is null 且 env＝部署常量的行，按 effective_at, id 排序；
--    start_i = max(cursor, effective_at_i)；每档恰好覆盖 duration_days 个**北京时间自然日**
--    （D-13 已判＝甲：生效当日算第 1 日；接龙档的第 1 日＝上一档最后覆盖日的次日）；
--    cursor = end_i。
--
--    🔴 两个必须一起成立、否则"形似而实非"的细节：
--      ① greatest(..., prev_last_day + 1) 这一项省下的不是名义天数而是**用户真正到手的
--         覆盖**：11-01 当天续购若不修正 ⇒ 新档 11-01…11-30、其中 11-01 与上一档共用 ⇒
--         两档合计只往前推 29 天。⇒ prev_last_day 必须＝该档**最后一个被覆盖日**
--         （day_start + duration_days - 1）；赋成"首日"等于没修正（我曾这样写错过一次）。
--      ② 比较一律用 **now < end_excl**（次日 00:00，左闭右开），展示才用 end_i（23:59:59，D-1）。
--         用 end_i > now 会在每天最后一秒留下"既不算覆盖也不算显示过期"的静默空洞（验收 #46 ⑤）。
--
--    ⚠ at time zone 是**双向**运算符、写反了静默错 8 小时：
--      `timestamptz at time zone 'Asia/Shanghai'` → 北京墙上时钟的 timestamp；
--      `timestamp at time zone 'Asia/Shanghai'`   → 把墙上时钟解释成北京时刻的 timestamptz。
--      判据＝输出仍是 UTC 存储的 timestamptz。若写成单边，valid_until 整体漂 8 小时且
--      3.6 的到期提示跟着错。
--
--    "一处真相"的可验收形状（第二十轮评审第 5 条）：库里只有一个定义（验收 #39 数 pg_proc）、
--    CF 里只有一个调用点（rpc/pro_coverage）、端上与 Account.jsx 只渲染下发字段。
--    ⚠ 这与 4.3 否决的 ⓒ 不是一件事：ⓒ 被否决的实质是"绝对区间落库 + 触发器重算"，
--      与函数住在哪无关。库里只有时长与生效时刻两个事实列，区间永远算出来。
-- ---------------------------------------------------------------------------

-- 签名变更会留下旧重载 ⇒ 先 drop 两个旧形状，保证"库里只有一个定义"不是靠运气。
-- 🔴 p_env 用 integer 而不是 smallint（2026-18.3 真库实测）：PG **不做 integer→smallint 的隐式收窄**，
--    所以签名若是 smallint，任何写字面量的调用都会 42883 function does not exist——
--    `select (pro_coverage(i.provider, i.openid, 0, now())).is_covered ...` 这种最自然的写法当场炸，
--    而 PRD 4.4 用 `:pro_env` 占位恰好看不出来。列仍是 smallint（存储不变），
--    int2→int4 是隐式加宽 ⇒ 传列值与传字面量都能过；CF 侧 PostgREST 的 JSON 数字本来就是 integer。
--    ⚠ 连带一条 B1 口径：wrangler [vars] 里的 PRO_ENV 是**字符串**，发 rpc 前要 Number(env.PRO_ENV)。
drop function if exists public.pro_coverage(text, text, smallint, timestamptz);
drop function if exists public.pro_coverage(text, text, integer, timestamptz);

create or replace function public.pro_coverage(
  p_provider      text,
  p_openid        text,
  p_env           integer,
  p_now           timestamptz,
  out is_covered    boolean,
  out valid_until   timestamptz,   -- 展示口径＝end_excl − 1 秒（北京 23:59:59）；免费档为 null
  out remaining_days integer        -- 自然日差：到期当天算 0，可为负；无任何账本行为 null
) returns record
language plpgsql
stable
as $$
declare
  r               record;
  cursor_ts       timestamptz;   -- 上一档的覆盖末端（end_i）；null ⇒ 还没有任何档
  prev_last_day   date;          -- 🔴 上一档「最后覆盖日」，不是首日
  last_end_excl   timestamptz;   -- 🔴 判定用它（左闭右开），不用 valid_until
  start_i         timestamptz;
  day_start       date;
  end_excl        timestamptz;
  end_i           timestamptz;
begin
  is_covered     := false;
  valid_until    := null;
  remaining_days := null;

  -- SECURITY INVOKER（默认）＋表上零 policy ⇒ 只有 service_role 读得到行。
  -- 这函数不给权限（下面 revoke/grant 只管 execute），调用者拿不到数据就判不出权益。
  for r in
    select l.effective_at, l.duration_days
    from public.pro_ledger l
    where l.provider     = p_provider
      and l.payer_openid = p_openid
      and l.env          = p_env
      and l.revoked_at is null
    order by l.effective_at, l.id
  loop
    start_i := case
                 when cursor_ts is null then r.effective_at
                 else greatest(cursor_ts, r.effective_at)
               end;

    day_start := greatest(
      ((start_i at time zone 'Asia/Shanghai')::date),
      coalesce(prev_last_day + 1, (start_i at time zone 'Asia/Shanghai')::date)
    );

    end_excl := ((day_start + r.duration_days)::timestamp) at time zone 'Asia/Shanghai';
    end_i    := end_excl - interval '1 second';

    prev_last_day := day_start + r.duration_days - 1;
    cursor_ts     := end_i;
    last_end_excl := end_excl;
    valid_until   := end_i;
  end loop;

  -- 无任何生效账本行 ⇒ 免费档：is_covered=false，两个值都 null。
  -- 🔴 消费侧口径：valid_until 为 null 时 remaining_days 也为 null，"可续购"判据是
  --   `remaining_days is null or remaining_days <= 20`（4.5 前置⑤），别把 null 当成拒绝。
  if valid_until is null then
    return;
  end if;

  -- 比较用 end_excl（左闭右开）；valid_until 只是展示值。
  is_covered := p_now < last_end_excl;

  -- 提示窗口、续购判据、订单页展示读的都是这一个整数，别处不得再减一次时间（3.6）。
  remaining_days := ((valid_until at time zone 'Asia/Shanghai')::date)
                    - ((p_now at time zone 'Asia/Shanghai')::date);
end;
$$;

-- 照抄 d5-guest-account.sql:244-245 的 revoke/grant 形状。
revoke all on function public.pro_coverage(text, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.pro_coverage(text, text, integer, timestamptz)
  to service_role;

comment on function public.pro_coverage(text, text, integer, timestamptz) is
  '会员判定的一处真相（PRD v3 4.3）：读时折叠 pro_ledger，绝对区间不落库。valid_until 是展示值，is_covered 用 end_excl 左闭右开比较。';

comment on column public.pro_ledger.effective_at is '＝订单 paid_at，折叠的排序键；⚠ 可能退回推送到达时刻 ⇒ 追溯改写已看到的到期日（4.5 入账⑤ 已登记该代价）';
comment on column public.pro_ledger.duration_days is '商品期限的快照，接龙算术的唯一输入；改商品不影响已入账行';
comment on column public.pro_orders.payer_openid is '权益主体（明文不哈希，D-17 已判：HMAC 密钥不能轮换）⇒ 隐私政策要按"长期保存明文标识"写实';


-- ---------------------------------------------------------------------------
-- 6. pro_orders.updated_at 自动维护（同 notes.sql 4.1 / cards.sql 4.1）
-- ---------------------------------------------------------------------------

create extension if not exists moddatetime with schema extensions;

-- create trigger 没有 if not exists ⇒ 先 drop，否则本文件头那句"幂等可重跑"是假的。
drop trigger if exists pro_orders_touch_updated_at on public.pro_orders;
create trigger pro_orders_touch_updated_at
  before update on public.pro_orders
  for each row execute function extensions.moddatetime(updated_at);
