-- ============================================================================
-- balances-schema-check.sql · 余额表结构与现网数据画像（**只读**，可随时重跑）
--
-- 存在的理由：`balances` 的建表 DDL **不在任何仓库里**
--   （supabase/ 下无一文件建过它；d5-guest-account.sql:34 自述「建表早于仓库化，
--    需肉眼确认一次」）。所以本脚本不是「与某份设计对账」（那是
--    cards-schema-check.sql 的形制——它有 cards.sql 作预期），而是
--    **把库里的真实形状一次性dump出来**，回填 PRD 的 BC1–BC5 五条待核事实。
--
-- 用法：Supabase SQL Editor 整体执行 → 出一张长表（**41 行**，来自 31 个 union 分支：
--   逐列 / 逐约束 / 逐索引 / 逐策略那几支按库里实际对象数展开）→ 把结果**整份贴回**给助手。
--   全部为 SELECT，零写入、零 DDL、可反复跑。
--   ✅ 2026-09-25 已跑通一次（41 行全部回传，结论落在 PRD 2.9.2）。
--   ⚠ 本脚本**假定 `balances` 表存在**（小程序余额标签能用即证明之）。若连的
--     项目/schema 里没有这张表，会直接报错而不是输出「表不存在」那一行——
--     报「relation "balances" does not exist」就等于结论：连错库了。
--
-- 读法：status 列只有两种值
--   INFO  = 事实回显，无对错（DDL 长什么样本身就是我们要的东西）
--   WARN  = 与小程序侧的既有假设冲突，需要决策（行号见 note 列）
--   ⚠ 一条 FAIL 都没有不代表"没问题"——本脚本刻意不判 PASS，
--     因为"预期"正是待核对象；只有下面 8 条探针是带判断的。
--
-- 对应需求：doc/miniprogram-ai-s2-balance-prd.md 的 BC1–BC5 与 2.12（trim 链路）
--
-- ⚠ 本文件要读 pg_trigger / pg_policies / pg_index 等系统目录，任一处列类型或位义与
--   预期不符就整批失败（已实测栽过一次：`pg_trigger.tgtype` 是 smallint 位掩码而非
--   char ⇒ 22P02，已修）。若还报别的目录版本错，先跑 **`balances-data-portrait.sql`**：
--   那个版本只查 `balances` 自己、不碰任何 pg_* 表，能独立回答 BQ3 / BQ6 / 2.12。
--
-- 另外本文件的"预期"其实不存在（balances 的 DDL 从来没进过版本控制），所以它
-- 只回显事实 + 8 条带判断的探针，不报 PASS/FAIL 总数。
-- ============================================================================

