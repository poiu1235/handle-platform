# Handle 设计语言规范 v2（认证页 + 管理端：余额页 / 会员页）

> 依据代码提炼：`src/auth.css`（登录/注册/重置密码）、`src/pages/board.css`（管理端首页
> 余额页 `Hello.jsx` + 会员页 `CardsPanel.jsx` + 两个批量导入页 + 会员日历）、
> `src/components/DaysRing.jsx`、`src/components/CardMark.jsx`、`src/lib/iconColor.js`。
> 用途：**新增页面、组件、弹窗时直接套用本规范**，保证视觉一致。
> 硬性原则：所有数值从本文档取，不新造；需要新颜色/新字号先扩 token 再使用。

---

## 目录

- [0. 设计语言总纲](#0-设计语言总纲)
- [1. 设计令牌（Design Tokens）](#1-设计令牌design-tokens)
  - 1.1 色彩 token · 1.2 色彩语义 · 1.3 字体系统 · 1.4 字号阶梯 · 1.5 间距系统
  - 1.6 圆角阶梯 · 1.7 描边与分隔 · 1.8 阴影阶梯 · 1.9 动效系统 · 1.10 z-index · 1.11 响应式
- [2. 通用组件规范（bd- 体系）](#2-通用组件规范bd-体系)
- [3. 余额页专项规范](#3-余额页专项规范)
- [4. 会员页专项规范（cd- 体系）](#4-会员页专项规范cd-体系)
- [5. 图标体系](#5-图标体系)
- [6. 文案与排版守则](#6-文案与排版守则)
- [7. 未来设计应用守则（Checklist）](#7-未来设计应用守则checklist)

---

# 0. 设计语言总纲

一句话：**PT Sans + 品牌蓝 #5BBBEE + 深蓝 hero + 白色面板 + 胶囊控件 + 1px #E0E0E0 描边 + focus 光环 + 0.15–0.32s ease-out/spring 缓动。**

1. **一深一浅两个世界**：深蓝渐变 hero 只做品牌头部（认证页/管理端/导入页共用同一条渐变），内容区永远是浅灰 `#F0F2F5` 底 + 白色面板。深蓝绝不入内容区。
2. **品牌蓝是唯一强调色**：动作、选中、链接、focus 全部是蓝。红 = 破坏性，深蓝 = 不可逆"重"动作，灰 = 零值/失效。彩色只允许出现在"内容载体"上（记录卡底、图标、圆环），容器与控件永远中性。
3. **记录即色彩**：每条数据一个专属颜色（图标主色渐变，无图标则 id 哈希取记录色板，**永不变色**），列表、日历、提醒弹窗中同一记录同色——颜色就是身份。
4. **扁平 + 克制投影**：组件不带重描边、不带渐变装饰；层次靠「色深 + 圆角阶梯 + 三档阴影」表达。
5. **胶囊世界观**：按钮、标签、开关、排序、分段控件、计数徽章全是 999px 胶囊或正圆；容器 16px；小控件 8–12px。
6. **动效两档曲线**：`--bd-ease`（利落 out）用于位移/展开，`--bd-spring`（过冲回弹）用于"弹出/挂载"。
7. **移动端优先**：内容列 560px 居中（导入页 ≥ 视口 2/3），720px 起做桌面增强，480px 以下收紧内边距。
8. **可访问性兜底**：全局 `prefers-reduced-motion: reduce` 覆盖；焦点可见（focus 光环或 2px outline）；文字对比度按 WCAG 判定（卡片名称行自动选白/黑）。
9. **文案分工**：眉题/装饰用英文全大写小字（uppercase + 1.5px 字距），功能文案一律中文；数字用 `tabular-nums`。
10. **反馈分离**：主动操作 → notice（信息蓝/危险红）；被动发现 → alert 弹窗；不可逆 → 红色确认弹窗。

---

# 1. 设计令牌（Design Tokens）

Token 定义在页面根作用域：认证页 `.shell`，管理端 `.bd-board / .bd-import`——**同名同值，两处独立声明**，新页面根容器必须照抄整套。

## 1.1 色彩 token

| Token | 值 | 用途 |
| --- | --- | --- |
| `--au-navy` | `#010F1C` | 深蓝主色：hero 渐变深端、深蓝按钮/操作面板底、遮罩与阴影基色 |
| `--au-navy-2` | `#04263F` | 深蓝次色：hero 渐变亮端、"清零/提交"重动作底 |
| `--au-brand` | `#5BBBEE` | 品牌蓝：主按钮、选中态、链接、today 胶囊、FAB |
| `--au-brand-hover` | `#3FA9E0` | 品牌蓝 hover |
| `--au-brand-soft` | `#E3F3FC` | 品牌浅蓝底：notice、hint、选中排序、cd-tag |
| `--au-brand-text` | `#1B74A8` | 浅蓝底上的深蓝文字、diff 新值 |
| `--au-text` | `#1A1A1A` | 主文字 |
| `--au-text-2` | `#646464` | 次级文字 |
| `--au-text-3` | `#939393` | 弱文字：placeholder、表头、禁用、提示 |
| `--au-bg` | `#F0F2F5` | 页面底色（也用于 hover 加深、计数徽章底） |
| `--au-card` | `#FFFFFF` | 卡片/面板白 |
| `--au-border` | `#E0E0E0` | **唯一中性描边色** |
| `--au-danger` | `#EF4444` | 错误文字/危险动作 |
| `--au-danger-soft` | `#FEE2E2` | 错误浅底 |
| `--bd-zero-card` | `#CDD3D9` | 零值/失效卡底（0 余额卡、已过期会员卡共用，比页面底深一档） |
| `--cd-usedup-card` | `#D9E2EC` | 会员卡"次数用完"沉底底色（弱化灰蓝，与失效灰区分） |
| `--cd-usedup-text` | `#5C6B7C` | "次数用完"沉底文字色 |
| `--bd-font` | `'PT Sans', 'LXGW WenKai', -apple-system, 'PingFang SC', 'Microsoft YaHei', 'HarmonyOS Sans SC', sans-serif` | 管理端字体栈（认证页第二顺位为 `'Noto Sans SC'`，其余同） |
| `--bd-ease` | `cubic-bezier(0.22, 1, 0.36, 1)` | 标准 ease-out |
| `--bd-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | 回弹 spring（弹出/挂载专用） |
| `--bd-col` | `560px` | 管理端内容列宽 |
| `--bd-gutter` | `max(16px, calc((100% - var(--bd-col)) / 2))` | 侧边距（移动贴边 16px，宽屏自动居中） |

> 旧版 index.css 的纸面风 token（`--paper/--ink/--amber/--teal/--rust`）已废弃，仅登录页骨架类名仍在使用、由 auth.css 覆盖取值。

## 1.2 色彩语义

**深蓝渐变公式（全站唯一，只允许出现在头部）**：

```css
background: linear-gradient(160deg, var(--au-navy-2) 0%, var(--au-navy) 72%);
/* = linear-gradient(160deg, #04263F 0%, #010F1C 72%) */
```

**白色系透明阶梯（深蓝 hero 之上）**：`rgba(255,255,255,0.08)` 状态胶囊底 / `0.25` 激活计数徽章底 / `0.55–0.75` 半透明白按钮与标签底 / `0.72–0.75` 次级白字 / `0.9–0.95` hover 白。

**品牌蓝透明系**：`rgba(91,187,238,0.25)` focus 光环 / `0.35` 开关 focus / `0.4` 选中 tab 与按钮投影、today 整列淡底 `0.1`、筛选项 hover `0.08`。

**记录色板（JSX 内，id 哈希取色，永不因状态变色）**：

| 色板 | 色值 | 使用 |
| --- | --- | --- |
| 余额（暖橙黄盘 16 色） | `#F4A261 #E76F51 #F2CC8F #E9C46A #D68C45 #EFB366 #E07A5F #F4D35E #DDA15E #EAAC8B #C97B63 #F6BD60 #E8998D #D4A276 #F28482 #EFC88B` | 余额卡（无图标时） |
| 会员记录色（青绿-紫罗兰盘 17 色） | `#A9DACE #B7E5DF #A2E4E2 #BBE0E3 #A8D7E2 #B6DBEB #ADCBDF #BBD1E9 #A6BFE8 #BFCAE8 #ABB5E6 #C3C5E6 #B3B0E4 #C7BFED #C2B5E2 #D3C4EC #CDB0EA` | 会员卡/日历（无图标时） |
| 优惠券（粉绿盘 16 色） | `#E6A8C7 #EEB8CF #EDA3BD #EDBCC9 #EBA8B5 #F2B9C0 #EAADAF #F1BFBD #F0B0A8 #F0CAC1 #EFBEAD #EFD3C5 #D8E0AE #D8E8B9 #C8E7A9 #CAE7BC` | 优惠券（占位） |

哈希函数：`h = (h*31 + charCode) >>> 0`，取 `palette[h % length]`。

**动作三色（滑动操作面板）**：修改 = 品牌蓝 `#5BBBEE`；删除 = 危险红 `#EF4444`；清零/深滑提交态 = 深蓝 `#04263F`。

**色彩语义总表**：蓝 = 常规动作与选中；红 = 破坏性；深蓝 = 不可逆重动作；`#CDD3D9` 灰 = 零值/**真正的失效（已过期）**；`#D9E2EC` 灰蓝 = 资格暂尽（次数用完，弱化非失效）；彩色卡 = 记录身份；`#0D263B@85%` = 彩色日程条上的深字。

## 1.3 字体系统

- **字族**：管理端 `'PT Sans', 'LXGW WenKai', -apple-system, 'PingFang SC', 'Microsoft YaHei', 'HarmonyOS Sans SC', sans-serif`（`--bd-font`）；认证页 `'PT Sans', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif`。
- **PT Sans 无 @font-face**：纯 font-family 声明，依赖本机安装、否则顺位回退中文字族——**不要引入 webfont 加载**。
- 表单控件必须 `font-family: inherit`（按钮/输入框/textarea 显式回填）。
- **字重只有 400 / 700 两档**：强调、标题、按钮、数字全部 700；正文/禁用 400。禁用 600。
- **行高**：标题 1.3；说明/notice/error 类 1.5；textarea/标签类 1.6；徽章与圆环数字 1；日程条锁 `20px`（与车道行高一致）；其余默认。
- **字距**：英文眉题 `1.5px` + uppercase；表格表头 `1px` + uppercase；深滑提交态 `0.05em`；验证码输入 `8px`。
- **数字**：金额、天数、次数、表格数值一律 `font-variant-numeric: tabular-nums`。
- **产品名**：不用文字，统一 SVG 字标 `src/assets/font_daoliti.svg`（白字，管理端 `height: 22px`，认证页 17px），`alt="Handle 数据管理端"`。

## 1.4 字号阶梯（全量，取值必从此表）

| 字号 | 使用场景 |
| --- | --- |
| 10px | 圆环旁"天"字（`.cd-ring-unit`）、hero 英文副标题 |
| 11px | 计数徽章、表格表头（uppercase+1px）、状态小标签 cd-tag、次数胶囊、日程条（480px 下 10px） |
| 12px | 眉题 eyebrow（uppercase+1.5px）、状态胶囊、排序按钮、卡片日期 meta、金额单位、错误行、区块副文字、日历星期/日期数字 |
| 13px | **正文标准档**：标签名、开关文字、notice、字段 label、滑动操作按钮、FAB 菜单项、弹窗 hint、预览标题、表格正文、diff 行、只读详情行、静默菜单项、分段控件、筛选列表 |
| 14px | 主按钮/ghost、textarea、图标搜索框、选中图标名、alert 卡名、深滑提交态 |
| 15px | 折叠卡名、展开态日期行与单位、全宽提交按钮、日历月份标签、认证页主按钮 |
| 16px | 弹窗输入框（**≥16px 防 iOS 聚焦缩放，硬性**）、静态卡名、认证页移动端输入框 |
| 17px | 进站 alert 标题、只读详情标题、半展开主信息 |
| 18px | 弹窗标题、全量详情卡名 |
| 20px | hero 标题（字标 22px 高）、折叠态金额、验证码输入（+700+8px 字距） |
| 28px | FAB 的 + 字形 |
| 30px | 展开态金额、半展开标题最大档（自适应 20–30px） |
| 40px（数值） | DaysRing 96px 默认环内数字（`size×0.42`，3 位以上降 `×0.3`） |

## 1.5 间距系统

- **gap 档位**：2 / 3 / 4 / 6 / 7 / 8 / 10 / 12 / 16px。小图标组合 2–5px；控件内 4–8px；区块内 10px；弹窗头/详情行 12px。
- **padding 档位**：控件类 `2px 8px`（cd-tag）、`3px 7px`（计数）、`7px 13px`（排序）、`9px 6px`（tab）、`11px 14px`（notice/hint）；容器类 `12px 14px`（区块/diff 卡）、`14px`（输入框左右）、`16px 18px`（折叠卡）、`18px 20px`（展开卡）、`24px 22px`（弹窗卡）；头部 `20px 20px 16px`（管理端）/ `20px 20px 22px`（导入页）；列表滚动区 `12px var(--bd-gutter) 120px`（**底部 120px 给 FAB 让位，固定值**）。
- **margin 规律**：眉题下 4px；区块间 12–14px；层叠折叠行 `margin-top: 8px`、相邻折叠行 `-16px` 叠压；展开行 `10px 0`。

## 1.6 圆角阶梯

| 圆角 | 组件 |
| --- | --- |
| `999px` 胶囊 | 所有按钮、标签、分段控件容器、排序、开关轨道、计数徽章、静默菜单项 |
| `50%` 正圆 | 状态点、FAB、开关滑块、alert 色点、静默循环按钮、展开/收起圆钮 |
| `24px` | 认证页移动端面板顶部两角、认证页胶囊按钮 |
| `16px` | **卡片与弹窗卡标准圆角**（卡行、卡体、modal 卡、滑动面板外缘） |
| `12px` | textarea、解析预览、日历网格、区块白卡、diff 卡、静默菜单、分段控件、筛选面板 |
| `10px` | 输入框、notice、hint、图标选项、图标搜索 |
| `8px` | 错误块、行内小输入框、下拉、提示 hint-warn |
| `6px` | 日历日程条、记录色芯片 |
| `5px / 4px / 3px` | 小缩略图/小图标（22/18/14px 缩略图用） |
| `25%` | 卡片图标盒（百分比保证缩放时圆角比例恒定） |
| `11px` | 日历今天胶囊（22px 圆） |

滑动接缝规则：操作面板滑出时，卡片接缝一侧上下角归零（`bd-card-seam-right/left`），整行读作一个连续圆角整体。

## 1.7 描边与分隔

- **唯一常规描边：`1px solid #E0E0E0`**——白色容器（tab 容器、排序、菜单、预览卡、弹窗内白块、日历网格、diff 卡、筛选面板）与输入框。强调靠颜色不靠描边。
- 彩色卡片、hero、主按钮、FAB、滑动面板**无边框**——靠色块与投影分层。
- 特例：图标选项 `1.5px #E0E0E0`（选中变蓝）；行内小按钮 `1px rgba(26,26,26,0.25)`；表格行分隔 `1px #EEF0F2`；只读详情行间 `1px dashed #E0E0E0`（末行无线）；日历列分隔 `1px #E0E0E0`。
- 图标内嵌收边：`inset 0 0 0 1px rgba(255,255,255,0.2)`。
- **focus 公式**：`border-color: var(--au-brand); box-shadow: 0 0 0 3px rgba(91,187,238,0.25)`（输入框/搜索/图标选项/下拉统一；开关用 0.35）。
- **focus-visible**（按钮类）：`outline: 2px solid var(--au-brand); outline-offset: 3px`。

## 1.8 阴影阶梯

| 层级 | box-shadow | 用途 |
| --- | --- | --- |
| L1 折叠卡 | `0 3px 8px rgba(1,15,28,0.10)` | 折叠卡、静态卡 |
| L1.5 图标浮起 | `0 3px 8px rgba(1,15,28,0.22), 0 1px 2px rgba(1,15,28,0.16)` | 卡面图标盒（双层投影"浮"在卡上） |
| L2 展开/浮层 | `0 10px 26px rgba(1,15,28,0.16~0.18)` | 展开卡、静默菜单、筛选面板 |
| L2.5 菜单胶囊 | `0 4px 14px rgba(1,15,28,0.14)`（hover `0 8px 20px rgba(1,15,28,0.18)`） | FAB 菜单项 |
| L3 弹窗 | `0 24px 60px rgba(1,15,28,0.28)` | 弹窗卡（全站最重） |
| 品牌光晕 | `0 2px 8~10px rgba(91,187,238,0.4~0.45)` | 选中 tab、主按钮/FAB hover |
| 危险光晕 | `0 2px 10px rgba(239,68,68,0.4)` | 危险按钮 hover |
| FAB | `0 8px 20px rgba(63,169,224,0.45)`（开启态 `rgba(1,15,28,0.35)`） | 品牌蓝圆钮 |
| toast | `0 8px 22px rgba(1,15,28,0.18)` | 吸顶 notice-toast |
| 状态点双圈 | `0 0 0 2px rgba(255,255,255,0.85), 0 0 0 3px var(--au-border)` | alert 色点 |
| 开关滑块 | `0 1px 3px rgba(1,15,28,0.25)`；按压 `inset 0 0 0 24px rgba(1,15,28,0.08)` | iOS 开关 |
| 认证页面板 | `0 -6px 24px rgba(1,15,28,0.14)`（上叠）/ `0 2px 8px rgba(0,0,0,0.1)`（桌面） | 底部抽屉投影 |

规律：**输入框永远无阴影**；阴影基色统一深蓝 `rgba(1,15,28,…)`；强度随层级递进 0.10 → 0.16 → 0.28。

## 1.9 动效系统

**时长档位**：

| 档位 | 时长 | 场景 |
| --- | --- | --- |
| 瞬时反馈 | 0.12–0.15s ease | 颜色、边框、按钮按压 scale |
| 微动效 | 0.18–0.25s | 卡片 padding/阴影、meta 滑入 0.25s |
| 结构切换 | 0.28–0.32s | tab 选中 0.28 spring、菜单 0.3 spring、弹窗 0.32 spring、卡片字号/图标缩放 0.32 ease |
| 入场 | 0.3–0.5s ease + 交错 | 列表行 0.5s + 每张延迟 `index×40ms`（`--stagger`） |
| 氛围 | 长周期 infinite | 展开卡渐变流动 9s、加载点脉冲 1.4s、圆环弧长 0.5s ease |

**缓动**：位移/展开用 `--bd-ease`；弹出/挂载（菜单、弹窗、tab 选中、开关滑块）用 `--bd-spring`。

**@keyframes 全表**：

| 名称 | 内容 | 用途 |
| --- | --- | --- |
| `bd-rise` | opacity 0→1，translateY 14px→0 | 列表行/静态卡/预览入场（40ms 交错） |
| `bd-fade` | opacity 0→1 | 遮罩、筛选面板 |
| `bd-pop` | scale 0.92→1（spring） | tab 选中 |
| `bd-menu-in` | opacity 0 + translateY(10px) scale(0.9) → 归位（spring，第二项延迟 40ms） | FAB 菜单、静默菜单 |
| `bd-modal-in` | translateY(10px) scale(0.94) → 归位（spring 0.32s） | 弹窗卡 |
| `bd-meta-in` | translateY(-3px) → 0，opacity → 0.6 | 展开日期行 |
| `bd-pulse` | opacity 0.35↔1（1.4s infinite） | 加载点 |
| `bd-card-flow` | background-position 0%→50%→100%（9s infinite，size 240%） | 展开卡渐变呼吸 |
| `cd-pill-drop / cd-pill-lift` | translateY ±40px → 0（0.32s） | 半展开卡次数胶囊落/升 |
| `cd-ring-grow / cd-ring-shrink` | scale 0.46↔2.17 → 1（0.32s，origin top right） | 天数环折叠⇄半展开缩放（30↔65px） |

**transition 清单要点**：卡片 `padding 0.18s / box-shadow 0.18s / transform 0.2s / color 0.18s`；字号与图标 `0.32s var(--bd-ease)`；输入类 `border-color + box-shadow 0.15s`；开关滑块 **`left 0.24s var(--bd-spring)`（布局属性，刻意不用 transform——Windows Chrome 常驻合成层会把旁侧文字切到灰度抗锯齿发糊）**；日程条 hover `filter: brightness(0.94)`。

**hover/active 语义**：主按钮 hover 换色 + 光晕、active `scale(0.97)`；菜单项 hover `translateY(-2px)`；FAB active `scale(0.94)`、开启态 `rotate(135deg)` 变深蓝；图标选项 active `scale(0.94)`；危险/普通按钮 disabled `opacity: 0.5`。

**可访问性**：`prefers-reduced-motion: reduce` 下全部动画/过渡压到 0.01ms；氛围类动画（card-flow、pill-drop/lift、ring-grow/shrink）单独 `animation: none`。

## 1.10 z-index 层级表（自下而上，新增浮层按序插入）

| z | 归属 |
| --- | --- |
| 1 | hero 内容、水印之上的卡片 |
| 20 | 静默弹出菜单（相对卡内） |
| 25 | FAB 透明遮罩 |
| 30 | FAB 菜单、FAB 按钮 |
| 1000（JS） | 展开卡（层叠折叠卡按 `总数−序号` 递减） |
| 1010 | FAB 容器、日历筛选遮罩（面板 1011） |
| 1015 | 吸顶 notice-toast |
| 1020 | 弹窗遮罩（bd-modal） |
| **1030** | **进站 alert（全站最高）** |

## 1.11 响应式

| 断点 | 调整 |
| --- | --- |
| 无查询（流式） | `--bd-gutter = max(16px, 居中剩余)`；导入页列 `max(100vw×2/3, 560px)`；日历宽 `min(1040px, 容器)` |
| ≤480px | 头部左右 padding 16px；折叠卡 `14px 15px`、展开卡 `16px 16px`；导入页主体左右 14px；日程条字号 10px、筛选面板 220px |
| ≥720px（仅认证页） | hero 压扁横排（logo 40px）、表单卡变浮卡（max-width 420px、四角 16、1px 描边+轻投影、内边距 34/32/28）、输入框 14px |
| `prefers-reduced-motion` | 全局 0.01ms + 氛围动画关闭 |

---

# 2. 通用组件规范（bd- 体系）

### 2.1 页面骨架

```
.bd-board（100dvh 纵向 flex，overflow hidden，--au-bg 底）
├── header.bd-header   深蓝渐变 hero（见 2.2）
├── nav.bd-tabs        分类分段控件
├── 工具行（排序胶囊 / 开关行）
├── .bd-list           flex:1 内部滚动（scrollbar-width: thin; scrollbar-gutter: stable）
├── .bd-fab-wrap       FAB（absolute 底部居中，bottom 26px）
└── 弹窗 ×N（fixed 遮罩）
```

内容列 560px：头部内容与各区块 `max-width: var(--bd-col); margin-inline: auto`，左缘对齐；登录态胶囊与内容列**左缘**对齐（不居中）。

### 2.2 深蓝 hero

- 渐变见 1.2；padding `20px 20px 16px`；白字。
- **水印**：右下角 logo 150×150px、`opacity: 0.12`、`bottom: -52px`，水平定位**跟随内容列右缘**：`right: max(-30px, calc((100% - var(--bd-col)) / 2 - 30px))`——移动贴屏幕边、宽屏贴列缘，禁止写死贴屏。`pointer-events: none`。
- 结构：eyebrow（12px/700/uppercase/1.5px 字距/品牌蓝，margin-bottom 4px）→ 字标 `bd-title-word`（22px 高）→ 右侧 `bd-text-btn`（13px/700/白 75%、下划线 offset 3px、hover 纯白）。
- 状态胶囊 `bd-status`：`rgba(255,255,255,0.08)` 底、白 72%、12px、padding `5px 12px`、胶囊、`width: fit-content`；内含 `bd-dot` 7px 圆点三态：蓝（正常）/红 `#EF4444`（错误）/灰 `#9FB3C2` + bd-pulse（加载中）。

### 2.3 分类分段控件（tabs）

白色容器 `padding: 4px; gap: 4px; 1px #E0E0E0; 胶囊`，内含等宽分段（`9px 6px`、13px/700、`#646464`）。选中段：品牌蓝底白字 + `0 2px 8px rgba(91,187,238,0.4)` + `bd-pop 0.28s spring`。计数徽章：11px、`3px 7px` 胶囊、灰底 `#F0F2F5` 灰字；激活时白 25% 底白字。

### 2.4 排序胶囊 / 筛选按钮

`7px 13px`、胶囊、白底 1px 描边、12px `#646464`；hover 边 `#C9CED4`；选中 `.bd-sort-btn-active`：品牌蓝描边 + `#E3F3FC` 底 + `#1B74A8` 字，文字尾随 ↑/↓。

### 2.5 iOS 开关（通用）

轨道 42×24 胶囊（`#C8CFD6` → 选中品牌蓝，`background 0.2s`）；滑块 20×20 白圆 + 小投影，`left 2px → 20px`（**0.24s spring 布局属性动画**）；按压：轨道 inset 凹陷 + 滑块压扁至 17px；focus 光环 0.35；label 13px `#646464`（hover 加深）。禁用 `opacity: 0.4`。

### 2.6 notice 提示条 / 加载行

- `.bd-notice`：13px/1.5、`11px 14px`、圆角 10、信息态 `#E3F3FC`+`#1B74A8`、错误态 `#FEE2E2`+`#EF4444`；内链 700 下划线。吸顶变体 `bd-notice-toast`：`position: sticky; top: 0; z 1015` + 投影。
- `.bd-status-line`：居中 13px `#646464`、`padding: 28px 8px`、gap 8px，可带 `bd-dot bd-dot-pending`。
- 所有瞬时提示经 `useAutoDismiss`（4s 自动消失）。

### 2.7 弹窗体系

- 遮罩：`fixed; inset: 0; z 1020; padding: 20px; rgba(1,15,28,0.42) + backdrop-filter: blur(3px)`，`bd-fade 0.2s`；点遮罩关闭。
- 卡片：`min(400px, 100%)`、`max-height: 86dvh`、圆角 16、`24px 22px`、`bd-modal-in 0.32s spring`；三段结构 head（固定）/ scroll（`flex:1; overflow-y:auto`）/ foot（固定）。
- 标题 18px/700（margin-bottom 14px）；hint = notice 同款（信息蓝/危险红）；底部按钮右对齐 `gap: 10px`。
- 提交中：文案「保存中…/提交中…」，双按钮禁用；失败 = 弹窗内红色 notice，表单保留。

### 2.8 按钮

| 变体 | 规格 |
| --- | --- |
| 主按钮 `.bd-btn` | 高 44、`0 24px`、胶囊、品牌蓝底白字 14px/700；hover `#3FA9E0` + `0 2px 10px rgba(91,187,238,0.45)`；active scale 0.97；disabled opacity 0.5 |
| ghost `.bd-btn-ghost` | 白底 1px 描边、`#646464`；hover 底 `#F0F2F5` 字加深 |
| danger `.bd-btn-danger` | 红底；hover `#DC2626` + 红光晕 |
| block `.bd-btn-block` | 全宽、高 48、15px |
| mini `.cd-mini-btn` | `8px 14px`、胶囊、白底 `1px rgba(26,26,26,0.25)`、13px；hover 白 95%；`.cd-btn-dim` = 置灰仍可点（opacity 0.45，点击给提示） |

### 2.9 输入体系

- 弹窗输入框：高 46、`0 14px`、圆角 10、16px（防 iOS 缩放）、1px 描边、白底无阴影；focus 光环。
- 行内小输入框 `.cd-field-inline`：高 34、圆角 8、13px；数值框宽 78px、日期框 138px。
- 下拉 `.cd-select`：高 34、右 padding 28px，自绘箭头（data-URI SVG，stroke `#939393`）。
- textarea：min-height 240、`14px` 内边距、圆角 12、14px/1.6、可纵向拉伸。
- 字段结构：label 13px/700（下 6px）→ input（下 14px）→ 错误提示 `.cd-field-hint-error` 12px 红。
- 认证页输入：高 48、图标位左留白 44px（18px 线性图标 `stroke 1.8 #939393`）、disabled `#F5F7F8`；验证码 20px/700/字距 8px。

### 2.10 预览表格（导入页）

`border-collapse: collapse`、13px；th：`6px 8px`、底边 1px `#E0E0E0`、11px/700/uppercase/1px 字距/`#939393`；td：`8px`、底边 `1px #EEF0F2`、末行无线；数值列右对齐 + tabular-nums；图标缩略 22×22 圆角 5。错误块：`#FEE2E2` 底圆角 8、每行 12px 红「第 N 行：原因 —原文」。

### 2.11 FAB

56px 品牌蓝正圆、28px「+」、品牌投影；点开 `rotate(135deg)` 变深蓝；菜单白色胶囊项（`11px 18px`、13px/700、1px 描边、L2.5 投影，错峰 40ms 弹入，hover 上浮 2px）；遮罩**全透明**（仅点击热区）。位置底部居中 z 1010。

---

# 3. 余额页专项规范

### 3.1 记录卡（层叠卡包）

- **背景 = 图标主色渐变**：`linear-gradient(90deg, 图标第一主色, #FFFFFF)`（`iconColor.cardStyle` 生成，无图标映射回退记录色板）。工程铁律：JSX 必须写 `backgroundImage` 长属性——`background` 简写会重置 `background-size/position`，顶掉展开态的流动动画。
- **名称行文字色按 WCAG 自动判定**：对渐变左端主色分别计算与白/深 `#1A1A1A` 的对比度，白胜出 → 名称白字并挂 `--bd-card-name-color`（旗标滤镜同步翻白）；金额区恒深字。
- **折叠态**：padding `16px 18px`、L1 阴影、圆角 16；左「图标盒 + 名称 15px/700」，右「金额 20px/700 + 单位"元" 12px」。
- **展开态**：padding `18px 20px`、L2 阴影；标题自适应缩放（**恒按 30px/700 排版 + `transform: scale()` 缩小**，离屏测量自然宽度 + ResizeObserver 解一次方程；图标 20–40px，`+2~3px` 测量缓冲防 ellipsis 误截断）；金额升 30px；新增日期行「YYYY年MM月DD日更新」12px/60%（nowrap+ellipsis）。
- **渐变流动**：展开态 `background-size: 240% 240%; animation: bd-card-flow 9s ease-in-out infinite`。
- **零余额**：内联 `backgroundColor: var(--bd-zero-card)`、文字 `#6B727A`、菱形 60% 透明、沉底、**不可右滑清零**。
- **图标盒**：圆角 25%、双层投影、`::after` 斜向高光层（135° 白 0.8→0.35→透明→深蓝 0.15 渐变）；无图标 = 8px 菱形（`clip-path: polygon(50% 0,100% 50%,50% 100%,0 50%)`、currentColor、opacity 0.75）。
- **金额淡出公式**：卡剩余宽度 <150px 开始淡出、<90px 消失——`opacity = (剩余宽度 − 90) / 60`。
- **层叠**：折叠行 `margin-top: 8px`、相邻 `-16px` 叠压、行 z = 总数−序号；展开行跳 z 1000 并 `scrollIntoView({ behavior:'smooth', block:'center' })`；入场动画只播一次（`.bd-entered` 后禁用，防重挂闪烁）。

### 3.2 滑动操作（三色语义，会员页同构复用）

- 常量：按钮宽 66px；吸附阈值 40px；甩动速度 0.5px/ms；惯性 120–320ms cubic ease-out；深滑提交阈值 = 行宽 50%；飞出后 220ms 提交。
- 左滑 → 右侧面板：修改（品牌蓝）/ 删除（红）。右滑 → 左侧面板：清零（深蓝）；深滑 = 填充态大「清零」直接提交。
- 拖动中 JS 逐帧接管（transition: none），松手后面板 `width 0.24s cubic-bezier(0.22,1,0.36,1)` 吸附。
- 卡内容随剩余宽度 90/150px 两档渐隐；操作按钮图标 20×20 `filter: brightness(0) invert(1)` 翻白，hover `brightness(1.08)`。

### 3.3 FAB 菜单

「批量增加」（跳导入页）/「增加一条」（弹窗）；空态 notice 内嵌同款链接。

---

# 4. 会员页专项规范（cd- 体系）

> 复用 bd- 全部 token 与组件（弹窗/按钮/开关/notice/tabs/排序），以下为会员页新增件。

### 4.1 会员卡三级形态

| 形态 | 尺寸规格 |
| --- | --- |
| 折叠 | 同余额折叠卡；标题 15px、图标 20px；右侧「次数胶囊 + 30px 天数环 + 环旁“天”字」 |
| 半展开 | 同余额展开卡；标题自适应 20–30px（算法同余额）、图标 20–40px（CardMark size 模式，img 元素尺寸=目标尺寸，宽高过渡承担动画）；新增日期区间行（15px，`dotDate` 点分格式）+ 续费摘要行（12px，「续费中」cd-tag + 周期 + MM-DD 扣款）；右侧 65px 天数环 + 环右下角 28px 徽标按钮（expand-down 图标，hover 白 0.95） |
| 全量详情 | 图标固定 22px、卡名固定 18px（**不缩放**）；白卡 L2 阴影；头部点按或「⤒ 收起」回落半展开 |

- 卡底渐变同余额（`cardBgStyle`）；额外挂 `--cd-flag-filter`：名称白字时旗标 `brightness(0) invert(1)` 翻白。
- 沉底两态：`.cd-sunk-expired` = `--bd-zero-card` 灰底 / `#6B727A` 字；`.cd-sunk-usedup` = `--cd-usedup-card` / `--cd-usedup-text`；菱形 0.6 透明；**图标 logo 保持彩色不灰化**（有意为之）。
- 名称行旗标：14×14 SVG（money=自动续费；remind-disable/close-remind=静默态），静默旗标可点（循环档位）；两旗标皆无时不渲染容器。
- 右滑清零提示蒙层 `.cd-dec-hint`：`rgba(1,15,28,0.55)` 全覆盖，进度填充 `rgba(91,187,238,0.4)`，文字 13px/700/白、字距 0.04em「拉到底 · 清空次数」。

### 4.2 DaysRing 天数环（SVG 组件，全内联样式）

| 属性 | 规格 |
| --- | --- |
| 尺寸 | 折叠 `size=30, stroke=3.5, label=''`；半展开 `size=65, stroke=6.5, label='天剩余/天后扣款'`；组件默认 96/10 |
| 几何 | `r = (size − stroke) / 2`；`strokeDasharray = 周长`，`strokeDashoffset = 周长 × (1 − value/max)`；`rotate(-90)` 起点十二点钟、顺时针；端点 `round` |
| 轨道 | `track` 色实心整圆；`max = null` 时只画轨道（纯环无弧） |
| 渐变 | `<linearGradient 0%,0% → 100%,100%>`：from → to 两 stop（useId 防撞） |
| 中心 | 数字 `size×0.42`（≥3 位 `×0.3`）/700/1/tabular-nums；标签 `max(10, size×0.125)`/700/`--au-text-2`；间距 `max(2, size×0.025)` |
| 动画 | `stroke-dashoffset 0.5s ease`；挂载缩放 `cd-ring-grow/shrink 0.32s`（30↔65px）；**小尺寸一律关闭 glow**（光晕滤镜会被矩形裁成方块底） |

**四档色调（RING_TONES，按提醒窗口判定、与静默解耦）**：

| 档 | from → to（弧） | track | valueColor |
| --- | --- | --- | --- |
| normal 绿 | `#8AD8A2 → #27AE60` | `#E2F4E9` | 默认深 |
| expiry 橙 | `#F8B57C → #EE7B3F` | `#FBEEDF` | 默认深 |
| billing 红 | `#F89A9A → #E23C3C` | `#FBE3E3` | 默认深 |
| usedup 灰 | `#C4CBD3 → #6E7780` | `#ECEFF2` | `#565D64` |

优先级：已过期/已用完 → 灰；扣款窗口（≤7 天）→ 红；到期窗口（≤15 天）→ 橙；否则绿。

### 4.3 标签与胶囊

| 类 | 规格 | 用途 |
| --- | --- | --- |
| `.cd-tag` | 11px/700、`2px 8px`、胶囊、`#E3F3FC`+`#1B74A8` | 信息标签：剩 N 天、MM-DD 扣款、续费中 |
| `.cd-tag-plain` | `rgba(255,255,255,0.75)`+`#646464` | 中性标签：本周期静默/永久静默 |
| `.cd-tag-warn` | `#FEE2E2`+`#EF4444` | 警示：新增过期记录 |
| `.cd-side-count` | 同 cd-tag + tabular-nums | 次数胶囊「剩 N 次」；`.cd-side-count-done`（`#EEF1F4`+`#6B727A`）=「已用完」 |

### 4.4 详情区块

- `.cd-block`：卡面渐变上的半透明白块（`rgba(255,255,255,0.55)`、圆角 12、`12px 14px`、margin-top 12）；标题行 13px/700 + 副文字 12px/400 `#646464` + 右侧开关；主体纵排 `gap: 10px`。
- `.cd-form-block`：白底描边版（1px `#E0E0E0`、圆角 12、margin 14px 0）——新增弹窗内用。
- 行内编辑：`.cd-field-inline`（label + 高 34 输入/下拉 + 单位「次」）；草稿流出现「保存/取消」mini 按钮（`gap: 8px`）。
- 提示层级：普通 hint 12px `#646464`；警示 `.cd-hint-warn` = `#FEE2E2`+`#EF4444` 块（8px 10px、圆角 8）；错误 `.cd-field-hint-error` 12px 红字。
- 静默菜单 `.cd-silence-menu`：absolute 于按钮上方、min-width 148、白底 1px 描边、圆角 12、L2 投影、`bd-menu-in 0.3s`；项 `10px 14px` 13px 文字左图标右；点外部自动收起。
- 详情底部操作行：静默按钮（`.cd-btn-on` 选中态 = `#1B74A8` 字）+「修改」按钮（续费卡 `cd-btn-dim`）。

### 4.5 进站 alert 弹层

- 复用弹窗骨架；遮罩 `cd-alert-backdrop z 1030`（全站最高）；标题 17px/700「有 N 张卡需要注意」。
- 条目：`12px 8px`、圆角 12、`gap: 10px`、hover `#F0F2F5`、相邻顶边 1px 分隔；组成 = 9px 记录色点（双圈描边）+ 名称 14px/700 + 标签组（cd-tag 系列）+ 右侧 32px 圆形静默循环按钮（白 0.55 底、1px 描边、16px 图标、hover 白 0.9）。
- 底部主按钮「知道了」。

### 4.6 日历（cd-cal*）

- 容器宽 `--cal-w: min(1040px, 100%)`（列表内），居中突破内容列；白底 1px 描边圆角 12。
- 工具栏：`gap: 10px` 翻页（`‹ ›` 文字按钮）+ 月份 15px/700（min-width 88）+「今天」（当月置灰复用 `.bd-sort-btn-active` 视觉）+ 筛选 + 分段控件。
- 网格：星期行（12px `#939393`、`6px 0`、底线）；周行底线，`min-height: calc(30px + 车道数×22px + 8px)`（`--lanes` JS 内联）；背景列层每列右边线 1px；today 整列 `rgba(91,187,238,0.1)`。
- 日期数字：22px 圆胶囊（圆角 11）12px；today = 品牌蓝底白字 700；非本月 `#939393` 55% 透明。
- **日程条**：车道行高 20px、row-gap 2px；条 `margin: 0 2px; padding: 0 6px`、圆角 6、11px/20px、字色 `rgba(13,38,59,0.85)`、背景 = JS 内联图标主色（正常段）；hover `brightness(0.94)`；**过去段**硬分界双色渐变 `linear-gradient(90deg, #E6E9EC 0 X%, {主色} X% 100%)`（分界精确落在今天列边界）+ 字 `#98A2AD`；**过期条** `#E2E6EA` + `#8A95A1` + line-through；条上图标 14×14 圆角 3；裁剪段延续箭头 `‹ ›` 60% 透明。
- **筛选面板**：宽 250（小屏 220）、白底 1px 描边圆角 12、L2 投影、`bd-fade 0.15s`；搜索框（8px 10px、圆角 8、placeholder「搜索卡名」）；操作行底线分隔；列表项 `7px 6px` 13px、hover `rgba(91,187,238,0.08)`、checkbox + 18px 图标/22px 记录色芯片（`.cd-icon-chip`，内嵌菱形）+ 状态标签；达上限未选项禁用；底部 cap 提示 12px `#939393`。

### 4.7 更新预览对照（导入页）

- `.cd-update-card`：白底 1px 描边圆角 12、`12px 14px`、margin-bottom 8；名称行 13px/700 + 动作标签（覆盖更新=蓝 / 将更新为过期=蓝 / 跳过=plain）。
- `.cd-diff` 行：`gap: 8px`、12px、tabular-nums；字段名 68px 定宽 700 深字 → 旧值（灰）→ `→`（`#939393`）→ 新值（**700 + `#1B74A8`**，break-all）；无变化显示 `.cd-empty-note`（12px `#939393`）。

---

# 5. 图标体系

- **记录图标资产**：`public/small_icon/{key}.png`（清单 `public/icon-manifest.json`，脚本生成）。匹配规则：名称掐头去尾符号 + 小写化后与清单 key **精确命中优先、互相包含次之**；「默认N」兜底图标不参与匹配。
- **语义**：库内 `icon_key = null` → 展示层按名自动匹配（选择器显示「自动」标注）；`'__none__'` → 用户明确选「无」，渲染名称行前 8px 菱形；手动选择落库。加载 404 → onError 回退菱形。
- **UI 线性图标**（`src/assets/icons/`，stroke 风格、随文字色）：`money.svg` 自动续费旗标 / `remind.svg` 提醒中 / `remind-disable.svg` 本周期静默 / `close-remind.svg` 永久静默 / `expand-down.svg` 展开徽标 / `fold-up.svg` 收起 / `delete.svg` 删除 / `minus.svg` 减一 / `clear.svg` 清零 / `editor.svg` 修改。
- 滑动面板/深色底上的图标用 `filter: brightness(0) invert(1)` 统一翻白。

---

# 6. 文案与排版守则

1. 眉题/装饰 = 英文全大写（ASSETS OVERVIEW / MEMBERSHIP OVERVIEW / BALANCE IMPORT / CARDS IMPORT）；功能文案 = 中文；不得混用装饰字体。
2. 数字一律 tabular-nums；金额单位固定「元」；天数单位「天」、次数「次」；会员模块**不出现任何金额**。
3. 日期三种格式：录入与数据 = `YYYY-MM-DD`；卡面区间 = `2026.08.31 − 2026.11.29`（点分）；余额展开行 = `2026年08月31日更新`；日历月 = `2026年9月`。
4. 省略规则：名称、日期 nowrap+ellipsis；自适应标题靠 scale 而非截断；固定宽度列（金额）按淡出公式隐藏。
5. 反馈文案带上下文：成功含对象名（「已添加「Tony-理发季卡」」）；错误给可行动原因；确认弹窗说明后果与替代方案（「只想别吵请用静默」）。
6. 空/加载/错误三态必配：加载 `bd-status-line` + 脉冲点；空态给下一步动作链接；错误红色 notice + 重试路径。

---

# 7. 未来设计应用守则（Checklist）

1. **只复用 token**；需要新颜色先扩 `--au-*`/`--bd-*`/`--cd-*`，禁止硬编码一次性色值。
2. 新页面根容器挂整套 token（照抄 `.bd-board` 变量块），选择器限定在根之下；类名前缀：余额侧 `bd-`、会员侧 `cd-`，互不串用。
3. 骨架套模板：深蓝 hero（渐变 + 水印跟随内容列右缘）+ 分段/工具行 + 内部滚动列表（底部 120px FAB 让位）+ FAB + 弹窗。
4. 内容列 560px（导入页 ≥ 视口 2/3）；所有区块左缘与列对齐。
5. 字号从 1.4 阶梯取；强调只加 700；正文 13px；弹窗输入 16px（iOS）。
6. 圆角按 1.6 阶梯：容器 16、控件 10–12、胶囊 999；描边只有 1px `#E0E0E0`。
7. 阴影按 1.8 三档取，输入框永远无阴影；focus = 蓝描边 + 3px 光环，按钮 focus-visible = 2px outline。
8. 动效：0.15s 瞬时 / 0.32s 结构（spring）；微交互用布局属性不用常驻 transform；入场可用 transform（瞬态）；必配 reduced-motion 兜底。
9. 浮层 z-index 按表插入：展开卡 1000 < FAB 1010 < toast 1015 < 弹窗 1020 < 进站 alert 1030。
10. 记录色只出现在内容载体（卡底/图标/圆环/色点），永不变色；文字对比度按 WCAG 判定，白底深字是保底。
11. 反馈分离：操作 → notice（4s 自灭）；被动发现 → alert；不可逆 → 红色确认弹窗；「重」动作（清零）用深蓝。
12. 滑动手势沿用三色语义与全部常量（66/40/0.5/50%/220ms/90/150px）；新列表直接复用 `CardRow`/`SwipeableBalanceCard` 交互模型。
13. 深蓝渐变只用于头部；彩色卡上新增元素必须考虑 `--bd-card-name-color` 对比度联动（旗标滤镜）。
14. 状态表达优先级：颜色（环色/卡底）+ 文字标签（已用完/扣款）**双通道**，不允许只靠颜色。
15. 文案守则见第 6 节；新模块 PRD 视觉章节引用本文档，不再各自描述数值。
