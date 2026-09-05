# 生活卡包 · 库表与接口设计（依据 PRD v2.4）· v3（2026-09-02：去 indefinite、name+merchant 合并）

> 状态：v3（2026-09-02，产品裁定：**取消"永久卡"概念**——删除 `indefinite` 列
> （"无限期卡"标注无消费方；DDL 留空的物化行为本身保留，仍落"今天 + 配置 B"
> 具体日期）；**`name` 与 `merchant` 合并为单列 `name`**（展示名"商户名-卡名"
> 全称落库化，唯一键收为 `(user_id, name)`），建卡表单 / 导入解析 / 编辑删除
> 弹窗只见一个卡名字段；已部署库跑 `supabase/cards.sql` 第 0 节迁移段（幂等）。
> v2.3（2026-08-31，产品裁定合入：**商户必填**（覆盖 PRD v2.3 4-B36 的可空
> 裁定——外部扫描以"小程序名 / 网站名"作为商户、用户录入必填），merchant 去默认值、
> 三写入路径判空校验、导入行缺商户报错；新增**展示名推导**（折叠卡主标题 =
> "商户名-卡名" 拼接，纯前端推导不落库、不参与唯一键）；"空商户 + 同名合并"语义
> 与"未填商户"弱提示随之删除，预留 #9① 移除。v2.2（同日，第二轮评审合入：diff-only 提交契约立为强制前端规范
> （评审二 1.1/1.2）、导入"不能开/关次数能力"显式声明（1.3）、CF 窗口校验"今天"
> 口径 = 客户端本地日期（2.2）、追赶不加迭代上限的分析（四-1）、DELETE 理由措辞
> 修正（四-2）、起始日窗口硬约束声明（3.3）、无限期标注在续费卡上不展示（3.2）、
> 周期表示切换不重设扣款日说明（3.1）、联调 14/15、预留清单 #7–#9。
> v2.1（同日，第一轮评审合入）：4-B22 触发器补"显式设置优先"条件（评审 #1）、
> 4-B19 对齐算法钉死为确定性伪代码（#3）、4-B20 重开闸门落 CF 层预留（#2）、
> indefinite 清除规则修订（#5）、DELETE 与 PATCH 的 404 不对称显式标注（#4）、
> 仅交互层 / 仅 CF 层强制规则统一披露（第 9 节 3 重写）、新增第 12 节 CF 层预留清单。
> v2.0（同日）：按 PRD 第七章待办 1 整体简化——删除来源标记列与盖章触发器
> （cards_sync_meta）、删除冲突判定 / 采纳闸门的 RPC 逻辑与手动-导入路径 GUC 分层；
> 写入模型统一为"后写覆盖先写"（3.6.2）；保留唯一键 upsert、行级过期三分支（3.6.2）、
> 表单与服务端输入校验（4-B2 / B27 / B23）；新增**无限期物化标记**（R1，v3 已删）；
> 取消分类字段（4-I）；起始日改为手动可改（4-B3 v2 修订）。边界编号 B 指 PRD v2
> 第四章 B1–B38（v2.2 评审 R16 重编号），与 v1.x 文档的旧编号不通用）。
> SQL：`supabase/cards.sql`（Supabase SQL Editor 整体执行）；
> 共用常量：`shared/cardsConfig.js`（配置 A/B、提醒窗口、周期/静默枚举；CATEGORIES
> 随 v2 取消分类不再使用）。
> 通路完全同构 balances 模块：`functions/api/_middleware.js` 验签注入
> `data.user / data.accessToken` → PostgREST（用户 token，RLS 强制归属）。
> 云件均为免费档：Cloudflare Pages Functions + Supabase 免费实例，
> **每一类用户动作固定为 1 次 Supabase 请求**（见 1.2 请求预算）。

---

## 1. 通路总览与请求预算

### 1.1 分层

```
浏览器（React 页面）
  │  authorizedFetch（自动带 access token，401 自动刷新重试一次）
  ▼
Cloudflare Pages Functions（functions/api/cards/*）
  │  ① 验签已由 _middleware.js 完成（401/403 闸门 + user 注入）
  │  ② 校验：配置窗口（A/B，可调，DB CHECK 不承载）/ 枚举 / 次数规则（4-B2/B27/B31）
  │  ③ 剥离：不可写字段（name 改名放开见 7.3 唯一性预检）
  ▼
Supabase PostgREST / RPC（用户 token → RLS）
  cards 表（无流水表） + settle_my_cards() + import_my_cards(jsonb)
  DB 触发器仅两枚：updated_at 维护 + 4-B22 静默解除（全渠道统一）
```

### 1.2 请求预算（免费档核心约束的兑现）

| 场景 | Supabase 请求 | 路径 |
| --- | --- | --- |
| 进站（挂载 / 跨天回焦 / 轮询跨天，4-B37） | **1** | `GET /api/cards` → 转发 `rpc/settle_my_cards`，**结算与全量拉取一次完成** |
| 单卡任意操作（建卡/顺延/改次数/清零/标记用完/静默/续费开关/删卡） | **1** | `POST`·`PATCH`·`DELETE`，全部 `return=representation`，前端就地更新，**不重拉列表** |
| 批量导入提交 | **1** | `POST /api/cards/import` → 转发 `rpc/import_my_cards`，三分支 + 合并在 SQL 内完成 |
| 导入预览分类（S15：新增/更新/错误 + 过期行去向） | **0** | 前端用进站时已加载的全量快照判定（3.6.3），不查库 |
| alert 计算 / 展示分组 / 排序 / 折叠态文案 | **0** | 前端纯函数（3.3.4 结构化输出），见第 8 节 |
| 会话 alert 去重 / 跨天轮询 | **0** | 内存标志 + 本地日期比对（4-B37） |

多端一致性按 4-B32（字段级 last-write-wins，无锁、无合并 UI）；
本地状态与远端短暂不一致由下次进站的 GET 收敛。

---

## 2. 表结构 `public.cards`（对照 PRD v2）

