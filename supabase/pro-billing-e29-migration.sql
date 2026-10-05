-- ============================================================================
-- pro-billing-e29-migration.sql —— E-29 判甲：把"人工终态必须留痕"从代码搬进库（2026-10-05）
--
-- 加两条 CHECK（建表文件 pro-billing.sql 已同步，🔴 但 `create table if not exists` 重跑**不会补约束**
-- ⇒ 现网库必须跑这一份）：
--   · `pro_refund_requests_manual_traceable`：非 `pending` 的行必须有 `operator`＋`note`（非空非空串）。
--   · `pro_refund_requests_done_has_receipt`：`done` 还必须有 `wx_refund_id`。
--
-- 为什么值得为它写一笔迁移：这两件事原来只写在 `functions/admin/pro-refunds.js` 里。写在代码里的门，
-- 下一次重构（换个管理端点、加个批量脚本、谁在 SQL Editor 里手改一行）就没了；写在库里的门是**写入时刻**
-- 的约束，谁写都拦。而被拦下的那两种写法正是最贵的两种：
--   ① 没有回执号的 `done`＝"钱到底退没退"从此只能信一句 note（D-22 之后我方不发起退款，那个号是唯一外部凭据）；
--   ② 没有 operator 的 `rejected`＝谁都能把已撤的权益还回来且不留名。
--
-- 🔴 顺序：先数违规行、再加约束。有违规行时当场把清单报出来并**停住**（不 add、不动数据）——
--    那几行是要人判断怎么补的（补成什么终态、还是删掉），不许迁移替他们猜。
-- ⚠️ 跑完看最后那份证据表（⓪–⑤，无 FAIL），然后整体再跑一次 `pro-billing-schema-check.sql`
--    ⇒ 期望 **15 项全 PASS**（第 14 项就是这两条 CHECK）。🔴 没跑迁移之前会**同时红两项**：
--    第 14 项（约束不在）与第 08 项（`pro_refund_requests` 的 CHECK 条数 2 ≠ 4）——那不是回归，是没跑。
-- ============================================================================

do $$
declare
  v_bad_manual   integer;
  v_bad_receipt  integer;
begin
  select count(*) into v_bad_manual
  from public.pro_refund_requests
  where status <> 'pending'
    and ("operator" is null or "operator" = '' or note is null or note = '');

  select count(*) into v_bad_receipt
  from public.pro_refund_requests
  where status = 'done' and (wx_refund_id is null or wx_refund_id = '');

  if v_bad_manual > 0 or v_bad_receipt > 0 then
    raise exception
      'pro-billing-e29 停住：有 % 条终态行缺 operator/note、% 条 done 缺 wx_refund_id。'
      '先跑这一句看是哪几行：select id, order_id, kind, status, "operator", note, wx_refund_id '
      'from public.pro_refund_requests where status <> ''pending'' and ("operator" is null or "operator"='''' or note is null or note='''' or (status=''done'' and (wx_refund_id is null or wx_refund_id=''''))); '
      '——补成什么终态或删掉都要人判，迁移不替这几行猜。',
      v_bad_manual, v_bad_receipt;
  end if;

  -- 两条各自幂等：约束名进 pg_constraint，重复 add 会 42P07 一类的 duplicate object ⇒ 先看有没有。
  if not exists (
    select 1 from pg_constraint
    where conname = 'pro_refund_requests_manual_traceable'
      and conrelid = 'public.pro_refund_requests'::regclass
  ) then
    alter table public.pro_refund_requests
      add constraint pro_refund_requests_manual_traceable check (
        status = 'pending'
        or ("operator" is not null and "operator" <> '' and note is not null and note <> '')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pro_refund_requests_done_has_receipt'
      and conrelid = 'public.pro_refund_requests'::regclass
  ) then
    alter table public.pro_refund_requests
      add constraint pro_refund_requests_done_has_receipt check (
        status <> 'done' or (wx_refund_id is not null and wx_refund_id <> '')
      );
  end if;

  raise notice 'pro-billing-e29 已加两条 CHECK（违规行＝0／0）';
end $$;


-- ── 证据（编辑器里唯一看得见的那一条）⓪–⑤，任何一行 FAIL 都别继续 ──────────
select '⓪ 违规的终态行（缺留痕）'::text as "检查项",
       '0 条'::text as "期望",
       (select count(*)::text from public.pro_refund_requests
         where status <> 'pending'
           and ("operator" is null or "operator" = '' or note is null or note = '')) as "实际",
       case when (select count(*) from public.pro_refund_requests
                   where status <> 'pending'
                     and ("operator" is null or "operator" = '' or note is null or note = '')) = 0
            then 'PASS' else 'FAIL（迁移本该在上面就停住）' end::text as "结果"
union all
select '① manual_traceable 约束在', 'pg_constraint 里有',
       coalesce((select c.conname from pg_constraint c
                  where c.conrelid = 'public.pro_refund_requests'::regclass
                    and c.conname = 'pro_refund_requests_manual_traceable'), '（没有）'),
       case when exists (select 1 from pg_constraint c
                          where c.conrelid = 'public.pro_refund_requests'::regclass
                            and c.conname = 'pro_refund_requests_manual_traceable')
            then 'PASS' else 'FAIL' end
union all
select '② done_has_receipt 约束在', 'pg_constraint 里有',
       coalesce((select c.conname from pg_constraint c
                  where c.conrelid = 'public.pro_refund_requests'::regclass
                    and c.conname = 'pro_refund_requests_done_has_receipt'), '（没有）'),
       case when exists (select 1 from pg_constraint c
                          where c.conrelid = 'public.pro_refund_requests'::regclass
                            and c.conname = 'pro_refund_requests_done_has_receipt')
            then 'PASS' else 'FAIL' end
union all
select '③ 两条都是 CHECK 型（不是默认值／不是 not null）', 'contype＝c 的两条',
       (select string_agg(c.conname || '＝' || c.contype::text, '；' order by c.conname) from pg_constraint c
         where c.conrelid = 'public.pro_refund_requests'::regclass
           and c.conname in ('pro_refund_requests_manual_traceable', 'pro_refund_requests_done_has_receipt')),
       case when (select count(*) from pg_constraint c
                   where c.conrelid = 'public.pro_refund_requests'::regclass
                     and c.contype = 'c'
                     and c.conname in ('pro_refund_requests_manual_traceable', 'pro_refund_requests_done_has_receipt')) = 2
            then 'PASS' else 'FAIL' end
union all
select '④ 列数没被动过', 'pro_refund_requests 仍 10 列',
       (select count(*)::text from information_schema.columns
         where table_schema = 'public' and table_name = 'pro_refund_requests'),
       case when (select count(*) from information_schema.columns
                   where table_schema = 'public' and table_name = 'pro_refund_requests') = 10
            then 'PASS' else 'FAIL' end
union all
select '⑤ 总判定', '上面四项全 PASS',
       ((select count(*) from pg_constraint c
          where c.conrelid = 'public.pro_refund_requests'::regclass
            and c.conname in ('pro_refund_requests_manual_traceable', 'pro_refund_requests_done_has_receipt'))::text
        || ' 条 CHECK 已落地'),
       case when (select count(*) from pg_constraint c
                   where c.conrelid = 'public.pro_refund_requests'::regclass
                     and c.conname in ('pro_refund_requests_manual_traceable', 'pro_refund_requests_done_has_receipt')) = 2
            then 'PASS' else 'FAIL' end;
