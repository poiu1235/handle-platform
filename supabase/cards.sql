-- ============================================================================
-- 生活卡包 · cards 表（依据 PRD v2.3 · 随 v2 写入模型简化；边界编号 B 指 PRD 第四章 B1–B38）
-- 在 Supabase SQL Editor 中整体执行一次即可。
-- 设计文档：src/cards-db.md（字段对照、校验分层、API 契约、请求预算、联调必测清单）
--
-- v2 简化（PRD 第七章待办 1）：
--   · 写入模型统一为"后写覆盖先写"（3.6.2）——删除来源标记列、盖章触发器
--     （cards_sync_meta）、冲突判定与采纳闸门的 RPC 逻辑、手动-导入路径 GUC 分层；
--   · 取消分类字段（4-I：不做分类维度）；
--   · 新增 indefinite 无限期物化标记（R1 / 4-B5：详情页「无限期卡」标注用）；
--   · 4-B22 静默解除统一为"end_date 实际变化即解除"，单枚触发器承载全部渠道。
--
-- v2.1 评审合入（2026-08-31）：
--   · #1 B22 触发器补第三条件"muted 未被本语句显式设置"——同请求"顺延 + 设静默"
--     不再被自动解除吞掉；
--   · #3 B19 对齐算法钉死：end_date < next_billing_date → 直接赋值，消除歧义；
--   · #5 导入更新行显式带来 DDL → 清除 indefinite（扫描客观期限取代物化标注）。
--
-- v2.2（第二轮评审，2026-08-31）：SQL 无改动——
--   · 1.1 "传同值 vs 未传"原理上不可分辨，DB 按 4-B22 默认解除（宁可多提醒），
--     该场景由前端 diff-only 提交契约排除（src/cards-db.md 7.3 强制规范）；
--   · 四-1 追赶不加迭代上限（千次级循环成本可忽略，上限会破坏 3.4.2 精确追赶）。
--
-- v2.3（产品裁定，2026-08-31）：商户改必填（覆盖 PRD v2.3 4-B36 的可空裁定）——
--   merchant 去默认值、导入行缺商户报错；展示名 = "商户名-卡名" 拼接为纯前端
--   推导，不落库、不参与唯一键。
--
-- v3（产品裁定，2026-09-02）：
--   · 删除 indefinite 列——"永久卡"展示概念已取消，物化标记无消费方；
--     DDL 留空的物化行为本身保留（仍按"今天 + 配置 B"落具体日期）；
--   · name 与 merchant 合并为单列 name（展示名 "商户名-卡名" 落库化）：
--     唯一键收为 (user_id, name)，导入解析/建卡表单/删除编辑弹窗全部
--     只见一个卡名字段。已部署库先跑第 0 节迁移段（幂等）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. v3 迁移段（已部署过 v2 表的库执行；全新库此段全部空跑）
--    merchant 并入 name（"商户名-卡名"）→ 同键冲突按 updated_at 保留最新 →
--    收缩唯一键 → 删两列。所有语句幂等，重复执行不报错。
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'cards' and column_name = 'merchant'
  ) then
    -- 1) 合并展示名（merchant 必填非空，无空分支；两列均满足 trim 不变式，
    --    拼接结果无首尾空白、不违反 cards_name_trimmed）
    update public.cards set name = merchant || '-' || name;

    -- 2) 合并可能产生的同键重复（同 user 同 name）：保留 updated_at 最新，
    --    并列时按 id 定序保证确定性。后写覆盖先写（3.6.2）语义下"最新"胜出
    delete from public.cards c
    using public.cards d
    where c.user_id = d.user_id and c.name = d.name
      and (c.updated_at, c.id) < (d.updated_at, d.id);

    -- 3) 收缩唯一键 + 删列（cards_name_trimmed 引用 merchant，先删再建）
    alter table public.cards drop constraint cards_user_key;
    alter table public.cards drop constraint cards_name_trimmed;
    alter table public.cards drop column merchant;
    alter table public.cards drop column if exists indefinite;
    alter table public.cards
      add constraint cards_user_key unique (user_id, name);
    alter table public.cards
      add constraint cards_name_trimmed check (name = btrim(name, E' \t\n\r\v\f　'));
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. 表结构
--    一张表、无流水（3.0 公理：只存当下、写入即覆盖）；
--    "次数能力"与"自动续费能力"都是可空字段组（3.1：一种卡 + 两个可选能力）：
--      remaining_sessions IS NULL      ⇒ 次数能力未开启（4-B31）
--      auto_renew = false              ⇒ 自动续费未开启
-- ---------------------------------------------------------------------------

