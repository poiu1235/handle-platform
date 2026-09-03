// 生活会员 · 前后端共用常量（PRD v1.5）。
// Cloudflare 层用它做校验（配置窗口/枚举——DB CHECK 不承载可调配置，见 src/cards-db.md），
// 前端用它渲染表单选项与提醒窗口；两边 import 同一份，改配置不会出现口径分叉。

// ── 校验配置（PRD D14：两个独立配置，改动只需调这里）────────────────────────
// 配置 A：起始日回溯上限（B3：起始日 ∈ [今天−N 年, 今天]）——防解析垃圾（1970 式兜底值）
export const START_DATE_MAX_LOOKBACK_YEARS = 2
// 配置 B：DDL 前瞻上限（B2：DDL ≤ 今天+N 年）——防 2099 式脏数据；
// 外部依据：预付卡监管趋势收紧（3/5 年及终身卡受限），不够再调
// ⚠ 耦合：supabase/cards.sql 导入 RPC 的无限期物化默认值硬编码 interval '2 years'
//   （= 本配置初始值）；调整本值时必须同步修改 SQL（src/cards-db.md 第 9 节 6 / 第 12 节）
export const DDL_MAX_HORIZON_YEARS = 2

// ── 提醒窗口（PRD D5，均含端点日，窗口制）──────────────────────────────────
export const EXPIRY_REMINDER_DAYS = 15 // 到期窗口：[DDL−15, DDL]
export const BILLING_REMINDER_DAYS = 7 // 扣款窗口：[扣款日−7, 扣款日]

// ── 枚举 ───────────────────────────────────────────────────────────────
// B34：预设示例 + 可配置枚举；DB 存 key，UI 显示 label
export const CATEGORIES = [
  { key: 'fitness', label: '健身' },
  { key: 'yoga', label: '瑜伽' },
  { key: 'massage', label: '按摩' },
  { key: 'haircut', label: '理发' },
  { key: 'carwash', label: '洗车' },
  { key: 'nail', label: '美甲' },
  { key: 'media', label: '影音会员' },
  { key: 'other', label: '其他' },
]

export const BILLING_CYCLES = [
  { key: 'week', label: '每周' },
  { key: 'month', label: '每月' },
  { key: 'quarter', label: '每季' },
  { key: 'year', label: '每年' },
]

// 静默模式（B22）：'cycle' 随顺延/结算自动解除，'forever' 仅手动解除
export const MUTED_MODES = ['none', 'cycle', 'forever']