with
act_cols as (
  select column_name, data_type, is_nullable, column_default,
         numeric_precision, numeric_scale, datetime_precision,
         character_maximum_length
  from information_schema.columns
  where table_schema = 'public' and table_name = 'balances'
),
-- 小程序与后端线上用得到的 6 列（balances.js:22 的 select 串 + user_id）
exp_cols(name) as (
  values ('id'), ('user_id'), ('app_name'), ('amount'), ('updated_at'), ('icon_key')
),
act_cons as (
  select con.conname, con.contype, con.confrelid,
         pg_get_constraintdef(con.oid) as cdef,
         (select string_agg(a.attname, ',' order by a.attnum)
          from unnest(con.conkey) as u(attnum)
          join pg_attribute a on a.attrelid = con.conrelid and a.attnum = u.attnum) as cols
  from pg_constraint con
  where con.conrelid = to_regclass('public.balances')
),
act_idx as (
  -- ⚠ 这里**故意不用** `unnest(i.indkey)`：`indkey` 是 `int2vector`（伪数组，不是真数组），
  --   能不能喂给 `unnest(anyarray)` 取决于它的 typcategory 判定，本机无 PG 无法自测。
  --   一旦不成立就是整条语句 42883 全灭 —— 而这一节的列名信息 `idef` 里本来就有
  --   （`CREATE UNIQUE INDEX … ON public.balances USING btree (user_id, app_name)`）。
  --   用"可能好看的展示"去换"整份结果拿不回来"不值。唯一键的判据走 act_cons.conkey
  --   （那是**真** smallint[]，无此风险）。
  select c.relname as idxname, i.indisunique,
         (i.indpred is not null) as partial,
         coalesce(pg_get_indexdef(i.indexrelid), '') as idef
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  where i.indrelid = to_regclass('public.balances')
),
act_trg as (
  -- ⚠ `pg_trigger.tgtype` 是 **smallint 位掩码**（PG 9.0 起），不是 char。
  --   写成 `case tgtype when 'I' …` 会让 PG 把 `'I'` 往 smallint 转 ⇒
  --   `ERROR: 22P02: invalid input syntax for type smallint: "I"`（2026-09-25 实测踩过）。
  --   位定义：1=ROW 2=BEFORE 4=INSERT 8=DELETE 16=UPDATE 32=TRUNCATE 64=INSTEAD OF。
  --   末尾把原始整数也回显，万一位义与本文档不符可以肉眼判。
  select tg.tgname, n.nspname || '.' || p.proname as func,
         trim(both ' ' from (
           case when tg.tgtype & 2  <> 0 then 'BEFORE '     else '' end ||
           case when tg.tgtype & 64 <> 0 then 'INSTEAD OF ' else '' end ||
           case when tg.tgtype & 4  <> 0 then 'INSERT '     else '' end ||
           case when tg.tgtype & 8  <> 0 then 'DELETE '     else '' end ||
           case when tg.tgtype & 16 <> 0 then 'UPDATE '     else '' end ||
           case when tg.tgtype & 32 <> 0 then 'TRUNCATE '   else '' end
         )) || case when tg.tgtype & 1 <> 0 then 'FOR EACH ROW' else 'FOR EACH STATEMENT' end
           || '  (tgtype=' || tg.tgtype::text || ')' as evt
  from pg_trigger tg
  join pg_proc p on p.oid = tg.tgfoid
  join pg_namespace n on n.oid = p.pronamespace
  where tg.tgrelid = to_regclass('public.balances') and not tg.tgisinternal
),
act_pol as (
  -- `roles` 是 name[] ⇒ 不能 `::text`（数组到 text 无 I/O 转换路径，会报
  -- "cannot cast type name[] to text"），走 array_to_string
  select policyname, cmd, permissive, array_to_string(roles, ',') as roles,
         coalesce(qual, '∅') as q, coalesce(with_check, '∅') as w
  from pg_policies
  where schemaname = 'public' and tablename = 'balances'
),
-- ---------- 现网数据画像：数值列先按文本过一遍正则，脏值不参与数值聚合 ----------
-- （不这么写的后果：万一 amount 是 text 且含脏值，整条聚合直接报错，
--   而这个脚本的价值恰恰是"一次跑完拿全"）
amt as (
  select id, user_id, app_name, updated_at, icon_key,
         case when amount::text ~ '^(-?[0-9]+(\.[0-9]+)?|-?\.[0-9]+)$'
              then (amount::text)::numeric end as n
  from balances
),
stats as (
  select
    count(*)                                       as rows_total,
    count(distinct user_id)                        as users,
    count(*) filter (where n is null)              as amt_nonnumeric,
    count(*) filter (where n < 0)                  as amt_negative,
    count(*) filter (where n = 0)                  as amt_zero,
    count(*) filter (where n > 0 and n <> trunc(n)) as amt_fractional,
    count(*) filter (where n is not null
                      and (n * 100) <> trunc(n * 100)) as amt_over_2dp,
    coalesce(min(n)::text, '∅')                    as amt_min,
    coalesce(max(n)::text, '∅')                    as amt_max,
    count(*) filter (where updated_at is null)      as upd_null,
    count(*) filter (where app_name is null)        as name_null,
    count(*) filter (where app_name <> btrim(app_name)) as name_untrimmed,
    count(*) filter (where app_name <> regexp_replace(app_name, '\s+', '', 'g'))
                                                    as name_inner_space,
    count(*) filter (where length(app_name) > 50)   as name_over_50,
    coalesce(max(length(app_name))::text, '∅')      as name_maxlen,
    count(*) filter (where icon_key is null)        as icon_null,
    count(*) filter (where icon_key is not null and icon_key = '') as icon_emptystr,
    count(*) filter (where length(icon_key) > 64)   as icon_over_64,
    coalesce(max(length(icon_key))::text, '∅')      as icon_maxlen
  from amt
),
-- trim 之后会互相撞键的行（=「同名不覆盖、反成两条」的现网存量）
collide as (
  select coalesce(string_agg(k, '；' order by k), '') as pairs
  from (
    select user_id::text || ' / [' || btrim(app_name) || '] ×' || count(*)::text as k
    from amt
    where app_name is not null
    group by user_id, btrim(app_name)
    having count(*) > 1
  ) t
),
per_user as (
  select coalesce(max(c)::text, '∅') as max_rows,
         coalesce(avg(c)::numeric(10,1)::text, '∅') as avg_rows
  from (select user_id, count(*) c from amt group by user_id) u
),
-- 按用户拆开：行数 / 其中 0 值行数 / 最大金额。
-- 全表比值（42% 是 0）回答不了"默认排除 0 会不会让某个真实账号少看一大截"，这一行才回答得了。
per_user_zero as (
  select coalesce(string_agg(x, '；' order by x), '（无用户）') as by_user
  from (
    select left(user_id::text, 8) || '：' || count(*)::text || ' 行 / 0 值 '
           || count(*) filter (where n = 0)::text || ' / 最大 ' || coalesce(max(n)::text, '∅') as x
    from amt
    group by user_id
  ) g
),
-- 后端 API 的读法能不能成立：RLS 若未开，转发用户 token 也照样全库可读
rls_flag as (
  select relrowsecurity, relforcerowsecurity
  from pg_class where oid = to_regclass('public.balances')
),
grants as (
  select coalesce(string_agg(privilege_type, ',' order by privilege_type), '（无任何授权）') as got
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'balances' and grantee = 'authenticated'
)