create table public.cards (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid        not null references auth.users (id) on delete cascade,

  -- 身份（3.6.1：唯一键 = 卡名，trim 后精确匹配；服务端从 token 注入 user_id。
  -- v3：卡名即展示名（商户名-卡名 全称直接落库），不再单设商户列；
  -- 4-I：无分类维度；4-B3：卡名不可改——改键等于变成另一张卡，删卡重录）
  name                text        not null,

  -- 有效期（核心字段；4-B3：起始日为纯展示字段——手动可改（配置 A）、导入可静默覆盖，
  -- 不参与任何推导与默认值计算；4-B5：DDL 留空创建时物化为"今天 + 配置 B"，
  -- 物化后无空值 → 状态推导单轴（3.2：今天 > end_date 即过期）无特判。
  -- v3：物化标记 indefinite 列已删——"永久卡"展示概念取消，无消费方）
  start_date          date        not null default current_date,
  end_date            date        not null,

  -- 用量（可选能力；remaining_sessions IS NULL = 能力未开启；= 0 → "次数用完"展示条件，
  -- 3.2：非状态、不影响循环、仅排除到期提醒——扣款提醒照常）
  total_sessions      integer     check (total_sessions is null or total_sessions > 0),      -- 每周期次数（可选配置）
  remaining_sessions  integer     check (remaining_sessions is null or remaining_sessions >= 0),

  -- 续费（默认关；开启时"扣款日必填 + 周期信息二选一"——4-B27，DB 层 CHECK 兜底）：
  --   周期信息 = billing_cycle（周/月/季/年，日历语义——连续包月类）或 period_days
  --   （合同固定天数——"30 天月卡""365 天年卡"写合同多少是多少，3.4.2）；
  --   两种表示互斥（3.1，库表 CHECK 强制，见下方约束）
  auto_renew          boolean     not null default false,     -- 循环的唯一开关（3.4.1）；次数对循环零影响
  billing_cycle       text        check (billing_cycle is null or billing_cycle in ('week', 'month', 'quarter', 'year')),
  period_days         integer     check (period_days is null or period_days > 0),
  next_billing_date   date,                                    -- 只有开启自动续费的卡才有、才可改

  -- 静默（按卡；4-B22：'cycle' 随 end_date 实际变化自动解除——触发器见第 4 节）
  muted               text        not null default 'none' check (muted in ('none', 'cycle', 'forever')),

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),      -- 行级（清单"最后更新"类展示）

  -- 3.6.1：每张卡每用户有且只有一条记录（v3：卡名即展示名，单列唯一键）
  constraint cards_user_key unique (user_id, name),
  -- 4-B6：时间倒置非法
  constraint cards_end_after_start check (end_date >= start_date),
  -- 4-B27：自动续费开启则"扣款日必填 + 周期信息（cycle 或 period_days）二选一必填"。
  -- 扣款日条件括在周期条件之外：period_days 非空不能豁免 next_billing_date 必填
  constraint cards_renew_complete check (
    auto_renew = false
    or (next_billing_date is not null
        and (period_days is not null or billing_cycle is not null))
  ),
  -- 3.1：周期表示互斥（至多一个非空）。结算按"period_days 非空就用它、为空才按
  -- billing_cycle 日历推进"取值（3.4.2），两字段同时非空会让详情页与结算算法
  -- 各说各话。写入侧（CF 层 PATCH/POST、导入 RPC）负责机械置空另一字段
  constraint cards_cycle_exclusive check (
    not (period_days is not null and billing_cycle is not null)
  ),
  -- 4-B31：次数能力判据挂在 remaining（NULL = 未开启），total 必须联动清空——
  -- 防"关闭只清 remaining"的残留态（重开时套餐总量失真 + 结算把已关闭的能力静默重开）
  constraint cards_count_pair check (total_sessions is null or remaining_sessions is not null),
  -- 3.6.1：trim 不变式钉进 DB——导入 RPC 在 SQL 内 trim，单条 POST/PATCH 由 CF 层
  -- trim，这条 CHECK 让两条写入路径对唯一键不变式的强制等级对齐。
  -- 字符集显式含全角空格（动机场景"重庆火锅　"）；NBSP 等其余 Unicode 空白
  -- 依赖应用层 JS trim（src/cards-db.md 已声明）
  constraint cards_name_trimmed check (
    name = btrim(name, E' \t\n\r\v\f　')
  )
);