| 列 | 类型 | PRD 出处 | 说明 |
| --- | --- | --- | --- |
| `id` | uuid pk default `gen_random_uuid()` | — | |
| `user_id` | uuid → `auth.users(id)` on delete cascade | 3.6.1 / RLS | **服务端从验签后的 token 注入**，不信任前端任何 user_id 字段（balances.js 同款） |
| `name` | text not null | 3.6.1 | **v3：卡名即展示名**（"商户名-卡名"全称直接录入，merchant 已合并）；唯一键 `(user_id, name)`；trim 由服务端做；精确匹配不合并大小写；**可经编辑弹窗改名（2026-09-02 裁定，对齐余额小程序名）**：改名是普通编辑（同 id 更新，非"变另一张卡"）；改成已有其他卡的 name → 400「已有同名卡券」（CF 层唯一性预检，见 7.3） |
| `start_date` | date not null default `current_date` | 3.1 / 4-B3 | **纯展示字段，不参与任何推导与默认值计算**；录入默认今天、可改历史；**录入后手动可改**（v2 修订，校验同配置 A）、导入可静默覆盖 |
| `end_date` | date **not null** | 3.1 / 4-B2 / 4-B5 | 核心字段；不填创建时物化为"今天 + 配置 B"（与起始日无关，最长 2 年），物化后无空值 → 状态推导单轴无特判；自动续费开启时与扣款日同步（DDL ≡ 扣款日，用户裁定 2026-09-02） |
| ~~`indefinite`~~ | — | **v3 已删** | 原 R1 无限期物化标记——"永久卡"展示概念取消后无消费方，列连同清除规则一并移除（物化行为本身保留） |
| `total_sessions` | int null，CHECK `> 0` | 3.1 / 3.4.3 | **每周期次数**（可选配置）：结算重置锚点 + "剩余 N / 共 M 次"展示锚点；null = 未配置；与 remaining 无大小关系约束（有意，累加/赠送型真实数据存在） |
| `remaining_sessions` | int null，CHECK `≥ 0` | 3.1 / 4-B31 | **null = 次数能力未开启（判据列；关闭 = 随 total 一并双 null）**；= 0 → "次数用完"展示条件（非状态、不影响循环、仅排除到期提醒） |
| `auto_renew` | bool not null default false | 3.1 / 3.4 | **循环的唯一开关**；次数对循环零影响 |
| `billing_cycle` | text null，CHECK 枚举 | 3.1 | `week/month/quarter/year`（日历语义——连续包月类）；**与 period_days 互斥：至多一个非空（CHECK `cards_cycle_exclusive`）** |
| `period_days` | int null，CHECK `> 0` | 3.1 / 3.4.2 | **合同固定天数**（"30 天月卡""365 天年卡"写合同多少是多少）；非空 → 结算按固定天数推进；空 → 按 billing_cycle 日历推进；互斥同上 |
| `next_billing_date` | date null | 3.1 | 只有开启自动续费的卡才有、才可改；与 DDL 相互独立（4-B18），顺延同推进 |
| `muted` | text not null default `'none'`，CHECK 枚举 | 3.3.2 / 4-B22 | `none / cycle / forever`；`cycle` 的自动解除 = **凡 end_date 实际变化即解除**（单枚触发器承载全部渠道，第 4 节）；`forever` 只能手动解除 |
| `created_at` / `updated_at` | timestamptz | — | `updated_at` 由 `moddatetime` 触发器维护 |

### 2.1 校验分层（为什么有些进 DB、有些留在 CF 层）

索引两个（建表语句内创建）：`cards_settle_idx (user_id, next_billing_date) where auto_renew`（结算追赶扫描专用部分索引）、`cards_user_ddl_idx (user_id, end_date)`；同名精确查找由 `cards_user_key` 唯一索引覆盖，无额外索引。

| 校验 | 层 | 出处 | 理由 |
| --- | --- | --- | --- |
| `end_date ≥ start_date` | **DB CHECK** | 4-B6 | 不变式，永不可调 |
| `auto_renew = true ⇒ 扣款日非空 且（cycle 与 period_days 恰有一个非空）` | **DB CHECK** `cards_renew_complete` | 4-B27 | 不变式；结算算法的运行前提 |
| `period_days 与 billing_cycle 至多一个非空`（无条件） | **DB CHECK** `cards_cycle_exclusive` | 3.1 | 不变式；结算"period_days 非空就用它"，若同时非空展示与算法各说各话；写入侧机械置空另一字段 |
| `remaining ≥ 0`、`total > 0`、`total 非空 ⇒ remaining 非空`（`cards_count_pair`） | **DB CHECK** | 4-B31 | 不变式；防"关闭只清 remaining"的残留态 |
| **name trim 不变式** | **DB CHECK**（导入 RPC 另在 SQL 内 trim；单条 POST/PATCH 由 CF 层 trim） | 3.6.1 | 两条写入路径对唯一键不变式的强制等级对齐 |
| 起始日窗口 `[今天−配置A, 今天]`、DDL 手动窗口 `[今天, 今天+配置B]` | **CF 层**（`shared/cardsConfig.js`） | 4-B2 / 4-B3 | **配置可调**，CHECK 无法读配置；结算推进 DDL 不受此限（长期未进站追赶不能被 CHECK 卡死）；窗口校验的"今天"= **客户端传入的本地日期**（评审二 2.2：服务器 UTC 日期在 UTC+8 的 0–8 点落后本地一天，会把"起始日 = 今天"误拒——口径见第 12 节 #8）；**结算"今天"2026-09-02 起同为客户端本地日期**（`settle_my_cards(p_today)`，与展示层同源，消除"界面已过期、结算未追赶"的错位态） |
| 扣款日窗口 `[今天, 今天+配置B]` | **CF 层，仅手动路径**（5.7 表单） | 5.7 | 导入不校验扣款日（v2 3.6.3 校验细则未列；扫描主权 + 人工通道，见第 9 节 8） |
| 分类 / 周期 / 静默枚举 | **CF 层 + 前端** | 3.1 | 可配置枚举（分类维度已随 v2 取消） |
| **次数能力开启必填 remaining > 0（手动路径：POST / PATCH 补开）**；导入路径 ≥ 0 即可（首次扫描即用完是客观事实） | **CF 层 + 前端**（DB 已有 ≥ 0 兜底） | 5.5 / 3.6.3 | 手动严格、导入宽容的路径分层（同 D14 配置窗口的理由：CHECK 无法表达路径语义） |
| **total_sessions 提供时 > 0**；**新增行只带 total 不带 remaining → 行报错** | **CF 层**（DB CHECK 兜底，但在 RPC 内才失败：无行号、整批回滚） | 3.6.3 | 可读行级报错的前置——防一行脏数据炸整批 |
| **新增行 auto_renew=true 缺（周期与 period_days 两者）→ 行报错**；**续费行扣款日一律强制 = 生效 DDL**（行内显式扣款日忽略；缺省 DDL 物化今天 + 配置 B；用户裁定 2026-09-03 二次修订）；更新行同规则，缺周期/天数仍行报错 | **CF 层（预览）**，DB CHECK 兜底 | 4-B27 / 3.6.3 | 行级报错体验；导入侧落实"DDL ≡ 扣款日"全站不变式，CHECK 防直调绕过 |
| **B23 过期卡禁开续费 / B21 续费卡禁手动顺延** | **交互层（表单置灰 + 文案，5.2/5.5/5.7）**；服务端不强制 | 4-B21 / 4-B23 | v2 删除 GUC 分层的连带决议——触发器要放行结算/导入必须以 GUC 区分路径；理由与接受面见第 9 节 3 |
| **重开/开启自动续费必须重设扣款日 + 周期**（PATCH 含 auto_renew=true ⇒ 必须同时携带 next_billing_date（≥ 今天）与周期表示之一） | **CF 层（预留，第 12 节）**；DB CHECK 只兜"最终态非空" | 4-B20 / 评审 #2 | "重开必须重设"是跃迁语义，静态 CHECK 表达不了（B19 待结算态的扣款日合法地 < 今天）；依赖"PATCH 只带要改的字段"契约（auto_renew 仅在开关变化时携带）；导入路径不适用（更新行缺失 → 保留现值放行，手动严格/导入宽容同则）；直调绕过归入第 9 节 3 接受面 |
| 过期行三分支（判死/跳过/插入） | **导入 RPC 内实现**（前端预览同规则） | 3.6.2 | 全产品唯一的行级条件；落库与预览同则 |
| DDL 物化 | **CF 层（POST，按配置 B 计算）/ 导入 RPC（兜底 2 年）** | 4-B5 | 创建时不填 → 物化为"今天 + 配置 B"，与起始日无关；v3 起不再记录物化标记 |

---

## 3. RLS

