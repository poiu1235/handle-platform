# 便签墙 · PRD（v2）

> 页面名：便签墙（Notes Wall）· 路由 `/app/notes`
> 一句话：像贴便利贴一样把备忘贴上一面「墙」，每张贴纸可挂一个**精确到分钟**的提醒，
> 可勾选完成后划线保留；数据存云端，同账号多设备打开看到同一面墙——**「便利贴 + 日程提醒」**。
> 结构与命名对照 `lifestyle-cardpack-prd-v3.md` / `cards-db.md`；视觉规范完全沿用
> `design-language.md`（token、字体、圆角、z-index 表）。
> 本版（v2）按「推翻重新设计」流程产出：从需求重新推导，再与 v1
> （`notes-wall-prd-v1_bak.md`）对比取优，差异清单见 〇.2。

---

## 〇、已裁定的产品决策

### 〇.1 决策表（2026-09-06，与用户确认）

| # | 决策点 | 裁定 |
| --- | --- | --- |
| D1 | 提醒触达 | **页面开着才提醒**：站内提醒卡 + 浏览器系统通知 + 提示音；页面没开而错过的提醒进站补列**不补铃**。服务端推送（关着页面也提醒）的完整方案本版成文（附录 A），实施留 V2 |
| D2 | 完成态 | **要有**：`status = active / done`；完成 = 正文划线 + 整卡变淡、**留在原位**；桌面用「已完成」过滤片查看，支持一键清除全部已完成 |
| D3 | 手机形态 | **<720px 首屏「今日视图」**：今天到期/已到点的便签列表（可勾完成、可开编辑），「查看整面墙」进入横滚白板。桌面仍是一整面墙 |
| D4 | 便签摆放 | **自由拖拽 + 6 列网格吸附**；位置 = 抽象格坐标落库，跨设备分辨率无关 |
| D5 | 多端同步 | **进站先渲缓存快照再全量拉取 + 可见时 45s 轮询 + 操作乐观更新**，不引入 Realtime 长连接；冲突 LWW；新增**同步状态指示**，让「多端同步」可感知 |
| D6 | 提醒规则 | **一次性 + 简单重复（每天/每周）**；到点未确认保持醒目态，**确认时**推进下一次 |
| D7 | 编辑形态 | **弹窗编辑**（新建 = 编辑复用），不做双击就地编辑 |
| D8 | 完成与提醒交叉 | **完成优先于重复**：便签被勾完成后不再提醒、不再推进；完成隐含「确认」当次到点 |

### 〇.2 与 v1 的对比取优

**保留（重新推导后结论不变）**：轮询同步 + LWW（D5）、自由拖拽网格吸附 + 6 列固定
坐标系（D4）、提醒调度器架构（setTimeout 精确唤醒 + 30s 兜底 + 回焦巡检）、错过补列
不补铃、确认后推进重复、6 色拟物便签 + 哈希倾斜不落库、diff-only PATCH、弹窗编辑、
JIT 申请通知权限、多标签页去重。

**新增 / 修正**：

1. **完成态 status**（v1 无）——含视觉、过滤片、批量清除、与重复提醒的交叉语义（D2/D8）。
2. **手机今日视图**（v1 手机 = 整墙横滚，横向找便签成本高）——今日分组纯函数与桌面
   「今天」过滤片同源，口径永不漂移。
3. **同步状态指示点 + localStorage 快照秒开**——「多端同步」从后台行为变成可感知卖点。
4. **`notesDomain` 从 `src/lib` 提升到 `shared/`**——V2 的 Cron Worker 必须复用同一个
   `advance()`，否则两端推进语义漂移。
5. **V2 扫描索引方向修正**：cron 按**时刻**全表扫（`remind_at` 部分索引），不是 v1 的
   `(user_id, remind_at)`——Worker 不按用户扫。
6. **新增 `last_fired_at` 字段**（V1 即落库、前端触发时即写）——V2 Worker 幂等去重靠它，
   上线时零迁移。
7. **附录 A 明确 V2 载体：独立 Cron Worker**——Cloudflare Pages Functions 不支持
   cron triggers，不能给本项目 wrangler.toml 加 trigger。