-- ---------------------------------------------------------------------------
-- 2. 索引
--    cards_user_key 已覆盖同名查找；结算扫描（3.4.2 追赶）走部分索引
-- ---------------------------------------------------------------------------

create index cards_settle_idx on public.cards (user_id, next_billing_date) where auto_renew;
create index cards_user_ddl_idx on public.cards (user_id, end_date);

-- ---------------------------------------------------------------------------
-- 3. RLS（与 balances 同构：Cloudflare 层转发用户 access token，Supabase 强制归属）
-- ---------------------------------------------------------------------------

alter table public.cards enable row level security;

create policy "cards_select_own" on public.cards
  for select using (user_id = auth.uid());
create policy "cards_insert_own" on public.cards
  for insert with check (user_id = auth.uid());
create policy "cards_update_own" on public.cards
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "cards_delete_own" on public.cards
  for delete using (user_id = auth.uid());

grant select, insert, update, delete on public.cards to authenticated;

-- ---------------------------------------------------------------------------
-- 4. 触发器（仅两枚；v1 的 cards_guard / cards_sync_meta / 路径 GUC 已随 v2 简化删除）
-- ---------------------------------------------------------------------------

-- 4.1 updated_at 自动维护
create extension if not exists moddatetime with schema extensions;

create trigger cards_touch_updated_at
  before update on public.cards
  for each row execute function extensions.moddatetime(updated_at);

-- 4.2 4-B22 静默自动解除（全渠道统一规则）
--     "凡 end_date 实际发生变化即自动解除「本周期」静默"——手动顺延（PATCH /
--     POST 覆盖）、结算追赶、导入推进周期日期共用这一枚触发器，v1 按渠道分写
--     + GUC 跳过的方案整体废除。is distinct from 保证例行扫描写同值不触发；
--     方向不分支（扫描校正提前同样解除）；'forever' 不受影响（只能手动解除）。
--     卡自然过期不产生写库、无需解除（已过期卡本就被提醒排除）；顺延重新激活
--     时 end_date 变化 → 解除。
--     评审 #1：第三个条件 = "muted 未被本语句显式设置"。PostgREST PATCH 与
--     merge-duplicates 只 SET payload 携带的列，结算 / 导入 RPC 的 UPDATE 也不含
--     muted——NEW.muted = OLD.muted 即"本次写入没碰静默开关"。同一请求里
--     "顺延 + 显式设为 cycle"（如顺延弹窗带静默勾选）是用户的明确意图，
--     不得被自动解除吞掉。契约前提：muted 仅在变化时携带（PATCH 只带要改的
--     字段）；未来若引入全量行客户端需重新评估此条件。
create or replace function public.cards_muted_reset()
returns trigger
language plpgsql
as $$
begin
  if new.muted = 'cycle'
     and new.end_date is distinct from old.end_date
     and new.muted is not distinct from old.muted then
    new.muted := 'none';
  end if;
  return new;
end;
$$;

create trigger cards_muted_reset
  before update on public.cards
  for each row execute function public.cards_muted_reset();