四条策略（select / insert / update / delete）全部 `user_id = auth.uid()`，
与 balances 的归属模型一致；middleware 已排除匿名与 recovery 态。
`user_id` 由 CF 层从 token 注入 + RLS `with check` 双重保险。

---

## 4. 触发器（仅两枚）

1. `cards_touch_updated_at`：`moddatetime` 扩展维护 `updated_at`（行级时间，
   清单"最后更新"类展示用）。

2. `cards_muted_reset`（**4-B22 静默自动解除，全渠道统一规则**）：
   BEFORE UPDATE 行级触发器——三个条件同时满足才重置 `'none'`：
   `muted = 'cycle'`、`end_date` 实际变化（`is distinct from`）、
   **`muted` 未被本语句显式设置**（`new.muted is not distinct from old.muted`）。
   - **解除渠道不限**（4-B22）：手动顺延（PATCH / POST 覆盖）、结算追赶、
     导入推进周期日期共用这一枚触发器——v1 按渠道分写（PATCH/导入 RPC/结算 RPC
     各写一处）+ GUC 跳过 `cards_sync_meta` 的方案整体废除。
   - 例行扫描写同值不触发（`is distinct from`）；方向不分支（扫描校正提前
     同样解除——周期变短更要提醒）；`'forever'` 不受影响（只能手动解除；
     重新静默是一次点击）。
   - **显式设置优先（评审 #1）**：同一请求里"顺延 + 显式设为本周期静默"
     （如顺延弹窗带静默勾选）是用户的明确意图，不得被自动解除吞掉——
     PostgREST PATCH / merge-duplicates 只 SET payload 携带的列，结算 / 导入
     RPC 的 UPDATE 也不含 muted，故 `new.muted = old.muted` 通常等价于
     "本次写入没碰静默开关"。**该判断原理上无法区分"未传"与"传了同值"**
     （评审二 1.1）——DB 取 PRD 4-B22 的默认方向（解除；宁可多提醒，重新
     静默是一次点击），"已是 cycle 还想保持"的场景由前端 diff-only 契约
     排除（7.3 强制规范），不在 SQL 层猜测意图（CF 快照盲，同样无法判等）。
     未来若引入全量行客户端需重新评估此条件。
   - 卡自然过期不产生写库、无需解除（已过期卡本就被提醒排除）；顺延重新激活时
     `end_date` 变化 → 解除。
   - 手动只改 `next_billing_date` 不解除——v2 统一规则锚定 end_date（PRD 4-B22
     字面：DDL 被顺延即恢复）。

---

## 5. 结算 RPC `settle_my_cards()`（PRD 3.4.2 的 SQL 实现）

- **调用**：`GET /api/cards` 内以用户 token `POST /rest/v1/rpc/settle_my_cards`
  （body `{ p_today: 客户端本地日期 }`），`security invoker` → RLS 生效；
  **返回全量行**（setof cards）→ 结算与拉取一次请求。
- **算法对照**：只选 `auto_renew AND next_billing_date < p_today` 的行
  （**不检查次数**，3.4.1；另含"周期表示非空"的防御性条件——4-B14 缺周期形态
  不结算不提醒；`p_today` 缺省回退 DB current_date）；`while 扣款日 < 今天`
  逐周期推进，**两个日期在同一循环内同步推进**（追赶 + 4-B18 相对差保持）；
  有每周期次数锚点 → 次数重置（3.4.2）；无锚点 → 次数保持（4-B17）；
  `muted='cycle'` 随 end_date 变化由触发器解除（4-B22）。
- **两类周期两种算法（3.4.2）**：`period_days` 非空（合同固定天数类）→ 恰好推进
  period_days 天，无钳制、无漂移；`period_days` 为空（自然日历类，连续包月）→
  按 billing_cycle 日历推进（月 = +1 日历月，逐周期钳制——锚点收缩是显式接受的
  行为，联调必测断言）。两表示互斥由 DB CHECK 保证。
- **追赶以当下的周期值推算整个缺口**——周期在缺口内被更替时真实轨迹无法重放，
  显式接受（3.4.2 已知取舍）；与商户真实周期的偏差由扫描主权持续纠正。
- **幂等**：重跑无副作用（4-B32）。
- **追赶迭代不加防御性上限（评审二 四-1）**：迭代次数上界 ≈ 缺席天数 ÷ 周期天数，
  plpgsql 千次级日期算术循环成本可忽略，不加"500 次封顶 + 跳到今天重设"式兜底——
  那会引入 3.4.2 之外的第二条收敛路径，破坏精确追赶语义与幂等性。若要防
  `period_days=1` 的病态扫描数据，护栏放 CF 导入校验（period_days 下限，
  第 12 节 #9 可选预留），不放结算。
- **4-B19 落地（评审 #3 钉死算法，消除"对齐"歧义）**——结算单卡片段的确定性伪代码：

  ```
  -- 主循环（保持相对差，3.4.2 不变）
  N := 0
  while next_billing_date < 今天:
      next_billing_date += 1 周期
      end_date          += 1 周期          -- 同步推进，相对差原样保持
      N += 1

  -- B19 收尾对齐（一次性赋值，非循环）
  if end_date < next_billing_date:          -- 相对差倒挂：DDL 落后于扣款日（非"追赶不够"）
      end_date := next_billing_date         -- 本周期已扣款，资格截止日至少延展到本次扣款日
  ```

  三个关键点：① 判断条件是 `end_date < next_billing_date` 而非 `end_date < 今天`
  ——主循环保持的相对差若本来就是 DDL 落后（用户曾把扣款日改到 DDL 之后），
  追赶结束后依然落后，该条件精确命中"B19 相对差异常"；② 对齐是**赋值**而非
  "继续按周期推进 end_date 直到追上"——后者要引入第二个收敛条件不明的循环，
  赋值幂等、一次到位，且把相对差归零到规范关系（自动续费卡常态 DDL = 扣款日，S5）；
  ③ 只在真发生过追赶（N > 0）时可能触发，正常卡（end_date ≥ next_billing_date）
  判断恒假，不影响联调测试 3/4/11 的断言。

---

## 6. 导入 RPC `import_my_cards(p_rows jsonb)`（PRD 3.6.2 / 3.6.3 落库段）

- **调用**：`POST /api/cards/import`，body `{ rows: [...] }`；CF 层逐行校验
  （第 7.5 节清单）后转发 RPC；**返回全量行** → 前端就地替换列表，无第二次请求。
- **行级过期三分支（3.6.2，全产品唯一的行级条件）**：
  行判定过期 = 行内 DDL < 今天（行缺 DDL 不判过期——新增时走物化默认，必为有效）。

  | 行判定 | 库内状态 | RPC 动作 |
  | --- | --- | --- |
  | 行有效 | 没有 | 新增（缺字段取默认） |
  | 行有效 | 有 | 覆盖更新（仅行内携带的字段，缺失保留现值） |
  | 行判定过期 | 库内正常 | **更新**（判死落库——扫描主权，明示接受） |
  | 行判定过期 | 库内已过期 | **跳过**（无操作） |
  | 行判定过期 | 库内没有 | **插入**（记录已结束的卡，4-B4） |

  预览与落库同规则——前端 S15 的过期行去向标注（将更新为过期 / 跳过 / 新增过期记录）
  就是这张表；RPC 内实现同样的分支，防绕过前端直调时预览与结果分叉。
