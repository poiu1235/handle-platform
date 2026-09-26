-- ============================================================================
-- cards-m8-fixture.sql · S2-M8 会员卡 AI 切片的验收 fixture（Dashboard 版）
--
-- 为什么有这份 SQL：脚本版 `scripts/seed-cards-m8.mjs` 要本机能直连 `*.supabase.co`，
-- 而 2026-09-27 实测这台机器到该域名 **TLS 被重置**（node: `fetch failed / ECONNRESET`；
-- curl: `(35) Connection was reset`；对照组 `api.github.com` → 200、
-- `pack.handle.host` → 401 可达）。⇒ 走 Supabase SQL Editor 执行本文件绕开本机网络。
-- ⚠ 两版的**行定义必须一致**（改一处改两处，同 `handle-platform/shared/*` 那份拷贝纪律）。
--
-- 覆盖矩阵与每行钉的判据：PRD `doc/miniprogram-ai-s2-card-prd.md` 的 6.5 与 10.1。
-- 12 行里 11 行可造；`renewIncomplete`（续费中却缺扣款日/周期）那支**结构上插不进库**
-- ——`cards_renew_complete` 内联在裸建表体里（cards.sql:108 + :155-160），
-- service_role 绕 RLS 不绕 CHECK ⇒ 那一支改由离线套件 `card-query.cjs` 喂行对象验。
--
-- 幂等：按唯一键 (user_id, name) do update ⇒ 重复执行不会多出行，且会把被结算推进过的
-- 日期拉回原值（这是 V65 / V85 能反复跑的前提）。
-- 跑法：整体选中执行一次。改目标账号只需改下面 params 里那一行 uuid。
-- ============================================================================

drop table if exists m8_fx;

create temp table m8_fx as
with params as (
  select
    -- 🔴 换账号就改这一行（与脚本版 --user=<uuid> 必须同一个账号）
    'c7e851d0-85ce-485c-8224-fcb59fb2d44d'::uuid as uid,
    -- 「今天」一律取**本地日**，不用 current_date：后者是 UTC，UTC+8 的 0–8 点会差一天
    -- （三套"今天"时钟那条坑，cards-db.md 9.2）。V67 钉的正是"到期日 = 今天"那一格。
    (now() at time zone 'Asia/Shanghai')::date   as t
),
fx(name, start_off, end_off, total_sessions, remaining_sessions, auto_renew, billing_cycle, period_days, billing_off, muted, icon_key) as (
  values
  --  卡名                起始偏移  DDL偏移 total remaining 续费  周期        天数 扣款偏移 静默      图标
  ('腾讯视频',             -300,       5,    null, null,     false, null,      null, null,  'none',   null),
  ('Keep健身',              -29,       0,    null, null,     false, null,      null, null,  'none',   null),  -- 🔴 V67 含今天边界（today > end_date 才算过期）
  ('哔哩哔哩大会员',         -30,      12,    null, null,     false, null,      null, null,  'none',   null),  -- 15 天内 / 7 天外
  ('中石化加油卡',           -93,      -3,    null, null,     false, null,      null, null,  'none',   null),  -- 已过期 → V82 / CD5 情形 C
  ('京东PLUS会员',           -27,       0,    null, null,     true,  'month',   null,    0,  'none',   null),  -- 🔴 V65：扣款日 = 今天（结算边界 <=）
  ('山姆会员店',             -18,      12,    null, null,     true,  null,        30,   12,  'none',   null),  -- 固定天数表示（period_days）
  ('海底捞次卡',             -30,      40,       8,    3,     false, null,      null, null,  'none',   null),  -- 剩 3 / 共 8
  ('洗车卡',                 -30,      20,    null,    0,     false, null,      null, null,  'none',   null),  -- 剩 0 = 已用完，且未续费 ⇒ 端上沉底
  ('全家便利卡',             -30,       9,    null, null,     false, null,      null, null,  'none',   null),  -- 🔴 两键皆空 = 无次数能力（最易被实现混掉）
  ('爱奇艺黄金会员',          -90,      -3,    null, null,     true,  'month',   null,   -3,  'cycle',  null),  -- 🔴 V85：已过扣款日 + 本周期静默
  ('汉堡王 中国',            -30,      25,    null, null,     false, null,      null, null,  'none',   null),  -- 内部空格：搜「汉堡王中国」应 0 命中
  ('QQ音乐会员',             -30,       7,    null, null,     false, null,      null, null,  'none', '__none__')  -- 中英混排 + 大写；顺手放一个「明确选无」
)
select
  p.uid                                     as user_id,
  btrim(f.name)                             as name,
  (p.t + f.start_off)::date                 as start_date,
  (p.t + f.end_off)::date                   as end_date,
  f.total_sessions::integer                 as total_sessions,
  f.remaining_sessions::integer             as remaining_sessions,
  f.auto_renew::boolean                     as auto_renew,
  f.billing_cycle::text                     as billing_cycle,
  f.period_days::integer                    as period_days,
  case when f.billing_off is null then null
       else (p.t + f.billing_off::integer)::date end as next_billing_date,
  f.muted::text                             as muted,
  f.icon_key::text                          as icon_key,
  -- created_at 用本地正午：避免"记于今天"跨午夜漂一天（与脚本版同一处理）
  ((p.t + greatest(f.start_off, -400))::timestamp at time zone 'Asia/Shanghai') as created_at