-- ============================ 结果 ============================

-- ---- 第一节：表与列（BC1 的主体）----
select '1表' as section, 'public.balances 存在' as item,
       case when to_regclass('public.balances') is null then 'WARN' else 'INFO' end as status,
       coalesce(to_regclass('public.balances')::text, '表不存在') as actual,
       case when to_regclass('public.balances') is null
            then '小程序 GET /api/balances 会直接 500，先查是不是连错项目/连错 schema'
            else '' end as note
union all
select '1列', column_name, 'INFO',
       data_type
         || coalesce('(精度 ' || numeric_precision || ',' || numeric_scale || ')', '')
         || coalesce('(时间精度 ' || datetime_precision || ')', '')
         || coalesce('(定长 ' || character_maximum_length || ')', '')
         || ' / null=' || is_nullable
         || ' / default=' || coalesce(column_default, '∅'),
       case when column_name = 'amount'
            then 'BC1：numeric 的精度与 scale 决定金额舍入口径 → 拍 BQ6；int 则会丢小数'
            when column_name = 'app_name'
            then 'BC1：若这里出现 generated 列或 btrim 相关 default，2.12 的结论要改写'
            else '多出来的列请逐条确认是否 AI 专属（违反 S2 正本 P3 数据同构）' end
from act_cols
union all
select '1列', '期望 6 列都在', 
       case when (select count(*) from act_cols a
                  join exp_cols e on e.name = a.column_name) = 6 then 'INFO' else 'WARN' end,
       (select string_agg(e.name, ',' order by e.name) from exp_cols e
         where e.name in (select column_name from act_cols)) as actual,
       '缺哪个：后端 balances.js:22 的 select 串会直接报错（PostgREST 400）'
union all
select '1列', '无 AI 专属列（P3 同构探针）',
       case when exists (select 1 from act_cols
                         where column_name ~ '^(source|created_by|channel|origin|via|ai_|agent_)')
            then 'WARN' else 'INFO' end,
       coalesce((select string_agg(column_name, '、') from act_cols
                 where column_name ~ '^(source|created_by|channel|origin|via|ai_|agent_)'),
                 '无'),
       '若有 → 这些行只有 AI 能解释，AI 下线即成僵尸数据，违反 P2/P3'