- **缺失字段语义（3.6.3）**：payload 行对象**只带要写的字段**（键缺失 = 保留现值；
  显式 json null 视同缺失，**CF 层在转发前剥离 null 值键**）；已存在同名卡走逐字段
  `coalesce` 更新；**新增**缺失取默认（起始日 → 今天、DDL → 今天 + 2 年且与起始日
  无关、auto_renew → 关；带 remaining → 次数能力开启，数据驱动创建）。
- **JSON null 语义不对称（显式声明，评审二 1.3）**：PATCH 里显式 null = 关闭
  次数能力（用户结构操作，4-B31）；导入路径 null 被 CF 剥离 = 字段缺失 =
  保留现值——**导入通道既不能开启也不能关闭次数能力**（与 4-B31"机器不得擅自
  恢复"对称：机器同样不得擅自关闭），能力开关只能经手动 PATCH。两个相邻端点
  对同一 JSON 形状语义相反是刻意的，维护时不要"顺手统一"。
- **trim 与匹配**：RPC 内对 name 的**匹配与写入都做 trim**（3.6.1 唯一键
  不变式；DB CHECK 与 RPC 的 trim 均只处理 ASCII 空格——两处字符集已收敛
  一致，v3.1；NBSP、全角空格等 Unicode 空白由应用层 JS trim 处理），
  CF 层判空也按 trim 后的值。
- **4-B27 合并态校验（功能评审 2026-08-31 #1；用户裁定 2026-09-03 修订）**：
  resolved 续费为开（行内值 ?? 库内现值）而**合成后**缺周期/合同天数时，UPDATE
  必撞 `cards_renew_complete` 且**整批回滚**——JS 预览（classifyImport）与 RPC 内
  raise 按同一规则行报错，防"预览显示成功、落库整批失败"。**扣款日一律强制 =
  生效终止日期**（行内 DDL > 库内 DDL > 物化默认今天 + 配置 B；行内显式扣款日
  忽略，diff 如实显示旧 → 新）——落实"自动续费卡 DDL ≡ 扣款日"全站不变式
  （2026-09-02 定不变式，2026-09-03 二次裁定导入路径强制对齐）。
- **4-B31 互动（次数字段组打包忽略）**：次数能力未开启（remaining IS NULL）的卡，
  更新行的 remaining 与 total **打包在一起**忽略（只带 total 的行同样忽略，不因
  coalesce 产生"total 非空 + remaining 空"撞 `cards_count_pair` CHECK 而炸掉整批）；
  新增行携带 remaining → 能力随之开启。
- **周期表示互斥**：行内同时携带 billing_cycle 与 period_days → RPC 拒绝
  （CF 预览已行报错，这里兜底——不拒绝会被双向置空清洗把两表示都洗掉）；
  写入任一非空表示时**机械置空另一字段**（`cards_cycle_exclusive` 的实现手段；
  这不是"工具用 null 清空字段"——显式 null 剥离规则不变，清洗只与"写入非空表示"
  联动，属系统不变式写入）。v2 无"表示切换冲突"概念（3.6.2 无冲突判定）：
  扫描带来另一种表示 = 普通更新，直接落库 + 清洗。
- **原子性**：整个 RPC 一个事务，任一行失败整批回滚并返回明确原因——客户端提交前
  已逐行校验，正常不会触发；宁可整批失败也不落半批脏数据。
- **预览与落库的双实现一致性（评审 part三-2）**：批内合并 / 三分支在 JS
  （classifyImport）与 SQL（本 RPC）各自实现、无共享代码——实现时预留一组两侧
  都跑的**黄金测试数据**（建议 `shared/cardsImportFixtures.js`：覆盖同名合并、
  缺失保留、三分支、互斥清洗、4-B31 打包忽略），任何一侧改动必须双跑通过，
  防"预览显示 A、落库变成 B"的静默分叉。见第 12 节预留清单。
- **导入不触发结算、不触发 alert**（3.7 / 4-B29）：提醒在下次进站统一计算。

---

## 7. API 契约（functions/api/cards/*，四个文件）

所有请求经 `_middleware.js`（401/403 闸门）；错误响应统一 `{ error: string }`，
Supabase 透传错误（含 CHECK message）原样返回给前端展示。

### 7.1 `GET /api/cards` → 进站加载（S3/S4/S5/S7/S16）

```
请求：无参数（全量返回；排序/筛选全部前端做，5.1）
转发：POST {SUPABASE_URL}/rest/v1/rpc/settle_my_cards        ← 1 次 Supabase 请求
响应：200 [ { …卡行 snake_case… }, … ]（结算后的全量行）
失败：502/400 透传；GET 层无自有错误（结算失败走会话级轻提示，3.3.3 / 5.8 非阻塞降级）
```

### 7.2 `POST /api/cards` → 单条添加（S1；同名 = 覆盖，3.6.1）

```
请求体（表单字段；允许部分字段——merge-duplicates 冲突更新时未携带字段保留现值）：
{ name, start_date?, end_date?,                          // v3：卡名即展示名；end_date 缺失 → CF 物化"今天+配置B"
  total_sessions|null, remaining_sessions|null,         // null = 次数能力关闭（显式写空）
  auto_renew, billing_cycle|null, period_days|null,     // 周期信息二选一（3.1 互斥）
  next_billing_date|null, muted? }
转发：POST /rest/v1/cards?on_conflict=user_id,name
      Prefer: resolution=merge-duplicates,return=representation   ← 1 次
服务端职责：
  · name trim；user_id 注入；字段白名单
  · end_date 缺失 → 物化 end_date = 今天 + 配置 B（4-B5；v3 起不再记录物化标记）；
    续费开启时未显式携带 end_date → 跟随扣款日（DDL ≡ 扣款日，2026-09-02 裁定）
  · 互斥清洗：带 billing_cycle 非空 → 同请求置空 period_days；反之亦然；
    两者同填 → 400
  · 校验：起始日 ∈ [今天−配置A, 今天]、DDL ∈ [起始日, 今天+配置B]（4-B2/B3）、
    扣款日 ∈ [今天, 今天+配置B]（5.7）、枚举（billing_cycle/muted）、
    次数开启必填 remaining > 0（5.5）、total 提供时 > 0、
    auto_renew=true ⇒ 扣款日必填 + 周期二选一（4-B27，CHECK 兜底）
  · B23（过期卡禁开续费）与 B21（续费卡禁手动顺延）由表单/交互层承载（置灰 +
    文案，5.5/5.7），服务端不强制——理由见第 9 节 3
响应：201 [ { …落库后的行… } ]（PostgREST 201 Created 原样透传，前端按 2xx 处理）
```

> v1 的"全量行由快照合成"契约随来源盖章一起废除：merge-duplicates 的冲突更新
> 只 SET payload 携带的列，未携带字段（muted 等）自动保留现值——与导入
> "缺失保留现值"同义，客户端不再需要合成全量行。

### 7.3 `PATCH /api/cards/:id` → 全部单卡变更（S6/S9/S10/S11/S12 前置/S16）