from params p, fx f;

-- ── 落库前先跑一遍四条 CHECK 的"人话版"断言 ──────────────────────────────────
-- 为什么值得这一段：撞 CHECK 是**整批失败**，报错文本是 Postgres 的约束名，读的人要
-- 反查是哪一行哪一列。这里先自己数、自己 raise，失败信息直接点名行数与合规计数。
-- 半套 fixture 比没有更坏——读侧判据会拿到错误的对照集，所以宁可整批回滚。
do $$
declare
  n_all        integer;
  n_dup        integer;
  n_ddl_ok     integer;
  n_renew_ok   integer;
  n_cycle_ok   integer;
  n_pair_ok    integer;
  n_muted_ok   integer;
begin
  select count(*) into n_all from m8_fx;
  select count(*) - count(distinct name) into n_dup from m8_fx;
  select count(*) into n_ddl_ok   from m8_fx where end_date >= start_date;
  select count(*) into n_renew_ok from m8_fx
    where not auto_renew or (next_billing_date is not null and (period_days is not null or billing_cycle is not null));
  select count(*) into n_cycle_ok from m8_fx where not (period_days is not null and billing_cycle is not null);
  select count(*) into n_pair_ok  from m8_fx where total_sessions is null or remaining_sessions is not null;
  select count(*) into n_muted_ok from m8_fx where muted in ('none','cycle','forever');

  if n_all <> 12                              then raise exception 'M8 fixture 行数应为 12，实得 %', n_all; end if;
  if n_dup <> 0                               then raise exception 'M8 fixture 内部重名 % 组（唯一键 user_id,name 会互相覆盖）', n_dup; end if;
  if n_ddl_ok <> 12                           then raise exception 'M8 fixture 有行违反 cards_end_after_start，合规 %/12', n_ddl_ok; end if;
  if n_renew_ok <> 12                         then raise exception 'M8 fixture 有行违反 cards_renew_complete，合规 %/12', n_renew_ok; end if;
  if n_cycle_ok <> 12                         then raise exception 'M8 fixture 有行违反 cards_cycle_exclusive，合规 %/12', n_cycle_ok; end if;
  if n_pair_ok <> 12                          then raise exception 'M8 fixture 有行违反 cards_count_pair，合规 %/12', n_pair_ok; end if;
  if n_muted_ok <> 12                         then raise exception 'M8 fixture 有行 muted 枚举无效，合规 %/12', n_muted_ok; end if;
  raise notice 'M8 fixture 断言通过：12 行，四条 CHECK 与枚举全部合规';
