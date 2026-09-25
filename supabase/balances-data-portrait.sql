-- ============================================================================
-- balances-data-portrait.sql · 余额表现网数据画像（**只读**，兜底小版本）
--
-- 与 balances-schema-check.sql 的关系：大版本要读 pg_trigger / pg_policies /
-- information_schema 等一堆系统目录，任何一处的列类型或位义与预期不符就整批失败
-- （已实测栽过一次：`pg_trigger.tgtype` 是 smallint 位掩码，不是 char ⇒ 22P02）。
-- 本小版本**只查 balances 自己**，不碰任何 pg_* 目录 ⇒ 结构上不可能再踩目录版本坑。
--
-- 用途：大版本报错时的兜底；或只想先看数据画像拍 BQ3 / BQ6。
-- 它直接回答四个问题：
--   · 金额有没有负数、有没有非数值、小数位超不超 2 位   → BQ3 校验要不要加、BQ6 舍入口径
--   · 名称有没有首尾空白、有没有 trim 后互相撞键的组     → 2.12 / BD7′ / V44′
--   · 有没有 updated_at IS NULL                        → 2.1 的 NULLS FIRST 会不会真咬到
--   · 单用户行数多大                                   → BR10 要不要配额
--
-- 跑法：Supabase SQL Editor 整体执行，13 行结果，整份贴回。
-- ============================================================================

with amt as (
  select id, user_id, app_name, amount, updated_at, icon_key,
         -- 先转文本再过正则，脏值不参与数值聚合：万一 amount 是 text 且含脏数据，
         -- 直接 ::numeric 会让整条查询报错，而这脚本的价值恰恰是"一次跑完拿全"
         case when amount::text ~ '^(-?[0-9]+(\.[0-9]+)?|-?\.[0-9]+)$'
              then (amount::text)::numeric end as n
  from balances
),
s as (
  select
    count(*)                                          as 总行数,
    count(distinct user_id)                           as 用户数,
    count(*) filter (where n is null)                 as 金额非数值,
    coalesce(min(n)::text, '∅')                       as 金额最小,
    coalesce(max(n)::text, '∅')                       as 金额最大,
    count(*) filter (where n < 0)                     as 金额为负,
    count(*) filter (where n = 0)                     as 金额为零,
    count(*) filter (where n > 0 and n <> trunc(n))   as 金额带小数,
    count(*) filter (where n is not null and (n * 100) <> trunc(n * 100))
                                                      as 小数超两位,
    count(*) filter (where updated_at is null)         as 更新时间为空,
    count(*) filter (where app_name is null)           as 名称为null,
    count(*) filter (where app_name <> btrim(app_name)) as 名称带首尾空白,
    count(*) filter (where app_name <> regexp_replace(app_name, '\s+', '', 'g'))
                                                      as 名称含内部空格,
    coalesce(max(length(app_name))::text, '∅')        as 名称最长,
    count(*) filter (where length(app_name) > 50)      as 名称超五十字,
    count(*) filter (where icon_key is null)           as 图标未配置,
    count(*) filter (where icon_key is not null and icon_key = '')
                                                      as 图标空串,
    coalesce(max(length(icon_key))::text, '∅')        as 图标键最长
  from amt
),
per_user as (
  select coalesce(max(c)::text, '∅') as 单人最多行, coalesce(avg(c)::numeric(10,1)::text, '∅') as 单人均值
  from (select user_id, count(*) as c from amt group by user_id) u
),
collide as (
  select coalesce(string_agg(k, '；' order by k), '（无）') as 撞键组
  from (
    select user_id::text || ' / [' || btrim(app_name) || '] ×' || count(*)::text as k
    from amt where app_name is not null
    group by user_id, btrim(app_name)
    having count(*) > 1
  ) t
)

-- ============================ 结果 ============================
select '规模' as 节, '总行数 / 用户数' as 项,
       (select 总行数::text || ' / ' || 用户数::text from s) as 值,
       '全量 GET 无 limit ⇒ 这个体积就是每次读取的载荷（BR10）' as 备注
union all
select '规模', '单人最多行 / 均值', (select 单人最多行 || ' / ' || 单人均值 from per_user),
       '决定查询接口要不要配额、落地页要不要虚拟列表'
union all
select '金额', '非数值行数', (select 金额非数值::text from s),
       '不为 0 ⇒ amount 列类型很可能是 text，BD9 的合计与舍入判据要重来'
union all
select '金额', '负数 / 零', (select (金额为负::text || ' / ' || 金额为零::text) from s),
       '有负数 ⇒ 后端确实零拦截，BQ3 不是理论问题；零值行数决定 BD7 的 includeZero 与 BD10 的 C 情形'
union all
select '金额', '带小数 / 超两位小数', (select (金额带小数::text || ' / ' || 小数超两位::text) from s),
       '不为 0 ⇒ 合计必须先定舍入口径（BQ6 / BD9 ①），否则模型会把浮点尾巴逐字念给用户'
union all
select '金额', 'min / max', (select (金额最小 || ' / ' || 金额最大) from s),
       '看量级；展示格式两侧刻意不同（端上 toLocaleString，skill 固定口径），见 BR7'
union all
select '时间', 'updated_at IS NULL', (select 更新时间为空::text from s),
       '不为 0 ⇒ PG 的 ORDER BY ... DESC 默认 NULLS FIRST，这些行会钉在列表最前，与"按金额降序"的文字必然不符（V47 的反例来源）'
union all
select '名称', '为 null 的行', (select 名称为null::text from s),
       '不为 0 ⇒ 库里已有 app_name 为空的行，说明某条写入路径绕过了必填'
union all
select '名称', '首尾带空白', (select 名称带首尾空白::text from s),
       '2.12 的直接检验：不为 0 ⇒ 按 trim 匹配会查不到这些行 ⇒ AI 会新建第二条同名，需要一次数据清理或改口径'
union all
select '名称', '含内部空格', (select 名称含内部空格::text from s),
       '合法现存量 ⇒ skill 侧只 trim 首尾、不折叠内部空白（V44′ 第 3 条的现实依据）'
union all
select '名称', 'trim 后互相撞键的组', (select 撞键组 from collide),
       '每一组都意味着 AI 按 trim 匹配时不知道该覆盖哪一条'
union all
select '名称', '最长 / 超五十字', (select (名称最长 || ' / ' || 名称超五十字::text) from s),
       'BQ6 的名称长度上限看这里而不是猜'
union all
select '图标', '未配置 / 空串 / 键最长',
       (select (图标未配置::text || ' / ' || 图标空串::text || ' / ' || 图标键最长) from s),
       'null 是"未配置"的既有形态（手工新增也落 null，BD5 必须原样带回）；**空串不是**——若不为 0 说明有调用方绕过了 `|| null`'
order by 节, 项;