```
请求体（部分字段，只带要改的）：
{ start_date? }                    // 起始日手动可改（v2 4-B3 修订），校验同配置 A
{ end_date? }                      // 顺延（非自动续费卡——B21 置灰；"关续费+顺延"组合合法）
{ remaining_sessions?, total_sessions? }
                                   // 改次数/清零/标记用完（= 改 0）；显式 null = 关闭
                                   // 次数能力（4-B31）——关闭时两个字段必须一并传 null
                                   //（CHECK cards_count_pair：total 非空而 remaining
                                   //  为空是 DB 拒绝的非法态）
{ auto_renew?, billing_cycle?, period_days?, next_billing_date? }
                                   // 续费开关与周期信息；互斥清洗同请求（带一种非空
                                   //  表示 → 服务端置空另一种；同填 → 400；把唯一表示
                                   //  清空且卡在续费中 → cards_renew_complete 拒绝透传）；
                                   //  auto_renew=true（开启/重开）必须同时携带扣款日 +
                                   //  周期——4-B20，CF 预留校验（第 12 节，评审 #2）
{ muted }                          // 静默（'none'|'cycle'|'forever'；三态图标点击循环 =
                                   //  连续 PATCH { muted: 下一档 }，档位序列
                                   //  提醒→周期→永久→提醒（非续费卡两态），
                                   //  2026-09-03 裁定，5.4 / 5.3 alert 同则）
转发：PATCH /rest/v1/cards?id=eq.{id}  Prefer: return=representation      ← 1 次
服务端职责：
  · 字段白名单：name 可改（2026-09-02 裁定放开，对齐余额）——trim 后判空 → 400；
    **唯一性预检**：目标名与库内该用户其他卡重名 → 400「已有同名卡券」（CF 层
    预检可读报错，防直改撞唯一键返回不可读的 23505；改成本卡现名 = 无操作不携带）
  · 互斥清洗同 POST（一次 PATCH 写两字段，请求预算不变）
  · 校验：提供的日期在配置窗口内（4-B2/B3、5.7 扣款日）、次数规则（4-B31；
    total 提供时 > 0）、B27 由 CHECK 兜底
  · muted='cycle' 的顺延解除由 cards_muted_reset 触发器按 end_date 实际变化执行
    （4-B22；PATCH 只改 next_billing_date 不解除）；同一请求显式设置 muted 优先
    于自动解除（第 4 节，评审 #1）
  · B21 / B23 由交互层置灰承载，服务端不强制（第 9 节 3）
  · 【CF 预留，评审 #2】重开/开启闸门（4-B20）：PATCH 含 auto_renew=true ⇒ 必须
    同时携带 next_billing_date（≥ 今天且 ≤ 今天+配置B）与周期表示之一，任一缺失
    → 400「重开自动续费需重新填写扣款日与周期」。依赖"PATCH 只带要改的字段"
    契约（auto_renew 仅在开关变化时携带）；导入路径不适用（更新行缺失 → 保留
    现值放行，手动严格 / 导入宽容）；直调绕过归入第 9 节 3 接受面
响应：200 [ { …更新后的行… } ]；404 = 不属于该用户或不存在（RLS 过滤后 0 行）
```

> **强制前端规范：PATCH 只提交变更字段（diff-only）（评审二 1.1/1.2，【交互预留】）**。
> 静默开关、续费开关只在状态变化时携带；顺延弹窗如带"本周期静默"勾选，仅当勾选
> 结果与当前静默状态**不同**时才携带 muted（不回显当前态）。这条规范承重两处
> 服务端行为：① `cards_muted_reset` 的"显式设置优先"（携带即意图，评审 #1）；
> ② 上面【CF 预留】的重开闸门（携带 auto_renew=true 即开启动作，评审 #2）。
> 违反它的两类后果——该解除的不解除（同值回显被当"未触碰"）、不该拦的被拦
> （整表单重发 auto_renew 被当"重开"）——DB 与 CF 都兜不住：触发器无法区分
> "未传"与"传同值"，CF 快照盲无法判等。联调用例见第 10 节 14。
>
> **已开续费的卡仅切换周期表示**（月 ↔ 季 / cycle ↔ period_days，不碰 auto_renew）
> 不触发重开闸门、不要求重设扣款日（评审二 3.1）——下一次结算以新步长从旧锚点
> 推进，日期可能跳变（良定义、幂等）；交互上建议切换表示时提示"是否同步更新
> 扣款日"（可选增强，第 12 节 #9）。

### 7.4 `DELETE /api/cards/:id` → 删卡（S12）

```
转发：DELETE /rest/v1/cards?id=eq.{id}  Prefer: return=representation   ← 1 次
响应：200 { ok: true, removed: 0|1 }（幂等删除——删除语义本身不需要区分
      "不存在"；removed 计数让"传错 id"可见（removed: 0，前端可提示
      "卡不存在或已删除"）而非静默假成功）
      ⚠ 与其他端点故意不对称（评审 #4）：PATCH/GET 对"不存在 / 不属于该用户"
      返回 404，DELETE 返回 200 { removed: 0 }——前端错误处理不要照抄
      "404 = 资源不存在"的通用模式；联调时这不是 bug（跨用户可见性由 RLS
      保证，与响应码无关）
```

### 7.5 `POST /api/cards/import` → 批量导入提交（S2/S15）

```
请求体：{ rows: [ { name, …仅带要写的字段… }, … ] }
        （前端已完成：解析、错误剔除、三分支预览——3.6.2/3.6.3；无冲突组）
转发：POST /rest/v1/rpc/import_my_cards                        ← 1 次
      body = JSON 数组（CF 层已剥 null 值键并逐行校验，3.6.3）：
      · trim 后判空（缺卡名 → 行报错）
      · 起始日 ∈ [今天−配置A, 今天]（配置 A）；DDL ∈ [起始日, 今天+配置B]（配置 B）
      · 行内同时携带 billing_cycle 与 period_days → 行报错
      · 新增行 auto_renew=true 缺扣款日，或缺（周期与 period_days 两者）→ 行报错（4-B27）；
        更新行缺失周期/扣款日 → 保留现值放行，**前提为合成态完整**——解析为续费开而
        合成后（行内值 ?? 现值，含互斥清洗）缺扣款日/周期 → 行报错（功能评审
        2026-08-31 #1；RPC 内 raise 兜底，防整批回滚）
      · 行内 total_sessions 提供且 ≤ 0 → 行报错
      · 新增行只带 total 不带 remaining → 行报错（cards_count_pair 的可读前置）
      · 新增行携带 remaining → 次数能力随之开启；更新行携带 remaining 而能力未开启
        → 宽容忽略（预览标注，4-B31）
      · auto_renew=false 携带扣款字段 → 宽容忽略不报错（4-B26）；auto_renew 缺失
        → 默认关（仅新增）
      · 过期行去向标注（3.6.2）：行 DDL < 今天 → 将更新为过期 / 跳过（库内已过期）/
        新增过期记录
响应：200 [ …导入后的全量行… ]（前端就地替换列表；成功 notice 汇报
      「新增 N / 更新 N / 跳过 N」，计数来自前端预览分类）
失败：400 行级错误 / CHECK message 透传 → 整批未落
```

### 7.6 场景 → 端点映射