---

## 一、产品概念与信息架构

- 核心实体只有一张便签，七个动词：**贴**（新建）、**写**（编辑）、**挪**（拖拽换位）、
  **撕**（删除）、**勾**（完成/恢复）、**设**（提醒）、**看**（墙 / 今日）。
- 独立路由 `/app/notes`：画布式布局与 Hello 的列表式三标签（余额/会员/优惠券）结构冲突，
  不进标签页。入口：Hello 右下角 FAB 菜单新增「便签墙」项；页面左上角「← 返回」回 `/app`。
- 会话模型与 cards 相反：notes 数据自包含在本路由，store 初始化由页面组件挂载触发，
  不挂 App 根（不与其他路由共享数据）。

## 二、页面布局

### 2.1 桌面（≥720px）

1. **头部**：深蓝渐变横带（同管理端）：眉题 `NOTES WALL`（uppercase 1.5px 字距）+
   标题「便签墙」+ 右侧**同步状态点**（● 已同步 / ◐ 同步中 / ○ 离线，点击立即拉取）+
   提示音开关（铃铛图标，静音态持久化 localStorage `notes-muted`）+「← 返回」。
2. **工具行**：过滤分段胶囊「全部 / 今天 / 已完成」（默认全部，计数徽章，样式对照
   cards 分段控件）+ 右侧「清除已完成」文字链（仅存在已完成便签时出现，二次确认）。
   「今天」= 今日到期或已到点未确认的 active 便签。
3. **错过提醒条**（条件渲染）：进站/轮询发现「到点未确认」便签时，顶部显示
   `--au-brand-soft` 品牌浅蓝信息条「有 N 条到点的提醒」→ 展开列出，逐条或
   「全部知道了」确认。
4. **墙主体**：抽象网格 **6 列 × N 行**，格距 16px、格宽 ~176px（板宽 ~1136px）；
   背景 `--au-bg` 保持扁平，不画软木纹理（拟物只给便签本体）。便签墙是画布页，
   **不受 `--bd-col` 560px 限宽约束**（头部仍对齐 gutter）。空态：板中央灰字
   「还没有便签，点右下角 + 贴一张」。
5. **FAB**：右下角 56px「+」（z-index 1010，沿用 board.css）→ 打开编辑弹窗。
6. **弹窗层**（z-index ≥1020）：便签编辑弹窗、删除确认弹窗、提醒卡（5.1）、通知权限说明。

### 2.2 手机（<720px）：今日视图

- **首屏**：深蓝头部（同管理端，日期作 hero 副行「9月6日 周日 · N 条今天」）+ 分组列表：
  1. **已到点**（提醒时刻已过、未确认、未完成）——橙红强调，动作同错过条；
  2. **今天稍后**（今天 00:00 后到期）；
  3. **已完成**（status=done 的便签，默认折叠）。
  无提醒且未完成的便签**不进**今日视图（保持「今日」聚焦）。
  列表项 = 色条 + 正文 + 提醒胶囊 + 勾选圆钮；点项开编辑弹窗。
- 底部并排两个 ghost 胶囊：「查看整面墙」「+ 贴一张」。整面墙 = 桌面同构 6 列板，
  空白处拖动 = 平移板子、拖便签 = 移动便签（pointerdown 命中便签即移动、命中板面即
  平移，天然不冲突），水平滚动。
- 断点切换：`matchMedia('(max-width: 719.9px)')` 切换渲染分支，store 共享，不做两套数据。

## 三、便签视觉规格

- **底色 6 色枚举**（柔和便利贴色，深色文字 `--au-text` 保证对比度）：
  `yellow #FFF6A3` / `pink #FFD9E0` / `blue #CFE8FA` / `green #D9F2D9` /
  `orange #FFE3C2` / `purple #E8DDF5`。默认 `yellow`。
- **微倾斜**：`hash(id) % 5` 确定性映射到 `-2°, -1°, 0°, 1°, 2°`——**不落库**，
  多端渲染同一 id 自然一致。
- **胶带**：卡片顶部中间一条半透明白色渐变斜贴（伪元素），唯一拟物元素；
  阴影用克制的 `0 2px 6px rgba(0,0,0,0.12)` + hover 加深。