-- ---------------------------------------------------------------------------
-- 5. 结算 RPC：settle_my_cards(p_today)
--    PRD 3.4.2 算法的 SQL 实现（循环追赶 + 幂等；不检查次数状态；
--    两类周期两种算法——period_days 非空按合同固定天数推进，为空按
--    billing_cycle 日历推进）。
--    由 GET /api/cards 以用户 token 调用（PostgREST RPC，security invoker → RLS 生效），
--    一次请求完成"结算 + 返回全量行"——进站的后台交互次数 = 1。
--    p_today = 客户端本地日期（预留 #8 口径，2026-09-02 起传入）：结算追赶的
--    "今天"与前端展示的"今天"同源——修复跨时区错位（DB current_date 是 UTC，
--    UTC+8 的本地 0–8 点间 DB 仍是"昨天"，追赶不触发而界面已判过期，续费卡
--    会出现最长 8 小时的"已过期但未结算"误导态）；缺省回退 DB current_date
--    （直调不带参仍可用，4-B8 兜底）。
-- ---------------------------------------------------------------------------

create or replace function public.settle_my_cards(p_today date default null)
returns setof public.cards
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  c           public.cards;
  step        interval;
  new_billing date;
  new_end     date;
  rolled      boolean;
  v_today     date;
begin
  v_today := coalesce(p_today, current_date);
  for c in
    select * from public.cards
    where user_id = auth.uid()
      and auto_renew
      and (period_days is not null or billing_cycle is not null)   -- 4-B14 防御性兜底：缺周期形态不结算
      and next_billing_date < v_today
  loop
    -- 两类周期两种算法（3.4.2；cards_cycle_exclusive 保证两表示互斥，
    -- "period_days 优先"的顺序只是防御性书写——不存在双表示共存的歧义态）
    if c.period_days is not null then
      -- 合同固定天数类（"30 天月卡""365 天年卡"）：恰好推进 period_days 天，
      -- 无钳制、无漂移（1/31 + 30 天 = 3/2 是合同真实语义）
      step := c.period_days * interval '1 day';
    else
      -- 自然日历类（连续包月/连续包年）：按日历单位推进，逐周期钳制。
      -- 锚点收缩（31 → 28 → 28）是显式接受的行为（3.4.2，联调必测断言）
      step := case c.billing_cycle
        when 'week'    then interval '7 days'
        when 'month'   then interval '1 month'
        when 'quarter' then interval '3 months'
        else                interval '1 year'
      end;
    end if;

    -- 3.4.2：循环追赶；两个日期同步逐周期推进，保持相对差（4-B18）
    new_billing := c.next_billing_date;
    new_end     := c.end_date;
    rolled      := false;
    while new_billing < v_today loop
      new_billing := (new_billing + step)::date;
      new_end     := (new_end + step)::date;
      rolled      := true;
    end loop;

    -- 4-B19 落地（评审 #3 钉死算法）：B19 相对差收尾对齐——一次性赋值，非循环。
    -- 判断用 end_date < next_billing_date（B19 的相对差异常：DDL 落后于扣款日），
    -- 而非 end_date < 今天——后者分不清"追赶不够"与"相对差倒挂"；主循环保持的
    -- 相对差若本来就是 DDL 落后（用户曾把扣款日改到 DDL 之后），追赶结束后依然
    -- 落后，此处归零到规范关系（自动续费卡的常态是 DDL = 扣款日，S5）。
    -- 对齐 = end_date := next_billing_date 直接赋值：本周期已扣款，资格截止日
    -- 至少延展到本次扣款日；赋值幂等、一次到位，不引入第二个收敛条件不明的循环。
    -- 正常卡（end_date ≥ next_billing_date）该判断恒假，不影响任何现有行为；
    -- 本循环选出的行必已发生过追赶（rolled 恒真），与 PRD 3.4.2 的 N>0 前提一致
    if new_end < new_billing then
      new_end := new_billing;
    end if;

    if rolled then
      update public.cards set
        next_billing_date = new_billing,
        end_date          = new_end,
        -- 带次数且已配置每周期次数 → 重置为每周期次数（新周期默认值，3.4.2）；
        -- 无锚点 → 次数保持，等待扫描校准（4-B17）
        remaining_sessions = case
          when c.total_sessions is not null then c.total_sessions
          else c.remaining_sessions end
        -- muted='cycle' 的解除由 cards_muted_reset 触发器按 end_date 实际变化统一执行
      where id = c.id and user_id = auth.uid();
    end if;
  end loop;

  return query
    select * from public.cards where user_id = auth.uid();
end;
$$;

grant execute on function public.settle_my_cards() to authenticated;

