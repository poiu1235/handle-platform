# 便签墙 · PRD（v1）

> 页面名：便签墙（Notes Wall）· 路由 `/app/notes`
> 一句话：用户像贴便利贴一样把备忘贴上一面"墙"，每张贴纸可挂一个
> **精确到分钟**的提醒；数据存云端，同账号多设备打开看到同一面墙——
> **"便利贴 + 日程提醒"**。
> 结构与命名对照 `lifestyle-cardpack-prd-v3.md` / `src/cards-db.md`；
> 视觉规范完全沿用 `src/design-language.md`（token、字体、圆角、z-index 表）。

---

## 〇、已裁定的产品决策（2026-09-03，与用户确认）

| # | 决策点 | 裁定 |
| --- | --- | --- |
| D1 | 提醒触达 | **页面开着才提醒**：站内弹窗 + 浏览器系统通知 + 提示音。服务端推送（Cron Worker + 邮件/Push）留给 V2 |
| D2 | 便签摆放 | **自由拖拽 + 网格吸附**：松手落到最近空格；拟物只体现在便签本体（阴影/胶带/微倾斜） |
| D3 | 多端同步 | **打开/操作时拉取 + 定时轮询**（页面可见时每 45s），不引入 Realtime 长连接 |
| D4 | 提醒规则 | **一次性 + 简单重复（每天/每周）**；`repeat_rule` 字段设计上直接落库 |

---

## 一、信息架构

- 独立路由 `/app/notes`（便签墙是画布式布局，与 Hello 的列表式三标签
  （余额/会员/优惠券）结构冲突，不进标签页）。
- 入口：Hello 右下角 FAB 菜单新增「便签墙」项；页面左上角「← 返回」回 `/app`。
- 会话模型与 cards 相反：**notes 数据自包含在本路由**，store 初始化由页面组件
  挂载触发即可，无需挂 App 根（不与其他路由共享数据）。

## 二、页面布局（自上而下）

1. **头部**：眉题 `NOTES WALL`（全大写 1.5px 字距）+ 标题「便签墙」+
   右侧「提示音开关」（铃铛图标，静音态持久化 localStorage `notes-muted`）+
   「← 返回」。
2. **错过提醒条**（条件渲染）：进站/轮询发现有"到点未确认"的便签时，顶部显示
   品牌浅蓝底信息条（`--au-brand-soft` + `--au-brand-text`）：
   「有 N 条到点的提醒」→ 展开列出，逐条或「全部知道了」确认。
   （形态对照 cards 的进站 alert 条，不弹系统通知轰炸。）
3. **便签墙主体**：一块可滚动的"板子"（背景 `--au-bg`，保持扁平，不画软木纹理）。
   - 抽象网格：**6 列 × N 行**，格距 16px，格宽 ~176px → 板宽 ~1136px。
   - 桌面端整板可见；**窄屏（手机）水平滚动**，空白处拖动 = 平移板子，
     拖便签 = 移动便签（pointerdown 命中便签即移动、命中板面即平移，天然不冲突）。
   - 空态：板中央灰字「还没有便签，点右下角 + 贴一张」。
4. **FAB**：右下角「+」（z-index 1010，沿用 board.css 的 FAB 样式）→ 打开便签编辑弹窗。
5. **弹窗层**（z-index ≥1020）：便签编辑弹窗、删除确认弹窗、提醒弹窗（toast）。

## 三、便签卡片视觉规格

- **底色 6 色枚举**（柔和便利贴色，深色文字 `--au-text` 保证对比度）：
  `yellow #FFF6A3` / `pink #FFD9E0` / `blue #CFE8FA` / `green #D9F2D9` /
  `orange #FFE3C2` / `purple #E8DDF5`。默认 `yellow`。
- **微倾斜**：由 `hash(id) % 5` 确定性映射到 `-2°, -1°, 0°, 1°, 2°`——
  **不落库**，多端渲染同一 id 自然一致。
- **胶带**：卡片顶部中间一条半透明白色渐变斜贴（伪元素），是唯一的拟物元素；
  阴影用克制的 `0 2px 6px rgba(0,0,0,0.12)` + hover 加深。
- **卡片内容**：正文（自动换行，超出 4 行截断 + 省略）；页脚两行：
  提醒胶囊 + 相对时间（"3 分钟前更新"）。
- **提醒胶囊**：无提醒不显示；有提醒显示 `🔔 明天 09:00`（近 7 天内显示
  星期+时间，更远显示日期）；**已到点未确认**时胶囊变橙红底闪烁（唯一强提醒视觉）。
- 交互：点击 → 编辑弹窗；拖拽（位移 > 8px 判定，抑制 click）→ 移动。

## 四、便签编辑弹窗（新建 = 编辑）