- **卡片内容**：正文自动换行，超出 4 行截断 + 省略；页脚两行 =
  提醒胶囊 + 相对时间（「3 分钟前更新」）。
- **提醒胶囊**：无提醒不显示；有提醒显示 `🔔 今天 14:30`（今天）→ `🔔 周三 09:00`
  （7 天内）→ `🔔 9月20日 09:00`（更远显示日期）；**到点未确认**时胶囊变橙红底闪烁、
  卡片微晃（`prefers-reduced-motion` 时只保留颜色，不晃）。
- **完成态**：正文 line-through、整卡 `opacity: .55`、提醒胶囊隐藏、页脚第二行变
  「已完成」灰字；**位置不动**——贴过的地方就是它的历史。
- 交互：点击 → 编辑弹窗；拖拽（位移 > 8px 判定，抑制 click）→ 移动。

## 四、便签编辑弹窗（新建 = 编辑）

- 字段：
  1. 正文 textarea（1–500 字，trim 后非空，计数显示）；
  2. 颜色：6 色圆点单选；
  3. **提醒开关** + 展开区：
     - `datetime-local` 原生控件（**分钟精度**，移动端拉起系统选择器）；
     - 快捷 chips：「今晚 20:00」「明天 09:00」「后天 09:00」（点击填充，可继续改）；
     - 重复：`不重复 / 每天 / 每周` 胶囊单选，默认不重复；
  4. 编辑态附加动作：「标记完成 / 恢复为未完成」文字钮、「删除」（红色文字链，
     二次确认弹窗）；
  5. 保存 / 取消；保存时 diff-only 提交（见七）。
- 关闭提醒 = 显式清空 `remind_at` + `repeat_rule` 回 none（PATCH 传 null，
  禁止用缺省表达清空）。
- **通知权限 JIT**：用户第一次保存带提醒的便签时才申请 Notification 权限
  （just-in-time，不在页面加载时打扰）；被拒绝则只做站内提醒，不反复打扰。

## 五、提醒系统（核心）

### 5.1 触发循环（前端调度器）

- store 维护「最近一次未来 `remind_at`」（仅 status=active 参与计算），
  `setTimeout(至该时刻)` 精确唤醒；**兜底每 30s 巡检**一次（防时钟休眠/轮询刷新导致
  计划漂移）；`visibilitychange` 回焦立即巡检。
- 到点判定：`remind_at <= now` 且 `last_fired_at < remind_at`。触发时**先本地写
  `last_fired_at = now`**（V2 幂等键从 V1 起就有真实数据，见附录 A）并执行：
  1. **站内提醒卡**（顶部居中，z-index 1020，**不自动消失**，必须用户动作）：
     正文 + 时间 + 三个动作——**「知道了」**（确认）/ **「稍后提醒」**（+10 分钟）/
     **「打开」**（进编辑弹窗）；同时多条到点时聚合为「N 条到点」，逐条动作 +
     「全部知道了」；
  2. **浏览器系统通知**（点击通知聚焦本 tab）；
  3. **提示音**：WebAudio 两音清脆短音，无音频资产依赖；随头部静音开关关闭。
- **多标签页去重**：系统通知发出前查 localStorage `notes-fired`
  （`noteId → 触发时刻`，10 分钟窗口），本 tab 未见过该 id 才发系统通知；
  站内提醒卡各 tab 独立显示（与 cards 多 tab 各自独立口径一致）。
- 确认 = PATCH `reminded_at = now`；重复便签在确认时推进下一次（5.3）。未确认期间
  便签保持「到点未确认」醒目态，不会静默溜走。

### 5.2 错过的提醒（页面没开时到点）

- 进站/每次轮询合入数据后，凡 `remind_at <= now` 且未确认且 active 的，进
  **错过提醒条**（2.1.3）/ 今日视图「已到点」组；**不补发系统通知、不响铃**——
  补响会变成打开页面就被轰炸，违背 D1 的轻量定位。
- 用户逐条「知道了」/「全部知道了」后：`reminded_at = now`，重复便签直接推进到
  下一次未来时刻（5.3）。

