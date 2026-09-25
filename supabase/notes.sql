-- ============================================================================
-- 便利贴 · notes 表（依据 notes-wall-prd-v3 · 2026-09-12）
-- 在 Supabase SQL Editor 中整体执行一次即可。
-- 设计文档：src/doc/notes-wall-prd-v3.md（第三节时间规则 / 第八节数据与实现、
-- API 契约、校验分层、联调必测清单）
--
-- v3 定位（D1–D16）：
--   · 两类内容：灵感 idea（无日期、无完成、不流转）与 备忘 memo（可选日期、
--     完整生命周期 正常 → 已过期 → 已完成 → 清除）；
--   · 状态全派生（8.2）：过期 / 归档 / 清除均由时间算出，不落库、无状态机
--     写放大、无结算 RPC、无 cron——唯一写库的状态动作是手动完成（finished_at）。
--     对照 cards：本表没有 settle / import RPC 的必要，DB 只剩 CRUD；
--   · D15 类型不可互转（notes_kind_lock 触发器钉死）；
--   · D10 已完成只进不出（notes_finish_lock 触发器钉死：finished_at 一经写入
--     不可改值、不可清除；已完成条目只可删除）。
--
-- 与 v2 便签墙（notes-wall-prd-v2.md 第六章的 notes 表草案：kind=task/idea、
-- remind_at、repeat_rule、last_fired_at 等）完全无关——该草案从未建库，本文件
-- 为全新建表，无迁移段。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 表结构
--    一张表、无流水、无唯一键（同一句话允许记两条）。
--    派生口径（客户端本地日历，PRD 3.2 / 8.2；DB 不参与推导）：
--      截止日       = due_date ?? (created_at 本地日 + 7 天)
--      已过期       = 截止日 < 今天 < 归档时刻
--      归档时刻     = 截止日 + 8 天 00:00
--      已完成(自动) = now ≥ 归档时刻 且 finished_at is null
--      已完成(手动) = finished_at is not null
--      清除时刻     = (归档时刻 或 finished_at) + 30 天
-- ---------------------------------------------------------------------------

create table public.notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users (id) on delete cascade,

  -- 类型（D3/D15）：创建后不可变更——PATCH 白名单不含 kind（CF 层）+
  -- notes_kind_lock 触发器（DB 层，见第 4 节）
  kind        text        not null check (kind in ('idea', 'memo')),

  -- 正文（1–500 字）：CF 层 JS trim 全部 Unicode 空白，DB 兜底 ASCII 空格——
  -- 与 cards_name_trimmed 同款分层，让两条写入路径对 trim 不变式的强制等级对齐
  -- （NBSP、全角空格等 Unicode 空白依赖应用层 JS trim，已声明接受）
  content     text        not null check (
                content <> '' and char_length(content) <= 500 and content = btrim(content)
              ),

  -- 截止日期（仅 memo）：null = 未设日期（截止 = 创建日 + 7 兜底；界面不显示
  -- 倒计时角标，避免被误读成自己设的期限，D5）。窗口 [今天, 今天+7] 是移动窗口
  -- 且按客户端本地日历计——DB 无从判定"今天"（current_date 是 UTC），与 cards
  -- 的日期窗口同款：CF 层校验（请求携带 today，预留 #8 口径），DB 不设窗口约束
  due_date    date,

  -- 手动完成时刻（仅 memo；D10 = 用户处理结果，正常期 / 过期期点完成统一写它，
  -- 不区分在哪个阶段完成）。自动归档不写库——时间派生（8.2）；一旦写入不可改值、
  -- 不可清除（notes_finish_lock 触发器），30 天清除计时以它为锚
  finished_at timestamptz,

  -- 置顶（D11）：只影响置顶分区收录（正常态条目），不豁免任何流转；
  -- 已过期 / 已完成条目的 pinned 值无展示效果（CF 层拒绝对其修改）
  pinned      boolean     not null default false,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),      -- moddatetime 触发器维护

  -- D3：灵感是"裸内容"——无日期、无完成。一个 CHECK 钉死两个不变式，
  -- 杜绝"点子带日期 / 点子被完成"的脏状态（含绕过 CF 的直写）
  constraint notes_idea_plain check (
    kind <> 'idea' or (due_date is null and finished_at is null)
  )
);

-- ---------------------------------------------------------------------------
-- 2. 索引：全量拉取（≤500 行 / 人，order=created_at.desc）走这一枚。
--    没有扫描型索引——没有 cron / 结算 / 服务端提醒，DB 之外没人按时间找行
-- ---------------------------------------------------------------------------

create index notes_user_list on public.notes (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. RLS（与 cards / balances 同构：CF 层转发用户 access token，Supabase 强制归属）
-- ---------------------------------------------------------------------------

alter table public.notes enable row level security;

create policy "notes_select_own" on public.notes
  for select using (user_id = auth.uid());
create policy "notes_insert_own" on public.notes
  for insert with check (user_id = auth.uid());
create policy "notes_update_own" on public.notes
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "notes_delete_own" on public.notes
  for delete using (user_id = auth.uid());

grant select, insert, update, delete on public.notes to authenticated;

-- ---------------------------------------------------------------------------
-- 4. 触发器（三枚）
-- ---------------------------------------------------------------------------

-- 4.1 updated_at 自动维护（同 cards 4.1）
create extension if not exists moddatetime with schema extensions;

create trigger notes_touch_updated_at
  before update on public.notes
  for each row execute function extensions.moddatetime(updated_at);

-- 4.2 D15 类型不可互转：kind 创建后定死，编辑不提供类型切换——记错了删掉重记
create or replace function public.notes_kind_lock()
returns trigger
language plpgsql
as $$
begin
  if new.kind is distinct from old.kind then
    raise exception '类型创建后不可更改（灵感 / 备忘禁止互转）';
  end if;
  return new;
end;
$$;

create trigger notes_kind_lock
  before update on public.notes
  for each row execute function public.notes_kind_lock();

-- 4.3 D10 已完成只进不出：finished_at 一经写入——
--     · 不可清除（已完成不可恢复，9.1-10；误完成删掉重记）
--     · 不可改值（30 天清除计时以它为锚，改值等于重置保留期）
--     · 连带 content / due_date / pinned 全部冻结（已完成条目只可删除）
--     首次写入时校验不超前（客户端时钟漂移容忍 5 分钟；伪造仅自伤）
create or replace function public.notes_finish_lock()
returns trigger
language plpgsql
as $$
begin
  if old.finished_at is not null then
    if new.finished_at is distinct from old.finished_at
       or new.content   is distinct from old.content
       or new.due_date  is distinct from old.due_date
       or new.pinned    is distinct from old.pinned then
      raise exception '已完成条目只可删除（不可恢复、不可编辑、完成时刻不可改）';
    end if;
  else
    if new.finished_at is not null
       and new.finished_at > now() + interval '5 minutes' then
      raise exception '完成时刻不能晚于当前时间';
    end if;
  end if;
  return new;
end;
$$;

create trigger notes_finish_lock
  before update on public.notes
  for each row execute function public.notes_finish_lock();