| 场景 | 端点 | 备注 |
| --- | --- | --- |
| S1 单条添加 | POST /api/cards | 同名时前端预提示"将覆盖"（快照可知，零请求）；未携带字段保留现值 |
| S2/S15 批量导入 | POST /api/cards/import | 预览分类零请求（快照）；三分支在 RPC 内实现 |
| S5/S7 顺延结算 | GET /api/cards（进站自动） | 无专门"结算"按钮 |
| S6 取消续费 | PATCH { auto_renew:false } | 扣款日/周期字段保留（4-B20） |
| S9 清零/标记用完 | PATCH { remaining_sessions:0 } | 沉底/提醒效应由前端推导（4-B10） |
| S10 手动顺延 | PATCH { end_date }（非续费卡） | 续费卡由前端先置灰（4-B21）；静默解除由触发器（4-B22） |
| S11 静默 | PATCH { muted } | 三态图标点击循环同端点（提醒→周期→永久→提醒；非续费卡两态，2026-09-03） |
| S14 DDL 留空 | POST（end_date 缺失由 CF 物化）/ 导入由 RPC 物化 | 之后扫描再缺 DDL → 保留现值不刷新（3.6.3） |
| S16 用完撞扣款窗口 | 无请求 | 前端推导：次数用完只排除到期提醒（4-B10） |

---

## 8. 前端推导契约（交互实现阶段的纯函数模块）

`src/lib/cardsDomain.js`（无任何请求，输入全量行 + 今天，输出展示/提醒）：

```js
// 单卡视图：PRD 3.2 状态与展示条件 + 3.3.1 窗口与排除 + 3.3.4 结构化输出
deriveCardView(row, today) => {
  // v3：无 displayName 推导——row.name 即展示名（merchant 已合并）；
  status: 'active' | 'expired',                 // 唯一状态轴（今天 > end_date）
  displayGroup: 'normal' | 'sunk',              // 沉底：expired 或 次数用完（相互独立于提醒）
  sunkReason: null | 'expired' | 'used_up',     // 灰卡文字（5.4：已过期 / 已用完）
  daysToDdl,                                    // end_date − today
  daysToBilling,                                // next_billing_date − today（仅 auto_renew）
  reminders: {
    expiring: { deadline, daysLeft } | null,    // 排除：expired、次数用完、静默
    billing:  { deadline, daysLeft } | null,    // 排除：expired、静默（次数用完不排除）
  },
}

// 折叠态右侧主信息（5.4"取当前最紧要的一项"）：
// ① 两类提醒都命中 → 取 deadline 更近者（扣款与到期同日时取扣款——钱的事更紧要）
// ② 单一命中 → 对应文案（billing「{date} 扣款」/ expiring「剩 N 天」）
// ③ 次数用完 → 「已用完」（命中扣款窗口时追加独立小标签，4-B12）
// ④ 其余 → 「剩 N 次」（带次数）/「剩 N 天」
// （复核 2026-08-31 #4：本注释原写法是"billing 恒优先"，与 PRD 5.4 正文矛盾，
//  代码按正文实现；已改为与正文一致的措辞，防止按旧注释"修"出真 bug）

buildAlert(views, sessionAlertShown) => alert 模型 | null   // 会话去重在调用方（内存标志）

// 预览分类（S15）：v2 无冲突组——一切差异都是"更新"，每组行带 3.6.2 三分支去向
// （update | update_to_expired | skip_expired | insert_expired）与「字段 | 旧值 → 新值」对照
classifyImport(rows, loadedCards, today) =>
  { creates, updates, errors }
```

推导常量全部来自 `shared/cardsConfig.js`（窗口天数、配置 A/B、周期/静默枚举），
前后端零口径分叉。

---

## 9. v2 简化决议与边界（从 v1.13 收敛而来，实现时请知悉）

1. **写入模型统一（3.6.2）→ 来源机制全删**：`source_*` 四列 + `source_*_at` 四列、
   `cards_sync_meta` 触发器、两个 RPC 内的盖章逻辑、详情页"来源小字"全部删除。
   一切操作都是更新操作——单条添加、单条编辑、批量导入、结算四条写入路径完全同则，
   后写覆盖先写，无来源区分、无优先级、无冲突判定、无逐条确认；不记录任何
   "写入来源"字段或标记（3.6.2 字面）。
2. **冲突判定 / 采纳闸门全删**：v1 的无条件冲突（标志翻转、周期表示切换）、
   B40 行级闸门与"周期缺失行级口径"等采纳闸门逻辑全部删除——预览只有
   新增/更新/错误三组（5.6），人工核对发生在预览区的一次性核对里（S15）。
3. **仅交互层 / 仅 CF 层强制、DB 不兜底的规则全集（统一披露；评审 part三-3 要求
   一视同仁，不再只列 B21/B23）**。v1 用 DB 触发器（cards_guard）+ 路径 GUC 实现
   部分闸门的服务端强制并放行结算/导入两个 RPC；v2 删除手动-导入路径 GUC 分层后，
   无条件触发器会拦死结算核心循环，二者不兼容，故触发器整体删除。DB 不兜底的
   规则与直调绕过的后果一次性列全——
   - **B21 续费卡禁手动顺延**（前端置灰，5.2/5.7）：直调可破坏相对差——结算算法
     对相对差不作假设，4-B18/B19 对齐兜底，功能不坏；
   - **B23 过期卡禁开续费**（前端置灰，5.5/5.7；POST 覆盖"维持"依赖客户端识别）：
     直调可写出"续费中 + 过期 DDL"——B19 式状态本就是合法瞬态，结算自愈；
   - **4-B20 重开/开启必须重设扣款日 + 周期**（CF 层校验，预留见第 12 节；评审 #2
     方案 A）：DB 的 cards_renew_complete 只兜"最终态非空"，不校验"是新设的"——
     直调 `PATCH { auto_renew: true }` 可借用陈旧扣款日重开，结算追赶把它拉回
     当前周期（过去的扣款日自愈；离谱未来扣款日属第 9 节 8 的暴露面），功能不坏
     但可能有"我明明关了怎么又提醒"的短暂困惑。DB 层不能加
     `auto_renew=true ⇒ next_billing_date ≥ 今天` 的 CHECK——会把 B19 待结算
     中间态（扣款日合法地 < 今天）整行堵死，连改个次数都会被拒；
   - **次数开启 remaining>0、total>0、配置窗口 A/B、扣款日窗口、枚举**（CF 层，
     2.1 表已列）：直调可落库值域合法但未经产品校验的数据；
   - **导入路径的对应豁免**（扫描行按 3.6.2 直接落库，更新行缺失保留现值放行）
     是上述每条"手动严格 / 导入宽容"分层的另一侧——PRD 明示（4-B23 / v2.1 R3
     裁定"不另设闸门"，风险由人工核对兜住）。
4. **category 列删除（4-I）**：不做分类维度、不做用户配置；`shared/cardsConfig.js`
   的 CATEGORIES 不再使用（文件不动，配置 A/B、提醒窗口、BILLING_CYCLES、
   MUTED_MODES 继续生效）。
5. **indefinite 列已删（v3，2026-09-02）**：原 R1 无限期物化标记——"永久卡"
   展示概念取消后（建卡文案改"不填 = 最长 2 年"）无任何消费方，列连同 v2.1
   评审 #5 的清除规则一并移除；DDL 留空的物化行为本身保留（仍落"今天+配置B"
   具体日期），仅不再区分"物化来的"与"填写的"。
6. **物化默认与配置 B 的耦合**：POST 物化在 CF 层按配置 B 计算；导入 RPC 的兜底
   物化取硬编码 2 年（配置 B 初始值，SQL 内有 CHANGE NOTE）——调整
   `DDL_MAX_HORIZON_YEARS` 时需同步改 SQL 默认值（免费档取舍：配置极少调整）。
