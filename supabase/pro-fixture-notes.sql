-- ============================================================================
-- pro-fixture-notes.sql —— 给指定自测账号灌一批**活的**便利贴，用来跑验收 #60
--
-- #60 要判的是：两个开关都关的构建里，一个**存量已超过免费档 200** 的账号，便利贴／余额／
-- 会员卡三页都**不出现**余量行与撞墙引导（8.3 关态判据第 1、2 条）。所以要的正是
-- "库里已经超了、界面上什么都没画"这么个组合——存量不够，这一格就是空判。
--
-- 🔴 灌进来的每一行都是**活的**（memo + 未来截止日），不是僵尸行。这条不能省：
--   便利贴的 POST 在满额时会**先 sweep 再复数**（`functions/api/notes.js` 那段），
--   而无日期灵感过 `NO_DATE_TTL(7) + EXPIRED_RETENTION(7) + DONE_RETENTION(30)` 天就是
--   僵尸行 ⇒ 拿"很久以前创建的裸内容"灌数，撞墙那一刻会被服务端自己清掉，
--   症状是"明明灌了 500 条却还能继续记"——那会被误报成墙没生效。
--   这里统一 `due_date = 今天 + 2` ⇒ deriveState 恒 normal，sweep 那三棵树都碰不到它。
--
-- 可重跑：按 `PROTEST-` 前缀先删后插 ⇒ 反复改条数只会换成新的存量，不会越灌越多。
-- 撤除：见文件末尾那条注释掉的 DELETE，或再跑一次本文件把 v_count 改成 0（插 0 行＝只删不插）。
--
-- ⚠️ 只往自测账号灌。这些行的正文带 `PROTEST-` 前缀，界面上明摆着是测试数据；
--    别拿它当"用户存量分布"去算 3.3 门槛第 4 条那条占比——那是另一件事，要真数据。
-- 🔴 填完**别把带值的文件提交回仓库**（`v_ack` 预填＝闸门形同不存在，见 pro-fixture.sql 同条）。
-- ============================================================================

do $$
declare
  -- ▼▼▼ 只改这几行 ▼▼▼
  v_email   text    := 'REPLACE-ME@qq.com';   -- 目标自测账号邮箱
  v_count   integer := 210;                   -- 灌多少条夹具行（先删后插，是"总数"不是"增量"）
  v_ack     text    := 'REPLACE-ME';          -- 必须逐字改成 FIXTURE-SELFTEST-ONLY
  -- ▲▲▲ 以下不用改 ▲▲▲
  v_user_id uuid;
  v_n       integer;
  v_existing integer;
begin
  if v_ack <> 'FIXTURE-SELFTEST-ONLY' then
    raise exception 'pro-fixture-notes 未确认：把 v_ack 逐字改成 FIXTURE-SELFTEST-ONLY 再跑（这道闸挡的是"顺手往一个真账号灌两百条测试数据"）';
  end if;
  if v_count < 0 or v_count > 5000 then
    raise exception 'v_count=% 不合理（0～5000）', v_count;
  end if;

  select id into v_user_id from auth.users where email = v_email;
  if v_user_id is null then
    raise exception '找不到账号（v_email=%）', v_email;
  end if;

  -- 🔴 上限判的是**灌完之后的物理行数**，不是 v_count 本身——墙数的就是物理行数（3.4），
  --   而这个账号里除了夹具还有他自己记的行。卡在 499 是为了留出手工按「+」的路径：
  --   499 → 按一次成 500 → 再按一次才撞得到那句 409 原文（#60 第③支要的就是它）。
  --   早先这里写的是"v_count ≤ 480"，那是把两件事混成一件：换个本来就有几十条的账号就误拦。
  select count(*) into v_existing from public.notes where user_id = v_user_id and content not like 'PROTEST-%';
  if v_existing + v_count > 499 then
    raise exception '灌完会是 % 条物理行（已有非夹具 % ＋ 本次 %）＞499 ⇒ 手工按「+」就撞不到 500 那句了。v_count 填 % 以内即可',
      v_existing + v_count, v_existing, v_count, greatest(499 - v_existing, 0);
  end if;

  -- ↓ 闸门全部通过之后才动数据：先按前缀清掉本夹具先前留下的行（真单行不受影响）
  delete from public.notes where user_id = v_user_id and content like 'PROTEST-%';

  if v_count > 0 then
    insert into public.notes (user_id, kind, content, due_date, pinned, created_at)
    select v_user_id,
           'memo',
           'PROTEST-' || lpad(n::text, 3, '0') || ' 压墙测试数据（可整批删除，见 pro-fixture-notes.sql）',
           (current_date + 2),
           false,
           now() - make_interval(mins => n)
    from generate_series(1, v_count) as n;
    get diagnostics v_n = row_count;
  else
    v_n := 0;
  end if;

  raise notice 'pro-fixture-notes：账号 % 灌了 % 条（已有非夹具 % 条 ⇒ 物理行数 %）',
    v_user_id, v_n, v_existing, v_existing + v_n;
end $$;


-- ── 证据（编辑器里唯一看得见的那一条）─────────────────────────────────────
-- 期望：protest 行＝你填的条数；僵尸灵感行＝0（🔴 不是 0 就说明灌成了会被 sweep 清掉的形状）；
--       物理行数＝服务端那道墙 HEAD 数出来的同一个数（3.4 的计数口径）。
-- 按 PROTEST- 前缀分组 ⇒ 这里**不再重复填邮箱**（邮箱只在上面 DO 块里填一次）。
-- 撤干净之后这一条会返回 0 行——空结果本身就是"已清空"的证据。
select
  n.user_id                                                      as "账号",
  u.email                                                        as "邮箱",
  count(*)                                                       as "物理行数（墙数的就是这个）",
  count(*) filter (where n.content like 'PROTEST-%')             as "protest 行",
  count(*) filter (
    where n.kind = 'idea' and n.due_date is null
      and n.created_at::date < current_date - 44
  )                                                              as "僵尸灵感行（应为 0）",
  min(n.due_date) filter (where n.content like 'PROTEST-%')      as "protest 最早截止日",
  max(n.due_date) filter (where n.content like 'PROTEST-%')      as "protest 最晚截止日"
from public.notes n
left join auth.users u on u.id = n.user_id
where n.user_id in (select user_id from public.notes where content like 'PROTEST-%')
group by n.user_id, u.email
order by "protest 行" desc;

-- 撤除（整段选中执行一次）：
--   delete from public.notes where content like 'PROTEST-%';