### 5.3 重复推进算法（`shared/notesDomain.js` 纯函数，可测）

```
advance(remind_at, rule, now):
  next = remind_at
  while next <= now: next += 1天 | 7天        // daily | weekly
  return next   // 循环上限 1 万次，防脏数据死循环
```

- 触发/错过后**不立即推进**，等用户确认（知道了/打开/勾完成）时推进。
- 「稍后提醒」：`remind_at = now + 10min`（保留 repeat_rule）；重复便签贪睡后
  以下一次确认为推进基点，允许小幅基点漂移（可接受，记录在此）。
- 该函数自 v2 起放 `shared/`，V2 Cron Worker import 同一实现（〇.2.4）。

### 5.4 完成与提醒交叉（D8）

- status=done 的便签**不参与调度、不进错过条**；「标记完成」若当次已到点未确认，
  一次 PATCH 同时写 `status='done'` + `reminded_at=now`。
- 重复便签被完成 = 整个循环终止（不再推进）；「恢复为未完成」不回溯任何提醒，
  恢复后若 `remind_at` 已成过去时，走 5.2 错过条（不补铃）。

### 5.5 时区与精度

- `remind_at` 落库 `timestamptz`，客户端用本地时区写入/展示；多端各自本地渲染，
  不存在跨时区换算争议。分钟精度 = `datetime-local` 原生保证。

## 六、数据模型（supabase/notes.sql，风格对照 cards.sql）

```sql
create table public.notes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  content       text not null check (trim(content) <> '' and char_length(content) <= 500),
  color         text not null default 'yellow'
                check (color in ('yellow','pink','blue','green','orange','purple')),
  pos_x         int  not null default 0 check (pos_x between 0 and 999),
  pos_y         int  not null default 0 check (pos_y between 0 and 999),
  status        text not null default 'active' check (status in ('active','done')),
  remind_at     timestamptz,                      -- null = 无提醒
  repeat_rule   text not null default 'none'
                check (repeat_rule in ('none','daily','weekly')),
  last_fired_at timestamptz,                      -- 最近一次触发/派发时刻（V2 幂等键，V1 前端触发即写）
  reminded_at   timestamptz,                      -- 最近一次用户确认时刻
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.notes enable row level security;
create policy notes_owner on public.notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index notes_user_pos on public.notes (user_id, pos_y, pos_x);
create index notes_remind_scan on public.notes (remind_at)
  where remind_at is not null and status = 'active';  -- V2 cron 全表按时刻扫描（〇.2.5）
```

- **位置 = 抽象格坐标 (pos_x, pos_y)**，不是像素——网格吸附天然成立，且跨设备
  分辨率无关（6 列恒定，窄屏水平滚动）。
- **不做 (user_id, pos_x, pos_y) 唯一约束**：拖拽交换需要两行同时改，唯一约束
  会把「交换」变成两步操作引入中间态冲突；占用冲突由前端螺旋吸附算法规避（8.2），
  极端并发下允许暂时重叠，轮询可见后用户随手拖开即可。
- `updated_at` 由触发器维护，冲突语义 = **后写覆盖先写**（LWW，与 cards 同口径）。
- 每用户上限 **200 条**（API 层校验，防板子无限膨胀）。

## 七、API 契约（functions/api/notes.js + functions/api/notes/[id].js）

沿用 cards 的中间层模式：`_middleware.js` 已验签并把 access token 放进 `data`，
本层只做白名单/枚举/长度校验，RLS 兜底数据归属。

| 方法 | 路径 | 语义 | 返回 |
| --- | --- | --- | --- |
| GET | `/api/notes` | 全量拉取 | 行数组 |
| POST | `/api/notes` | 新建（内容/颜色/坐标/提醒） | `Prefer: return=representation` 单行 |
| PATCH | `/api/notes/:id` | **diff-only** 部分更新（编辑/移动/确认/贪睡/推进/完成切换） | 单行 |
| DELETE | `/api/notes/:id` | 撕掉 | 204 |

- PATCH 提交契约沿用 cards：**只传变化字段**，未携带字段保留现值（关闭提醒这类
  「清空」必须显式传 null，禁止用缺省表达清空）。
