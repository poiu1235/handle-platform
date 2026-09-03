-- ============================================================================
-- v3 迁移脚本（已部署 v2.x 表的库执行；全新库直接跑整份 cards.sql 即可）
-- 2026-09-03 提取自 supabase/cards.sql 第 0 节 + 第 6 节（含同日扣款日规则修订）。
--
-- 背景：前端/CF 层已升 v3（不再传 merchant），线上 import_my_cards 函数若仍为
-- v2.x 会在导入时报 {"message":"导入行缺少商户"}——本脚本两段全部幂等，
-- 已迁移过的段重复执行不报错、不产生副作用。
--
-- ⚠ 第 0 节会把既有卡名合并为 "商户名-卡名"（v3 产品裁定，2026-09-02）。
-- 执行后无需重启任何服务，重试导入即可。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. 表迁移：merchant 并入 name → 同键冲突按 updated_at 保留最新 →
--    收缩唯一键为 (user_id, name) → 删 merchant / indefinite 两列
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
-- 6. 导入 RPC：import_my_cards(p_rows jsonb)（v3 版：单列 name、无 merchant/
--    indefinite 逻辑；行级过期三分支 + 缺失保留现值 + 4-B31 打包忽略 +
--    周期表示互斥清洗，事务内任一行失败整批回滚。
--    扣款日规则（用户裁定 2026-09-03）：行内显式携带优先；续费为开而缺失时
--    自动取生效终止日期（行内 DDL > 库内 DDL > 物化默认今天 + 2 年））
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