-- ---- 第二节：约束 / 索引 / 触发器 ----
union all
select '2约束', conname, 'INFO',
       contype::text || ' / cols=' || coalesce(cols, '∅') || ' / ' || cdef,
       case when contype = 'f' then 'BC1：confdeltype 即 d5-guest-account.sql:34 说要肉眼确认的那个（n无/a限制/r restrict/c cascade）'
            when contype = 'u' then 'BC1：同名覆盖的唯一键就在这里；**若没有 (user_id,app_name) 唯一约束，BD2 的整套"先读现值"设计全部失效**'
            when contype = 'c' then 'BC1：金额/名称的行外约束有没有，全看这一节有没有行'
            else '' end
from act_cons
union all
select '2约束', '唯一键 (user_id, app_name) 存在',
       case when exists (select 1 from act_cons
                         where contype in ('u', 'p') and cols in ('user_id,app_name', 'app_name,user_id'))
            then 'INFO' else 'WARN' end,
       coalesce((select string_agg(conname || ' → ' || cols, '；') from act_cons where contype in ('u','p')), '无'),
       '后端 POST 靠 ?on_conflict=user_id,app_name（balances.js:37）。**库内若无此唯一约束，on_conflict 会 42P10 报错，同名"覆盖"根本不存在——那条 upsert 一直在报错却没人发现，就会表现为"AI 记不上"**'
union all
select '2约束', 'CHECK：金额非负',
       case when exists (select 1 from act_cons where contype = 'c' and cdef ilike '%amount%>=%')
              or exists (select 1 from act_cons where contype = 'c' and cdef ilike '%amount%>%')
            then 'INFO' else 'WARN' end,
       coalesce((select string_agg(conname || ' → ' || cdef, '；') from act_cons where contype = 'c' and cdef ilike '%amount%'), '无'),
       'BQ3：没有这条，模型送 -50 就直接进库（2.5 的暴露面之一）'
union all
select '2约束', 'CHECK：app_name = btrim(app_name)',
       case when exists (select 1 from act_cons where contype = 'c' and cdef ilike '%btrim%')
            then 'INFO' else 'WARN' end,
       coalesce((select string_agg(conname || ' → ' || cdef, '；') from act_cons where contype = 'c' and cdef ilike '%btrim%'), '无'),
       '2.12：cards 有这条（cards.sql:174-176），balances 若无 → "首尾空格的同名行"能被写进库'
union all
select '2约束', 'CHECK：名称长度上限',
       case when exists (select 1 from act_cons where contype = 'c' and cdef ilike '%length%')
            then 'INFO' else 'WARN' end,
       coalesce((select string_agg(conname || ' → ' || cdef, '；') from act_cons where contype = 'c' and cdef ilike '%length%'), '无'),
       '2.5：cards 的 icon_key 有 length>64 检查（cards.js:172-175），balances 两条都没有'
union all
select '3索引', idxname, 'INFO',
       'unique=' || indisunique::text || ' / partial=' || partial::text,
       idef
from act_idx
union all
select '4触发器', coalesce(string_agg(tgname || ' → ' || func || ' on ' || evt, '；'), '（一个都没有）'),
       case when exists (select 1 from act_trg) then 'INFO' else 'WARN' end,
       (select count(*)::text || ' 个' from act_trg),
       'BC1/2.4：若这里没有 moddatetime 类触发器，则 POST 省略 updated_at 时旧值确实会留着（BD5 第二条硬判据的依据成立）；若有，那条判据要改写'
from act_trg

-- ---- 第三节：RLS 与授权（BC4，最要紧的一节）----
union all
select '5RLS', '表已启用行级安全',
       case when (select relrowsecurity from rls_flag) then 'INFO' else 'WARN' end,
       'relrowsecurity=' || coalesce((select relrowsecurity::text from rls_flag), '∅')
         || ' / force=' || coalesce((select relforcerowsecurity::text from rls_flag), '∅'),
       'BC4：GET /api/balances 的查询串**没有 user_id= 过滤**（balances.js:22），账号隔离 100% 押在这一项上'