end
$$;

-- ── 写入（幂等 upsert）─────────────────────────────────────────────────────
insert into public.cards as c (
  user_id, name, start_date, end_date, total_sessions, remaining_sessions,
  auto_renew, billing_cycle, period_days, next_billing_date, muted, icon_key, created_at, updated_at
)
select user_id, name, start_date, end_date, total_sessions, remaining_sessions,
       auto_renew, billing_cycle, period_days, next_billing_date, muted, icon_key, created_at, now()
from m8_fx
on conflict (user_id, name) do update set
  start_date         = excluded.start_date,
  end_date           = excluded.end_date,
  total_sessions     = excluded.total_sessions,
  remaining_sessions = excluded.remaining_sessions,
  auto_renew         = excluded.auto_renew,
  billing_cycle      = excluded.billing_cycle,
  period_days        = excluded.period_days,
  next_billing_date  = excluded.next_billing_date,
  muted              = excluded.muted,
  icon_key           = excluded.icon_key,
  created_at         = excluded.created_at,
  updated_at         = now();
-- updated_at 也是显式写的：表上有 extensions.moddatetime 触发器会自己重打，这里写死
-- 是为了让"重跑复原"这件事在结果表里看得见（否则第二次跑与第一次跑的 updated_at 差异
-- 会被人误读成"数据被动过 = 有别的写入方"）。

-- ============================ 核对（只读，可反复跑）============================
with p as (
  select 'c7e851d0-85ce-485c-8224-fcb59fb2d44d'::uuid as uid,
         (now() at time zone 'Asia/Shanghai')::date    as t
)
select
  c.name                                        as 卡名,
  (c.end_date - p.t)                            as 剩天,
  -- 🔴 判据必须与端上一字不差：`cardsDomain.js:132` 是 **today > end_date 才算过期**（到期当天仍生效）。
  -- 这一行原本写成 `case when c.end_date > p.t then '生效' else '已过期'` ⇒ 把"剩天 0"的两行
  --（Keep健身、京东PLUS会员）显示成已过期，与 skill 侧 `cardQuery.js` 的判据**相反**。
  -- ⇒ 核对口径本身也要对账：它不是"只读所以无害"那一类，错一次就足够让人以为 fixture 造坏了。
  case when p.t > c.end_date then '已过期' else '生效' end              as 状态,
  case c.auto_renew
       when true then '续费·' || coalesce(c.billing_cycle, c.period_days || '天')
                 || '·扣款 ' || to_char(c.next_billing_date, 'MM-DD')
       else '不续费' end                                                as 续费,
  coalesce(c.remaining_sessions::text, '—')
    || ' / ' || coalesce(c.total_sessions::text, '—')                   as 次数,
  c.muted                                       as 静默,
  coalesce(c.icon_key, '（未指定→自动匹配）')     as 图标
from p, public.cards c
where c.user_id = p.uid
  and c.name in ('腾讯视频','Keep健身','哔哩哔哩大会员','中石化加油卡','京东PLUS会员','山姆会员店',
                 '海底捞次卡','洗车卡','全家便利卡','爱奇艺黄金会员','汉堡王 中国','QQ音乐会员')
order by c.end_date;

-- ── 清理（换账号或重跑之前要干净时才用；按卡名删，不碰该账号其他卡）────────────
-- 本文件不在版本控制内（handle-platform/.gitignore 排掉了 supabase/）⇒ 这份 SQL 的正文
-- 已同步抄进 PRD 附录 B 的"第 0 步交付物"那条，换机器不丢。
-- delete from public.cards
-- where user_id = 'c7e851d0-85ce-485c-8224-fcb59fb2d44d'::uuid
--   and name in ('腾讯视频','Keep健身','哔哩哔哩大会员','中石化加油卡','京东PLUS会员','山姆会员店',
--                '海底捞次卡','洗车卡','全家便利卡','爱奇艺黄金会员','汉堡王 中国','QQ音乐会员');