-- ---------------------------------------------------------------------------
-- 6. 导入 RPC：import_my_cards(p_rows jsonb)
--    PRD 3.6.2 写入模型 + 3.6.3 缺失字段语义的服务端实现：
--      · 行级过期三分支（3.6.2，全产品唯一的行级条件）：
--          行有效     → upsert（没有则新增 / 有则覆盖更新）；
--          行判定过期 → 库内正常   → 更新（判死落库，扫描主权，明示接受）；
--                       库内已过期 → 跳过（无操作）；
--                       库内没有   → 插入（记录已结束的卡，4-B4）；
--      · 已存在同名卡 → 逐字段 coalesce 更新（缺失 = 保留现值，3.6.3）；
--      · 不存在       → 新增，缺失取默认（起始日 → 今天；DDL → 今天 + 2 年
--                       且与起始日无关 4-B5；auto_renew → 关；
--                       带 remaining_sessions → 次数能力开启）；
--      · 次数能力未开启的卡，更新行的次数字段组（remaining + total）打包宽容忽略
--        （4-B31：能力位是用户的结构决定，机器不得擅自恢复；打包防"total 非空 +
--        remaining 空"撞 cards_count_pair CHECK 而炸掉整批导入）；
--      · 周期表示互斥：行内同时携带两表示 → 拒绝（CF 预览已行报错，这里兜底）；
--        写入任一非空表示时机械置空另一字段（cards_cycle_exclusive 的实现手段）。
--    muted='cycle' 的解除由 cards_muted_reset 触发器按 end_date 实际变化统一执行
--    （4-B22：解除渠道不限；同值重写不触发；'forever' 不动）。
--    冲突 / 来源机制已随 v2 写入模型删除——预览分类（新增/更新/错误 + 过期行去向）
--    由前端用进站快照完成（S15，零额外请求），提交即生效，无逐条确认。
--    CF 层在转发前剥离 null 值键（显式 null 视同缺失）并完成配置窗口/枚举校验。
-- ---------------------------------------------------------------------------