- PATCH 字段白名单：`content / color / pos_x / pos_y / status / remind_at /
  repeat_rule / reminded_at / last_fired_at`。
- 校验：content 1–500 trim；color、repeat_rule、status 枚举；pos 0–999 整数；
  remind_at 可解析 ISO 时间戳（**允许过去时刻**——重复推进由 5.3 处理；
  一次性规则下贴一张「已经错过的备忘」也是合法输入，落站后走错过条）。
- POST 时该用户 notes 计数 ≥ 200 → 409。

## 八、前端架构（对照 cards 模块）

| 文件 | 职责 |
| --- | --- |
| `shared/notesConfig.js` | 颜色枚举、网格常量（6 列/16px）、字数上限、贪睡分钟数、条数上限、快捷 chips 规则 |
| `shared/notesDomain.js` | 纯函数：advance()、到点判定、提醒胶囊文案、相对时间、findFreeCell 螺旋搜索、hashTilt、今日分组 |
| `src/lib/notesStore.js` | 模块级 store（useSyncExternalStore）：rows/status/syncState/message；loadNotes / upsertLocal / removeLocal / 轮询 / 快照缓存 / 提醒调度器 |
| `src/pages/NotesBoard.jsx` | 页面：头部/工具行/提醒条/墙（桌面 + 手机整墙）/今日视图/FAB/弹窗 |
| `board.css` 追加 `nt-` 前缀段 | 便签墙全部样式（不新建 css 文件，沿用管理端样式集中策略） |
| `scripts/test-notes-domain.mjs` | notesDomain 纯函数测试（npm script `test:notes`，对照 test-cards-domain 模式） |

### 8.1 同步与乐观更新（D5）

- **进站**：先渲染 localStorage 快照 `notes-snapshot-v1`（rows + fetched_at，
  超 7 天弃用）实现秒开，随后 GET 全量合入并刷新快照。
- 此后**页面可见时每 45s 轮询**（`visibilitychange` 隐藏即停，回焦立即拉一次）
  ——同口径 cards 会话控制器。
- 用户操作（新建/编辑/删除/移动/确认/完成）= **本地先改 + 单请求**，响应以
  `return=representation` 回写，不二次拉列表（对照 cards 请求预算）；请求失败
  toast 报错、本地保留不回滚（不建离线队列，V1 取舍，见九.9）。
- 拖拽中便签**冻结轮询合入**：轮询回来的行更新其余便签，正在拖拽那张以本地为准
  （防止手指下的卡片瞬移）。
- **同步状态点**：`同步中`（请求未归）/ `已同步`（最近成功 < 90s）/ `离线`
  （失败，点击重试）——「多端同步」是卖点，必须可感知，不能只是后台噪音。

### 8.2 拖拽与吸附（D4）

- Pointer Events 统一鼠标/触摸；按下位移 > 8px 进入拖拽（并抑制 click）。
- 松手 → 落到**最近的空闲格**：从目标格起螺旋搜索第一个空格
  （`findFreeCell` 纯函数，可测）；新建便签落点 = 第一空格（同一函数）。
- 移动落定 = 本地 upsert + 一次 PATCH `{pos_x, pos_y}`。

### 8.3 今日视图分组（D3，手机）

- 分组纯函数 `groupToday(rows, now)`：已到点（remind_at<=now、未确认、active）→
  今天稍后（remind_at 在今天内）→ 已完成（status=done，默认折叠）。
  与桌面「今天」过滤片**同一函数**，口径永不漂移。
- 无提醒且 active 的便签不出现在今日视图；看全部走「查看整面墙」。

### 8.4 提醒调度器（见 5.1，实现位在 store）

- store 持有最近 remind_at，`setTimeout` 精确触发 + 30s 兜底巡检；
  触发即写 `last_fired_at` 并入「到点队列」驱动提醒卡；确认/贪睡/推进/完成
  各是一次 PATCH。

## 九、边界与已知取舍（记录，不阻塞）