union all
select '5RLS', policyname, 'INFO',
       cmd || ' / ' || permissive || ' / roles=' || coalesce(roles, '∅') || ' / using=' || q || ' / with_check=' || w,
       '⚠ roles=public 意味着连 anon 都过这条策略（anon 在表上有出厂默认 SELECT），全靠 auth.uid() 返回 NULL 兜住 ⇒ 这句话的份量是"RLS 是唯一防线"，不是"还有一层权限"'
from act_pol
union all
-- ⚠ 这条判据**改版过（2026-09-25 实测之后）**。旧版写的是 `count(*) = 4`，那是把 cards 的
--   **形制**当成了判据：一条 `FOR ALL` 的策略**等价覆盖四种操作**，旧版把现网那条 ALL
--   报成了 WARN（⇒ 整个脚本最后那行「WARN 行数」当时 = 1，其实是**假 WARN**）。
--   ⇒ 判据要问「四种 cmd 覆盖了没有」，不是「有几行」。
select '5RLS', '四种操作都被 RLS 覆盖',
       case when exists (select 1 from act_pol where cmd in ('ALL','SELECT'))
             and exists (select 1 from act_pol where cmd in ('ALL','INSERT'))
             and exists (select 1 from act_pol where cmd in ('ALL','UPDATE'))
             and exists (select 1 from act_pol where cmd in ('ALL','DELETE'))
            then 'INFO' else 'WARN' end,
       coalesce((select string_agg(cmd || ':' || policyname, ' / ') from act_pol), '（一条策略都没有）'),
       '缺哪一种 cmd → 那种操作直接 42501。「一条都没有」比「少一种」严重得多（等于 RLS 形同虚设或全库可读）'
union all
select '6授权', 'authenticated 对 balances 的授权', 'INFO', (select got from grants),
       '后端转发的是**用户自己的 token**（不是 service_role），所以这里必须含 select/insert/update/delete 四项。'
         || '⚠ 读出「（无任何授权）」时先别下结论：information_schema.role_table_grants 只暴露'
         || '「grantor 或 grantee 对当前登录角色可见」的行，用非超级用户跑会因可见性为空 ⇒ 假报。'
         || '要区分"真没授权"与"看不见"，改用 has_table_privilege(''authenticated''::regrole, ''public.balances'', ''insert'') 直接问。'

-- ---- 第四节：现网数据画像（BC5 + 2.12 的脏数据探针）----
union all
select '7画像', '总行数 / 用户数', 'INFO',
       (select rows_total::text || ' 行 / ' || users::text || ' 个用户' from stats),
       '无 limit、无分页：全量 GET 的体积就是这一行（BR10）。行数无界时落点页与 structuredContent 都要按最坏情况设计'
union all
select '7画像', '单用户行数的最大 / 均值', 'INFO',
       (select max_rows || ' / ' || avg_rows from per_user),
       '决定查询接口要不要配额、落地页要不要虚拟列表'
union all
select '7画像', '按用户拆开：行数 / 0 值数 / 最大金额', 'INFO',
       (select by_user from per_user_zero),
       'BD7 的 includeZero 默认值拍板依据。全表"0 占 42%"回答不了这一问——要看**单个账号**里 0 值占多少；若某账号大半是 0，默认排除就会让 AI 少报一大截而用户看不出'
union all
select '7画像', 'amount 非数值（正则不过）',
       case when (select amt_nonnumeric from stats) = 0 then 'INFO' else 'WARN' end,
       (select amt_nonnumeric::text from stats),
       '不为 0 → 列类型很可能是 text，BD9 的合计与舍入判据全部要重来'
union all
select '7画像', 'amount 负数',
       case when (select amt_negative from stats) = 0 then 'INFO' else 'WARN' end,
       (select amt_negative::text from stats),
       'BQ3：有存量负数说明后端确实零拦截，"校验放哪层"就不是理论问题'
union all
select '7画像', 'amount 为 0', 'INFO',
       (select amt_zero::text from stats),
       '0 余额是数据不是状态（2.1）。有存量 → BD7 的 includeZero 默认值与 BD10 的 C 情形才真有区分意义'