create or replace function public.import_my_cards(p_rows jsonb)
returns setof public.cards
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  r          jsonb;
  v_existing public.cards;
  v_count_on boolean;
  v_row_dead boolean;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'payload 必须是行数组';
  end if;

  for r in select * from jsonb_array_elements(p_rows)
  loop
    if coalesce(trim(r ->> 'name'), '') = '' then
      raise exception '导入行缺少卡名';
    end if;

    -- 周期表示互斥（3.6.3 行级校验的服务端兜底）：同一行携带两种表示 = 工具自相矛盾，
    -- 不拒绝会同时触发双向置空清洗、把两个表示都洗掉
    if r ->> 'billing_cycle' is not null and r ->> 'period_days' is not null then
      raise exception '导入行同时携带 billing_cycle 与 period_days（周期表示二选一）';
    end if;

    -- 行判定过期 = 行内 DDL < 今天（3.6.2）；行缺 DDL 不判过期（新增时走物化默认 → 有效）
    v_row_dead := (r ->> 'end_date') is not null
                  and (r ->> 'end_date')::date < current_date;

    select * into v_existing from public.cards
    where user_id = auth.uid()
      and name = trim(r ->> 'name');

    if v_existing.id is not null then
      -- 三分支 ④：行判定过期 + 库内已过期 → 跳过（无操作）
      if v_row_dead and v_existing.end_date < current_date then
        continue;
      end if;

      -- 三分支 ②③：行有效 → 覆盖更新；行判定过期 + 库内正常 → 更新（判死落库）。
      -- 逐字段 coalesce：行内缺失（或 CF 剥离 null 后不存在）的字段保留现值
      v_count_on := v_existing.remaining_sessions is not null;

      -- 4-B27 合并态校验（用户裁定 2026-09-03 修订）：扣款日不再要求行内/库内补全——
      -- resolved 续费为开而扣款日缺失时，next_billing_date 自动取生效终止日期
      -- （行内 > 库内），见下方 UPDATE 的 coalesce；周期/天数仍必须完整，否则
      -- UPDATE 必撞 cards_renew_complete 并整批回滚——这里先显式 raise 给出可读的
      -- 行级原因；JS 预览分类（classifyImport）按同一规则行报错，双实现。
      -- 互斥清洗同步镜像：写入一种表示时另一表示视为置空，不参与完整性判断。
      if coalesce((r ->> 'auto_renew')::boolean, v_existing.auto_renew) then
        if (case when r ->> 'period_days' is not null then null
                 else coalesce(r ->> 'billing_cycle', v_existing.billing_cycle) end) is null
           and
           (case when r ->> 'billing_cycle' is not null then null
                 else coalesce((r ->> 'period_days')::int, v_existing.period_days) end) is null
        then
          raise exception '导入行「%」：自动续费为开但缺少扣款周期/合同天数（行内未携带且库内现值为空）', v_existing.name;
        end if;
      end if;

      update public.cards set
        start_date         = coalesce((r ->> 'start_date')::date, start_date),
        end_date           = coalesce((r ->> 'end_date')::date, end_date),
        total_sessions     = case when v_count_on
                             then coalesce((r ->> 'total_sessions')::int, total_sessions)
                             else total_sessions end,
        remaining_sessions = case when v_count_on
                             then coalesce((r ->> 'remaining_sessions')::int, remaining_sessions)
                             else remaining_sessions end,
        auto_renew         = coalesce((r ->> 'auto_renew')::boolean, auto_renew),
        -- 周期表示互斥清洗：写入任一非空表示时机械置空另一字段（系统不变式写入）
        billing_cycle      = case when r ->> 'period_days' is not null
                             then null
                             else coalesce(r ->> 'billing_cycle', billing_cycle) end,
        period_days        = case when r ->> 'billing_cycle' is not null
                             then null
                             else coalesce((r ->> 'period_days')::int, period_days) end,
        -- 扣款日（用户裁定 2026-09-03 二次修订）：续费为开（含行内翻转与既有续费中）
        -- 时一律强制 = 生效终止日期（行内 > 库内），行内显式扣款日忽略；续费关走
        -- 行内 ?? 现值（B26 宽容忽略由 CF 载荷剥离保证，此处不重复）
        next_billing_date  = case when coalesce((r ->> 'auto_renew')::boolean, auto_renew)
                             then coalesce((r ->> 'end_date')::date, end_date)
                             else coalesce((r ->> 'next_billing_date')::date, next_billing_date) end
      where id = v_existing.id and user_id = auth.uid();
    else
      -- 三分支 ①：新增（行有效或行判定过期均插入——4-B4 允许记录已结束的卡）。
      -- 缺失取默认（3.6.3）；DDL 缺失 → 物化"今天 + 2 年"（与起始日无关，4-B5）。
      -- CHANGE NOTE：此处默认 2 年 = shared/cardsConfig.js 配置 B（DDL_MAX_HORIZON_YEARS）
      -- 的初始值；调整该配置时需同步修改此默认值（见 src/cards-db.md 第 9 节）
      insert into public.cards (
        user_id, name, start_date, end_date,
        total_sessions, remaining_sessions,
        auto_renew, billing_cycle, period_days, next_billing_date
      ) values (
        auth.uid(),
        trim(r ->> 'name'),
        coalesce((r ->> 'start_date')::date, current_date),
        coalesce((r ->> 'end_date')::date, (current_date + interval '2 years')::date),
        (r ->> 'total_sessions')::int,
        (r ->> 'remaining_sessions')::int,
        coalesce((r ->> 'auto_renew')::boolean, false),
        r ->> 'billing_cycle',
        (r ->> 'period_days')::int,
        -- 扣款日（用户裁定 2026-09-03 二次修订）：续费开时一律强制 = 生效终止日期
        -- （行内显式 DDL，缺省则物化默认今天 + 2 年），行内显式扣款日忽略
        case when coalesce((r ->> 'auto_renew')::boolean, false)
             then coalesce((r ->> 'end_date')::date, (current_date + interval '2 years')::date)
             else (r ->> 'next_billing_date')::date end
      );
    end if;
  end loop;

  return query
    select * from public.cards where user_id = auth.uid();
end;
$$;

grant execute on function public.import_my_cards(jsonb) to authenticated;