- 字段：
  1. 正文 textarea（1–500 字，trim 后非空，计数显示）；
  2. 颜色：6 色圆点单选；
  3. **提醒开关** + 展开区：
     - `datetime-local` 原生控件（**分钟精度**，移动端拉起系统选择器）；
     - 快捷 chips：「今晚 20:00」「明天 09:00」「后天 09:00」（点击只填日期时间，可继续改）；
     - 重复：`不重复 / 每天 / 每周`（单选胶囊，默认不重复）；
  4. 保存 / 取消；编辑态额外有「删除」（红色文字链，二次确认弹窗）。
- 关闭提醒 = 清空 `remind_at` + `repeat_rule` 回 none（diff-only 提交，见 7.3 风格）。
- **权限时机**：用户第一次保存带提醒的便签时才申请 Notification 权限
  （just-in-time，不在页面加载时打扰）；被拒绝则只做站内提醒。

## 五、提醒系统（核心）

### 5.1 触发循环（前端调度器）

- store 内维护"下一个最近 remind_at"，用 `setTimeout(至该时刻)` 精确唤醒
  （兜底每 30s 轮巡一次，防时钟休眠/轮询刷新导致计划漂移）。
- 到点动作（`remind_at <= now` 且 `reminded_at` 未覆盖该次）：
  1. 站内 toast 弹窗（顶部居中卡片，z-index 1020）：正文 + 时间，三个动作
     **「知道了」**（确认）/ **「稍后提醒」**（+10 分钟）/ **「打开」**（进编辑弹窗）；
  2. 浏览器系统通知（点击通知聚焦本 tab）；
  3. 提示音（WebAudio 两音清脆短音，无音频资产依赖；随静音开关关闭）。
- **多标签页去重**：触发前查 localStorage `notes-fired`
  （`noteId → 触发时刻`，10 分钟窗口），本 tab 未见该 id 才发系统通知；
  站内 toast 各 tab 独立显示（与 cards 的多 tab 各自独立口径一致）。

### 5.2 错过的提醒（页面没开时到点）

- 进站/每次轮询拉回数据后，凡 `remind_at <= now` 且未确认的，进
  **错过提醒条**（见 2.2），**不补发系统通知、不响铃**——补响会变成打开页面
  就被轰炸，违背 D1 的轻量定位。
- 用户逐条「知道了」/「全部知道了」后：`reminded_at = now`，重复便签
  直接推进到下一次未来时刻（见 5.3）。

### 5.3 重复推进算法（notesDomain.js，纯函数可测）

```
advance(remind_at, rule, now):
  next = remind_at
  while next <= now: next += 1天 | 7天        // daily | weekly
  return next   // 循环上限 1 万次，防脏数据死循环
```
- 触发/错过后**不立即推进**，等用户确认（知道了/打开）时推进——未确认期间
  便签保持"到点未确认"的醒目态，不会静默溜走。
- 「稍后提醒」：`remind_at = now + 10min`（保留 repeat_rule）；重复便签贪睡后
  以下一次确认为推进基点，允许小幅基点漂移（可接受，记录在此）。

### 5.4 时区与精度

- `remind_at` 落库 `timestamptz`，客户端用本地时区写入/展示；多端各自本地渲染，
  不存在跨时区换算争议。分钟精度 = `datetime-local` 原生保证。

## 六、数据模型（supabase/notes.sql，风格对照 cards.sql）

```sql
create table public.notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  content     text not null check (trim(content) <> '' and char_length(content) <= 500),
  color       text not null default 'yellow'
              check (color in ('yellow','pink','blue','green','orange','purple')),
  pos_x       int  not null default 0 check (pos_x between 0 and 999),
  pos_y       int  not null default 0 check (pos_y between 0 and 999),
  remind_at   timestamptz,                      -- null = 无提醒
  repeat_rule text not null default 'none'
              check (repeat_rule in ('none','daily','weekly')),
  reminded_at timestamptz,                     -- 最近一次确认时间
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.notes enable row level learning;  -- 笔误预防：RLS
alter table public.notes enable row level security;
create policy notes_owner on public.notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index notes_user_pos on public.notes (user_id, pos_y, pos_x);
create index notes_user_remind on public.notes (user_id, remind_at);  -- V2 cron 预留
```

- **位置 = 抽象格坐标 (pos_x, pos_y)**，不是像素——网格吸附天然成立，且跨设备
  分辨率无关（6 列恒定，窄屏水平滚动，见 2.3）。
- **不做 (user_id, pos_x, pos_y) 唯一约束**：拖拽交换需要两行同时改，唯一约束
  会把"交换"变成两步操作引入中间态冲突；占用冲突由前端吸附算法规避
  （见 7.2），极端并发下允许暂时重叠，轮询可见后用户随手拖开即可。