7. **起始日可改（4-B3 v2 修订）**：PATCH/POST 放开 start_date（校验同配置 A）；
   v1 的"CF 剥离 start_date（手动不可改）"废除。卡名 v3.1（2026-09-02）起可经编辑弹窗改名（唯一性预检见 7.3），原 4-B3"卡名不可改"裁定作废。
8. **扣款日的导入上界校验未进 v2**：v1 库表评审加入的"导入行扣款日 > 今天+2 年
   → 行报错"未出现在 v2 3.6.3 校验细则，随简化移除（手动路径窗口保留在 5.7
   表单校验）。已知暴露面：导入带来离谱未来扣款日 → 扣款提醒永不开窗——
   由预览区旧 → 新对照人工兜住；如需恢复是 CF 层一行改动。
9. **POST 部分字段契约**：merge-duplicates 的冲突更新只 SET payload 携带的列，
   未携带字段保留现值（与导入"缺失保留现值"同义）。v1 因来源盖章要求
   "全量行合成"，随盖章删除一并废除。
10. **B22 单枚触发器**：v1 的解除逻辑分散在 PATCH（7.3）、POST 覆盖
   （cards_sync_meta）、导入 RPC（日期变化判断）、结算（追赶循环内）四处并依赖
   GUC 跳过；v2 统一为"end_date 实际变化即解除"（4-B22 字面），单枚触发器
   承载全部渠道，规则只有一处、无渠道打架问题。手动只改扣款日不解除是
   该统一规则的直接结果（v1 的不对称讨论不再适用）。同一语句内**显式设置
   muted 优先于自动解除**（评审 #1：第三条件 `new.muted is not distinct from
   old.muted`）——"顺延 + 顺手设静默"不被吞。前提 = diff-only 提交契约
   （7.3 强制规范）；同值回显场景 DB 按 4-B22 解除——宁可多提醒（评审二 1.1）。
11. **保留不动的机制**：唯一键 upsert（`cards_user_key` + merge-duplicates）、
   结算双算法与追赶幂等、`cards_renew_complete` / `cards_cycle_exclusive` /
   `cards_count_pair` / trim CHECK、RLS 四策略、请求预算（每类动作 1 次请求）。
12. **起始日回溯窗口是硬约束（评审二 3.3，已知取舍）**：配置 A 同时约束手动与
   导入——真实开卡早于 `[今天−配置A]` 的老卡（如用了 5 年的健身年卡）永远无法
   把起始日改成真实值，只能填窗口内近似值。起始日纯展示、不参与推导（3.1），
   影响仅显示准确性；护栏优先于记录真实性，放宽只调配置 A，不改校验结构。
13. **商户必填（产品裁定 2026-08-31，覆盖 PRD v2.3 4-B36 的"可空有意"）**——
   **v3（2026-09-02）已进一步演变为商户列合并**：外部扫描以"小程序名 / 网站名"
   作为商户产出，v2.4 曾将 merchant 设为必填独立列；v3 将其并入 name（展示名
   "商户名-卡名"全称直接落库），唯一键收为 `(user_id, name)`。原 4-B7"同商户
   同卡种多条并存合并"语义由全称卡名天然承载；迁移规则见 `supabase/cards.sql`
   第 0 节（合并去重按 updated_at 保留最新）。

---

## 10. 联调必测清单

1. **merge-duplicates 覆盖**：同名 POST 两次 → 合并为一条；第二次未携带 muted
   → 库内 muted 保留现值（部分字段契约）；携带显式 null 的次数字段 → 能力关闭；
   POST 卡名 trim 后为空 → 400、导入行卡名 trim 后为空 → 行报错（v3：卡名即
   展示名，无独立商户字段，原 v2.4"缺商户报错"断言随之作废）。
2. **三分支**：行过期 + 库内正常 → 更新为过期（判死落库）；行过期 + 库内已过期
   → 跳过；行过期 + 库内没有 → 插入过期记录（4-B4）；行有效 → 正常 upsert。
3. **固定天数追赶**：period_days=30 的卡、1/31 锚点、追赶 3 个周期 → 扣款日
   3/2 → 4/1 → 5/1，每步恰好 +30 天（无钳制、无漂移）。
4. **日历追赶**：billing_cycle=month 的连续包月卡、1/31 锚点、追赶 3 个周期 →
   2/28 → 3/28 → 4/28（逐周期钳制、锚点收缩是显式接受的行为，3.4.2）。
5. **4-B19 对齐（评审 #3 断言版）**：卡 `end_date=2026-06-01`（已过期）、
   `next_billing_date=2026-09-01`（未到期——B19 状态：DDL 落后扣款日 3 个月）、
   `period_days=30`（或 billing_cycle='month'，本例数值恰好一致）。today=2026-09-15
   进站结算：主循环推进 next_billing_date → 2026-10-01（N=1），end_date 同步
   +1 周期 → 2026-07-01；此时 end_date < next_billing_date → 对齐 →
   end_date := 2026-10-01。断言最终 end_date = next_billing_date = 2026-10-01
   （不是继续按周期推进出的任何其他值）。
6. **4-B22 触发器**：muted='cycle' + 任意路径改 end_date（PATCH 顺延 / POST 覆盖 /
   导入 / 结算）→ muted='none'；同值重发不解除；'forever' 不动；只改
   next_billing_date 不解除；**同请求 PATCH { end_date, muted:'cycle' }（原为
   'none'）→ muted 保持 'cycle'——显式设置优先，不被自动解除吞掉（评审 #1）**。
7. **4-B31 打包忽略**：次数能力关闭的卡 + 导入行只带 total_sessions → 整批成功、
   字段被忽略（不撞 cards_count_pair CHECK）；新增行只带 total → 行报错。
8. **DDL 留空物化（v3：无 indefinite 断言）**：POST 缺 DDL → end_date = 今天+2 年；
   导入新行缺 DDL 同断言；之后导入再缺 DDL → 保留现值不刷新；PATCH 改 DDL
   无标记联动（列已删）。
9. **互斥清洗**：已有 billing_cycle 的卡 + 导入行带 period_days → 落库后
   period_days=30 且 billing_cycle IS NULL，结算按固定天数推进；行同时带两表示
   → 行报错、整批未落；PATCH 带 billing_cycle → 返回行 period_days 为空。
10. **4-B27 CHECK 兜底**：绕过前端直调 RPC，新增行 auto_renew=true 缺扣款日 →
    整批拒绝、CHECK message 透传（CF 预览已行报错，此处防直调）。
11. **结算幂等**：同一张追赶卡连续两次进站 → 第二次空操作；无每周期次数锚点 →
    次数保持（4-B17）；有锚点 → 重置为锚点值（3.4.2）。
12. **B21/B23 边界确认（接受面验证，非缺陷）**：直调 PATCH 对续费卡改 end_date、
    直调 POST 新建"过期 + 续费中"卡均可落库（服务端不强制，第 9 节 3）；
    前端两处置灰（5.5 建卡 / 5.7 开关）为唯一拦截层。直调
    `PATCH { auto_renew:true }` 不带新扣款日 → 亦落库成功（DB CHECK 只查非空，
    借用陈旧扣款日，结算自愈——第 9 节 3 接受面）。
13. **重开重设闸门（评审 #2，CF 预留项）**：卡关闭自动续费（扣款日保留为旧值，
    可能已在过去）→ CF 层实现后：PATCH { auto_renew:true }（不带新扣款日/周期）
    → 400「重开自动续费需重新填写扣款日与周期」；PATCH { auto_renew:true,
    next_billing_date:未来, billing_cycle:'month' } → 200 正常重开；导入行翻转
    auto_renew=true 不带扣款日 → 现值完整时放行、现值为空时行报错（3.6.3 保留
    现值 + 功能评审 #1 合并态校验，见用例 16）。
    CF 实现前直调落库成功 = 第 9 节 3 接受面，不是 bug。
16. **4-B27 合并态校验（功能评审 2026-08-31 #1，JS 预览 + SQL RPC 双实现）**：
    库内"续费关 + 扣款字段全空"的卡 + 导入行翻转 auto_renew=true 不带扣款日 →
    预览行报错、RPC raise「自动续费为开但扣款信息不完整」（旧行为是静默放行、
    落库时 UPDATE 撞 cards_renew_complete 整批回滚）；库内"续费关但现值完整"
    的卡同样翻转 → 放行（保留现值）。黄金用例见 shared/cardsImportFixtures.js
    两个同名条目（npm run test:cards）。
14. **diff-only 提交契约（评审二 1.1/1.2，前端强制规范的服务端行为确认）**：
    ① muted 已 'cycle' + PATCH { end_date, muted:'cycle' }（同值回显）→ DB 层
    解除为 'none'（4-B22 宁可多提醒；该请求在 diff-only 契约下不应出现——
    顺延弹窗勾选仅在 none→cycle 时携带）；② muted 为 'none' + PATCH
    { end_date, muted:'cycle' } → 保持 'cycle'（显式设置优先）；③ 已开续费卡
    仅改周期（diff-only：{ billing_cycle:'quarter' }）→ 不触发重开闸门、
    不要求重设扣款日。
15. **窗口校验"今天"口径（评审二 2.2，CF 预留项）**：UTC+8 用户本地 0–8 点提交
    start_date = 本地今天 → 通过（CF 用客户端传入的本地日期，而非服务器 UTC
    的"昨天"）；导入 RPC 内的行判定过期 / 物化默认仍用 DB current_date，
    与前端预览的边界偏差 ≤1 天（4-B8 同款接受）。

---

## 11. 明确不做（对齐 PRD v2 边界）

- 无流水表 / 无 archived 状态列 / 无软删除（3.0：终结只有过期与删除）；
- 无 cron、无后台任务（结算 lazy，3.3.3）；
- 无金额字段（1.3）；无时长字段（1.3）；无卡组/商户实体（4-B35/B36）；
- **无分类字段**（4-I）；**无来源标记列**；**无冲突判定 / 采纳闸门**（3.6.2）；
- 无路径 GUC、无 B21/B23/重开重设的 DB 强制（第 9 节 3；CF 层预留见第 12 节）；
- CHECK 不承载配置窗口与可配置枚举（4-B2/B3，配置在 `shared/cardsConfig.js`）。

---

## 12. CF 层预留清单（functions/api/cards/* 实现时的强制项）

> 以下规则本文档（第 7 节契约）已定稿、SQL 已按可 DB 化的部分落地，剩余部分属
> CF 层 / 前端逻辑，随后台实现落地——逐项标记，防遗漏（评审 part三）。
>
> **2026-08-31 实测状态**（wrangler:8788 + Supabase 真库端到端）：#1、#2、#3（行内
> 规则）、#6、#7、#8 已在 CF 层实现并通过 E2E 验证（含 B20 重开闸门、B22 显式设置
> 优先、无限期物化、商户必填、B27/B31、结算幂等、DELETE 不对称）；#4 的 JS 侧
> `scripts/test-cards-domain.mjs` 21 例通过，SQL 侧双跑待 `import_my_cards` 建立后
> 进行；#5 为发布前检查项；#9 可选项未排期。另实测确认：POST 落库响应为 PostgREST
> **201 Created**（7.2 已同步），PATCH 为 200、PATCH 无可写字段 → 400「没有可更新的
> 字段」（防御性行为）。

| # | 预留项 | 规则 | 出处 |
| --- | --- | --- | --- |
| 1 | **重开/开启续费闸门** | PATCH 含 `auto_renew: true` ⇒ 必须同时携带 `next_billing_date`（≥ 今天且 ≤ 今天+配置B）与 `billing_cycle`/`period_days` 之一；缺失 → 400「重开自动续费需重新填写扣款日与周期」。依赖"PATCH 只带要改的字段"契约；POST 的同则校验已在 7.2（auto_renew=true ⇒ 扣款日 + 周期） | 4-B20 / 评审 #2 |
| 2 | 配置窗口与枚举校验 | 起始日/DDL/扣款日窗口（配置 A/B）、billing_cycle/muted 枚举、次数开启 remaining>0、total>0 | 2.1 / 7.2 / 7.3 |
| 3 | 导入逐行校验 + null 值键剥离 | 7.5 清单中**行内规则**（两表示互斥、total ≤ 0、日期窗口等）在 CF 层；依赖"新增 vs 更新"与库内现值的规则——新增行 B27、只带 total 行报错、4-B27 合并态校验——由 JS 预览（classifyImport，黄金用例覆盖）+ SQL RPC 兜底承载：CF 不查库（1.2 请求预算），直调绕过前端时得到的是 RPC 整批回滚的可读报错而非 CF 行级报错（复核 2026-08-31 #4 确认为架构性折衷，非预留缺口） | 7.5 / 3.6.3 |
| 4 | 黄金测试数据（双跑） | 批内合并 / 三分支在 JS（classifyImport）与 SQL（import_my_cards）双实现——预留 `shared/cardsImportFixtures.js`，两侧改动必须双跑通过，防"预览 A、落库 B"静默分叉 | 第 6 节 / 评审 part三-2 |
| 5 | 配置 B ↔ SQL 物化默认同步检查 | 调整 `DDL_MAX_HORIZON_YEARS` 时同步 `cards.sql` 的 `interval '2 years'`（两侧注释已互指）——加入发布前检查项 | 第 9 节 6 / 评审 part三-1 |
| 6 | DELETE 不对称的前端认知 | DELETE 200 { removed: 0 } vs PATCH/GET 404——前端错误处理按端点区分，不照抄通用 404 模式 | 7.4 / 评审 #4 |
| 7 | **diff-only 提交契约（前端强制规范）** | PATCH/POST 只提交变更字段：静默 / 续费开关仅在状态变化时携带；顺延弹窗静默勾选不回显当前态。承重 `cards_muted_reset` 的"显式设置优先"与预留 #1 重开闸门——违反即产生 1.1（该解除不解除）/ 1.2（不该拦被拦）两类静默错误 | 7.3 / 评审二 1.1、1.2 |
| 8 | **窗口校验"今天"口径** | CF 层日期窗口校验用**客户端传入的本地日期**（请求携带 `today`，ISO yyyy-mm-dd；护栏校验，伪造仅自伤）；**结算 RPC 2026-09-02 起同口径**（`p_today`，与展示层同源——DB current_date 是 UTC，曾致 UTC+8 本地 0–8 点"界面已过期、结算未追赶"的错位态）；导入 RPC 内部仍用 DB current_date（≤1 天偏差，4-B8） | 2.1 / 评审二 2.2 / 2026-09-02 |
| 9 | 可选交互增强（两项合并） | ① 已开续费卡切换周期表示时提示"是否同步更新扣款日"；② CF 导入校验加 period_days 下限（如 ≥ 7）防病态扫描数据 | 评审二 3.1 / 四-1 |