1. **重复「每月」不做**：月末钳制（31 日 → 2 月 28 日）有语义争议，V1.1 再议。
2. **贪睡导致重复基点漂移**：见 5.3，接受。
3. **两设备同时移动同一张便签**：LWW，后者覆盖；位置是低价值数据，可接受。
4. **两设备占同格**：无唯一约束（见六），轮询后表现为暂时重叠，用户拖开即可。
5. **系统通知依赖权限与浏览器策略**：iOS Safari 需添加到主屏幕才支持通知
   ——站内提醒卡永远是主通道，系统通知是增强。
6. **页面休眠（笔记本合盖）**：回来时走 5.2 错过提醒条，不补铃。
7. **后台标签页节流**：Chrome 对后台 tab 定时器钳到 ≥ 1 次/分钟——对「分钟精度」
   恰好够用；30s 兜底 + 回焦巡检双保险。
8. **本地时钟漂移不做校准**：V1.1 可用响应 `Date` 头估算偏移后再议。
9. **45s 轮询窗口内他端改动延迟可见**：便签不是聊天，回焦即拉已覆盖绝大多数
   「拿起来看」场景；不为此引入长连接。
10. **恢复已完成便签**：不回溯任何提醒；过去时 remind_at 走错过条（5.4）。

## 十、分期

- **V1（本 PRD）**：以上全部（含完成态与手机今日视图——本轮裁定提前进 V1）。
- **V1.1（低成本追加）**：每月重复；便签搜索；空板双击快速新建；服务器时间校准。
- **V2（附录 A，本版成文）**：服务端提醒——独立 Cron Worker + Web Push（可选邮件），
  页面/浏览器没开也能准点提醒。

## 附录 A · V2 服务端提醒方案（本版成文，暂不实施）

### A.1 载体：独立 Cron Worker

- **Cloudflare Pages Functions 不支持 cron triggers**，且项目保持 Pages 托管不变
  → V2 新增**独立 Worker**：仓库内 `cron-worker/` 目录（独立 `wrangler.toml`，
  `triggers.crons = ["* * * * *"]`，`wrangler deploy` 单独发布），与前端零耦合。
- Worker 用 `SUPABASE_SERVICE_ROLE_KEY` 裸 fetch PostgREST（平台「无 SDK」风格不变），
  直接 `import shared/notesDomain.js` 复用 `advance()`。

### A.2 扫描与幂等

```
每分钟：
  select * from notes
    where status='active' and remind_at <= now()
      and (last_fired_at is null or last_fired_at < remind_at)
  → 逐条派发（A.3）
  → last_fired_at = now()
  → daily/weekly: remind_at = advance(remind_at, rule, now)   -- Worker 负责推进
  → none: 保持过去时刻，等待用户确认（与 V1 语义一致）
```

- 幂等键 = `last_fired_at < remind_at`：V2 上线后 Worker 与 V1 前端调度器
  **同时存在也安全**（谁先处理谁写入，另一方自然跳过）；上线后「确认时推进」
  的推进主体改归 Worker，前端确认只写 `reminded_at`。
- 扫描索引已就位：`notes_remind_scan`（六）。

### A.3 渠道

1. **Web Push**（主渠道）：
   - 前端注册 `/sw.js`（`push` 事件 → `showNotification`；`notificationclick` →
     focus / open `/app/notes`）；便签墙头部「通知设置」小弹窗内一键订阅
     （PushManager + VAPID 公钥），可退订与发测试推送。
   - `push_subscriptions` 表：`user_id / endpoint(unique) / p256dh / auth /
     user_agent / created_at`，RLS owner policy。
   - Worker 端 `cron-worker/lib/webpush.js`：Web Crypto 签 VAPID JWT +
     RFC 8291 加密 payload，零 SDK；endpoint 返回 404/410 时删行清理。
2. **邮件**（可选、默认关）：Resend API 发「便签墙提醒」到注册邮箱；
   用户设置里开启，V2.1 再议。

### A.4 约束与风险

- **iOS Safari**：需先「添加到主屏幕」（manifest + SW 就绪后可用），页面内做引导文案。
- **Workers 免费额度**：每分钟 cron ≈ 1440 次/天，远低于免费请求额度；
  部分索引空扫成本可忽略。
- **免打扰时段 / 提前量**（如提前 5 分钟）：V2.1 设计，本版不落库。