- `updated_at` 由触发器维护，冲突语义 = **后写覆盖先写**（与 cards 3.6.2 同口径）。
- 每用户上限 **200 条**（API 层校验，防板子无限膨胀）。

## 七、API 契约（functions/api/notes.js + notes/[id].js）

沿用 cards 的中间层模式：`_middleware.js` 已验签并把 access token 放进
`data`，本层只做白名单/枚举/长度校验，RLS 兜底数据归属。

| 方法 | 路径 | 语义 | 返回 |
| --- | --- | --- | --- |
| GET | `/api/notes` | 全量拉取（按 pos_y, pos_x 排序） | 行数组 |
| POST | `/api/notes` | 新建（内容/颜色/坐标/提醒） | `Prefer: return=representation` 单行 |
| PATCH | `/api/notes/:id` | **diff-only** 部分更新（编辑/移动/确认/贪睡/重复推进） | 单行 |
| DELETE | `/api/notes/:id` | 撕掉 | 204 |

- PATCH 提交契约沿用 cards 7.3：**只传变化字段**，未携带字段保留现值
  （关闭提醒这类"清空"必须显式传 null，禁止用缺省表达清空）。
- 校验：content 1–500 trim；color/repeat_rule 枚举；pos 0–999 整数；
  remind_at 可解析 ISO 时间戳（允许过去时刻——重复规则的推进由 5.3 处理）。

## 八、前端架构（对照 cards 模块）

| 文件 | 职责 |
| --- | --- |
| `shared/notesConfig.js` | 颜色枚举、网格 6×16px、字数上限、贪睡分钟数、上限条数 |
| `src/lib/notesDomain.js` | 纯函数：重复推进 advance()、到点判定、提醒胶囊文案、相对时间、空闲格搜索、id→倾斜角 |
| `src/lib/notesStore.js` | 模块级 store（useSyncExternalStore）：rows/status/message；loadNotes / upsertLocal / removeLocal / 轮询 / 提醒调度器 |
| `src/pages/NotesBoard.jsx` | 页面：头部/提醒条/墙/FAB/弹窗 |
| `board.css` 追加 `nt-` 前缀段 | 便签墙全部样式（不新建 css 文件，沿用管理端样式集中策略） |
| `scripts/test-notes-domain.mjs` | notesDomain 纯函数测试（npm script `test:notes`，对照 test-cards-domain 模式） |

### 8.1 同步与乐观更新

- 进站 GET 全量；此后**页面可见时每 45s 轮询**（`visibilitychange` 隐藏即停，
  回焦立即拉一次）——同口径 cards 会话控制器。
- 用户操作（新建/编辑/删除/移动/确认）= **本地先改 + 单请求**，响应以
  `return=representation` 回写，不二次拉列表（对照 cards 请求预算）。
- 拖拽中便签**冻结轮询合入**：轮询回来的行更新其余便签，正在拖拽那张
  以本地为准（防止手指下的卡片瞬移）。

### 8.2 拖拽与吸附（D2）

- Pointer Events 统一鼠标/触摸；按下位移 > 8px 进入拖拽（并抑制 click）。
- 松手 → 落到**最近的空闲格**：从目标格起螺旋搜索第一个空格
  （notesDomain 纯函数 `findFreeCell`，可测）。
- 移动落定 = 本地 upsert + 一次 PATCH `{pos_x, pos_y}`。

### 8.3 提醒调度器（见 5.1 的实现位）

- store 持有最近 remind_at，`setTimeout` 精确触发 + 30s 兜底巡检；
- 触发即入"到点队列"驱动 toast；确认/贪睡/推进各是一次 PATCH。

## 九、边界与已知取舍（记录，不阻塞）

1. **重复"每月"不做**：月末钳制（31 日 → 2 月 28 日）有语义争议，V1.1 再议。
2. **贪睡导致重复基点漂移**：见 5.3，接受。
3. **两设备同时移动同一张便签**：LWW，后者覆盖；位置是低价值数据，可接受。
4. **两设备占同格**：无唯一约束（见六），轮询后表现为暂时重叠，用户拖开即可。
5. **系统通知依赖权限与浏览器策略**：iOS Safari 需添加到主屏幕才支持通知
   ——站内 toast 永远是主通道，系统通知是增强。
6. **页面休眠（笔记本合盖）**：回来时走 5.2 错过提醒条，不补铃。

## 十、分期

- **V1（本 PRD）**：以上全部。
- **V1.1（低成本追加）**：每月重复；便签搜索；空板双击快速新建。
- **V2（架构升级）**：服务端提醒——Cron Worker 扫 `notes_user_remind` 索引 +
  邮件/Web Push 渠道，页面没开也能准点提醒（字段无需变更，`reminded_at`
  增加渠道维度即可）。