union all
select '7画像', 'amount 带小数 / 超 2 位小数', 'INFO',
       (select (amt_fractional::text || ' / ' || amt_over_2dp::text) from stats),
       'BQ6/BD9 ①：若非 0，整数分累加的舍入口径要先定才能上合计'
union all
select '7画像', 'amount 的 min / max', 'INFO',
       (select amt_min || ' / ' || amt_max from stats),
       '顺手看一眼量级，决定展示要不要千分位（BR7：端上用 toLocaleString，skill 侧刻意不用）'
union all
select '7画像', 'updated_at IS NULL',
       case when (select upd_null from stats) = 0 then 'INFO' else 'WARN' end,
       (select upd_null::text from stats),
       '2.1：order=updated_at.desc 在 PG 默认 NULLS FIRST → 不为 0 就有行会钉在列表最前，与"按金额降序"的文字必然不符（BV47 的反例来源）'
union all
select '7画像', 'app_name 首尾带空白的行',
       case when (select name_untrimmed from stats) = 0 then 'INFO' else 'WARN' end,
       (select name_untrimmed::text from stats),
       '2.12：不为 0 → 这些行在"trim 后查同名"的口径下**查不到**，AI 会新建第二条同名。这些行需要一次数据清理，或把口径改成"不 trim"**（先清还是先改，拍完再实施）'
union all
select '7画像', 'trim 之后互相撞键的组',
       case when (select pairs from collide) = '' then 'INFO' else 'WARN' end,
       coalesce(nullif((select pairs from collide), ''), '无'),
       '同上，但这是"已经存在两组同名"的具体名单。每一组都意味着 AI 按 trim 匹配时**不知道该覆盖哪一条**'
union all
select '7画像', 'app_name 含内部空格 / 最长长度', 'INFO',
       (select (name_inner_space::text || ' / ' || name_maxlen || ' 字') from stats),
       '2.12：内部空格是合法现存量 ⇒ skill 侧只 trim 首尾、绝不折叠内部空白（V44′ 第 3 条的现实依据）'
union all
select '7画像', 'app_name 超 50 字 / 为空', 'INFO',
       (select (name_over_50::text || ' / ' || name_null::text) from stats),
       'BQ3/BQ6：名称长度上限该定在哪，看这里而不是猜'
union all
select '7画像', 'icon_key 为 null / 空串 / 超 64 字', 'INFO',
       (select (icon_null::text || ' / ' || icon_emptystr::text || ' / ' || icon_over_64::text) from stats),
       'BR2：null 是"未配置"的既有形态（手工新增也落 null）；空串不是——若存在空串说明有调用方绕过了 `|| null`'

-- ---- 第五节：给 AI 侧的结论行（把上面几节浓缩成一句可回贴的话）----
union all
select '8探针', '后端 balances.js 的四键载荷能全部落库', 'INFO',
       'app_name,amount,updated_at,icon_key + user_id(服务端注入)',
       '对照 balances.js:43-50。任一列缺失或类型不符 → 该列的既有写入路径其实一直在静默出错'
union all
select '8探针', '若下方 7画像 出现 WARN 的行，请连同其 actual 一起贴回', 'INFO',
       'WARN 行数 = ' || (
         select count(*)::text from (
           select (select amt_negative from stats) > 0 as w
           union all select (select amt_nonnumeric from stats) > 0
           union all select (select upd_null from stats) > 0
           union all select (select name_untrimmed from stats) > 0
           union all select (select pairs from collide) <> ''
           union all select not (select relrowsecurity from rls_flag)
           union all select not (
             (select exists (select 1 from act_pol where cmd in ('ALL','SELECT'))
              and exists (select 1 from act_pol where cmd in ('ALL','INSERT'))
              and exists (select 1 from act_pol where cmd in ('ALL','UPDATE'))
              and exists (select 1 from act_pol where cmd in ('ALL','DELETE'))))
           union all select not exists (select 1 from act_cons where contype in ('u','p') and cols in ('user_id,app_name','app_name,user_id'))
         ) t where w
       ),
       '8 条主判据的 WARN 计数。0 = 现网数据与 PRD v0.3 的全部假设一致；>0 = 按行号回填 BC1–BC5 并修订第二章'
order by section, item;
