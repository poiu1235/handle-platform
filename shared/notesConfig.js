// 便利贴（notes）配置常量——前端与 Cloudflare 层 import 同一份，改配置不出口径分叉。
// 形态对照 shared/cardsConfig.js；每条注释带 PRD 编号（src/doc/notes-wall-prd-v3.md）。

// 正文长度上限（7.1；DB CHECK 与 CF 层同口径，1–500 字）
export const CONTENT_MAX = 500

// 每用户条数上限（9.2-6：物理行数；灵感长期沉淀，较旧版 200 放宽）。
// ⚠ 耦合：CF 层 POST 前以 count 判定 → 409
export const NOTES_CAP = 500

// 截止日窗口上限：due_date ∈ [今天, 今天 + 7]（D5「预约未来日期 7 天为最大期限」）。
// ⚠「今天」按客户端本地日历（payload.today），DB 不承载窗口
export const DUE_MAX_LOOKAHEAD_DAYS = 7

// 无日期备忘的兜底截止 = 创建日 + 7 天（D5：界面不显示倒计时，后台悄悄流转）
export const NO_DATE_TTL_DAYS = 7

// 过期滞留天数：截止日次日 00:00 起再滞留 7 天 → 自动归档（D9；即归档日 =
// 截止日 + 8，联调必测 9/10）
export const EXPIRED_RETENTION_DAYS = 7

// 已完成保留期：进入已完成再过 30 天静默清除（D10；自动行 clear-day = 截止日 +
// 8 + 30，手动行 = finished_at + 30 天）
export const DONE_RETENTION_DAYS = 30

// 完成时刻允许的超前容忍（客户端时钟漂移；DB notes_finish_lock 同口径 5 分钟）
export const FINISHED_CLOCK_SKEW_MS = 5 * 60 * 1000
