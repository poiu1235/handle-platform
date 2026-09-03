// 黄金测试数据（src/cards-db.md 第 12 节预留 #4）：导入预览分类（classifyImport，
// JS / 预览）与 import_my_cards（SQL / 落库）双实现共同的对账基准——覆盖同名合并、
// 缺失保留、行级过期三分支、周期表示互斥清洗、4-B31 次数打包忽略。
// 任何一侧改动必须双跑通过，防"预览显示 A、落库变成 B"的静默分叉。
//
// 运行 JS 侧断言：npm run test:cards（scripts/test-cards-domain.mjs）。
// SQL 侧在 Supabase SQL Editor 中以本文件用例为脚本手工比对（免费档无本地库）。
//
// v3（2026-09-02）：卡名即展示名（merchant 已并入 name），无 indefinite 列；
// 无表头默认列序 = 卡名 / 起始日 / 终止日期 / 剩余次数 / 每周期次数 /
// 自动续费 / 扣款周期 / 合同天数 / 扣款日（9 列）。

export const TODAY = '2026-08-31'

// 库内快照（进站时 GET /api/cards 返回的行，节选判定相关字段）
export const LOADED = [
  {
    id: 'c1', name: '超鹿30次卡',
    start_date: '2026-06-01', end_date: '2026-09-30',
    total_sessions: 30, remaining_sessions: 8,
    auto_renew: false, billing_cycle: null, period_days: null, next_billing_date: null,
    muted: 'none',
  },
  {
    id: 'c2', name: '爱奇艺月会员',
    start_date: '2026-08-14', end_date: '2026-09-14',
    total_sessions: null, remaining_sessions: null,
    auto_renew: true, billing_cycle: 'month', period_days: null, next_billing_date: '2026-09-14',
    muted: 'none',
  },
  {
    id: 'c3', name: '理发季卡',
    start_date: '2026-05-01', end_date: '2026-08-20',
    total_sessions: null, remaining_sessions: null,
    auto_renew: false, billing_cycle: null, period_days: null, next_billing_date: null,
    muted: 'none',
  },
  {
    id: 'c4', name: '按摩月卡',
    start_date: '2026-08-13', end_date: '2026-09-13',
    total_sessions: 8, remaining_sessions: 0, // 次数用完（能力开启）
    auto_renew: true, billing_cycle: 'month', period_days: null, next_billing_date: '2026-09-13',
    muted: 'none',
  },
  {
    id: 'c5', name: '健身年卡',
    start_date: '2025-10-01', end_date: '2026-09-30',
    total_sessions: null, remaining_sessions: null, // 次数能力未开启（4-B31 判据列）
    auto_renew: true, billing_cycle: 'year', period_days: null, next_billing_date: '2026-09-30',
    muted: 'none',
  },
  {
    // 曾开过续费后关闭的卡：4-B20 规定关闭时扣款字段保留——auto_renew=false 但
    // 扣款信息完整，用于验证"翻转续费开 + 行内缺扣款日 → 保留现值放行"
    id: 'c6', name: '洗车月卡',
    start_date: '2026-07-01', end_date: '2026-12-31',
    total_sessions: null, remaining_sessions: null,
    auto_renew: false, billing_cycle: 'month', period_days: null, next_billing_date: '2026-09-15',
    muted: 'none',
  },
]

export const CASES = [
  {
    name: '同名合并：逐字段取最后一个非缺失值',
    text: [
      '卡名\t终止日期\t剩余次数',
      '超鹿30次卡\t2026-12-31\t5',
      '超鹿30次卡\t\t12',
    ].join('\n'),
    expect: {
      creates: 0,
      updates: 1,
      errors: 0,
      assert: (r) => {
        const u = r.updates[0]
        if (u.row.end_date !== '2026-12-31') return 'end_date 应取最后一条的 2026-12-31'
        if (u.row.remaining_sessions !== 12) return 'remaining_sessions 应取最后一条的 12'
        if (u.action !== 'update') return '应为覆盖更新'
        const diff = Object.fromEntries(u.diff.map((d) => [d.field, d.new]))
        if (diff.end_date !== '2026-12-31' || diff.remaining_sessions !== 12) return 'diff 应只含 end_date 与 remaining_sessions'
        if (u.diff.length !== 2) return 'diff 不应包含未变化字段'
        return null
      },
    },
  },
  {
    name: '更新行缺失字段保留现值（缺失 = 键不出现）',
    text: '超鹿30次卡\t\t\t3',
    expect: {
      creates: 0,
      updates: 1,
      errors: 0,
      assert: (r) => {
        const u = r.updates[0]
        if (u.row.end_date !== undefined) return '行内未携带 end_date，不应出现'
        const diff = Object.fromEntries(u.diff.map((d) => [d.field, d.new]))
        if (diff.remaining_sessions !== 3 || Object.keys(diff).length !== 1) return 'diff 应只有 remaining_sessions 8 → 3'
        return null
      },
    },
  },
  {
    name: '新增行默认值 + 次数能力随数据开启',
    text: '美甲次卡\t\t\t18',
    expect: {
      creates: 1,
      updates: 0,
      errors: 0,
      assert: (r) => {
        const c = r.creates[0]
        if (c.action !== 'insert') return '应为新增'
        const labels = c.defaults.map((d) => d.label).join(',')
        if (!labels.includes('起始日期') || !labels.includes('终止日期') || !labels.includes('自动续费')) {
          return `默认标注应含 起始日期/终止日期/自动续费，实际：${labels}`
        }
        if (c.sessionsOn !== true) return '携带剩余次数 → 次数能力开启'
        return null
      },
    },
  },
  {
    name: '三分支①：行过期 + 库内正常 → 将更新为过期（判死落库）',
    text: '超鹿30次卡\t\t2026-08-20',
    expect: {
      creates: 0,
      updates: 1,
      errors: 0,
      assert: (r) => {
        const u = r.updates[0]
        if (u.action !== 'update_to_expired') return `应为 update_to_expired，实际 ${u.action}`
        return null
      },
    },
  },
  {
    name: '三分支②：行过期 + 库内已过期 → 跳过',
    text: '理发季卡\t\t2026-08-01',
    expect: {
      creates: 0,
      updates: 1,
      errors: 0,
      assert: (r) => {
        if (r.updates[0].action !== 'skip_expired') return '应为 skip_expired'
        return null
      },
    },
  },
  {
    name: '三分支③：行过期 + 库内没有 → 新增过期记录（起始日须 ≤ DDL）',
    text: '旧健身年卡\t2025-09-01\t2026-08-01',
    expect: {
      creates: 1,
      updates: 0,
      errors: 0,
      assert: (r) => {
        if (r.creates[0].action !== 'insert_expired') return '应为 insert_expired（4-B4 记录已结束的卡）'
        return null
      },
    },
  },
  {
    name: '新增过期行缺起始日 → 行报错（DDL 早于默认起始日今天）',
    text: '旧洗车卡\t\t2026-08-01',
    expect: { creates: 0, updates: 0, errors: 1 },
  },
  {
    name: '互斥清洗镜像：更新行带 period_days → diff 应显示 billing_cycle 置空',
    text: '爱奇艺月会员\t\t\t\t\t\t\t30\t2026-09-14',
    expect: {
      creates: 0,
      updates: 1,
      errors: 0,
      assert: (r) => {
        const u = r.updates[0]
        const diff = Object.fromEntries(u.diff.map((d) => [d.field, d.new]))
        if (diff.period_days !== 30) return 'period_days 应写入 30'
        if (diff.billing_cycle !== null) return '互斥清洗：billing_cycle 应显示置空'
        return null
      },
    },
  },
  {
    name: '4-B31 打包忽略：次数能力未开启 + 更新行带 remaining/total → 忽略不报错',
    text: '健身年卡\t\t\t20\t30',
    expect: {
      creates: 0,
      updates: 1,
      errors: 0,
      assert: (r) => {
        const u = r.updates[0]
        if (!u.ignoredSessions) return '应标注次数字段打包忽略（能力未开启，机器不得擅自恢复）'
        if (u.diff.some((d) => d.field === 'remaining_sessions' || d.field === 'total_sessions')) {
          return 'diff 不应包含被忽略的次数字段'
        }
        return null
      },
    },
  },
  {
    name: '4-B31 次数用完卡（能力开启）更新剩余次数 → 正常更新',
    text: '按摩月卡\t\t\t2',
    expect: {
      creates: 0,
      updates: 1,
      errors: 0,
      assert: (r) => {
        const u = r.updates[0]
        if (u.ignoredSessions) return '能力开启（remaining 非 NULL）不应忽略'
        const diff = Object.fromEntries(u.diff.map((d) => [d.field, d.new]))
        if (diff.remaining_sessions !== 2) return 'remaining_sessions 应 0 → 2'
        return null
      },
    },
  },
  {
    // 用户裁定 2026-09-03：续费开缺扣款日 → 自动取终止日期（不报错）；
    // 周期/天数缺失仍行报错（cards_renew_complete）
    name: '新增行续费开缺扣款日 → 自动取终止日期为扣款日',
    text: '新瑜伽卡\t\t2026-12-31\t\t\t是\t月',
    expect: {
      creates: 1,
      updates: 0,
      errors: 0,
      assert: (r) => {
        const c = r.creates[0]
        if (c.row.next_billing_date !== '2026-12-31') return '扣款日应自动取终止日期 2026-12-31'
        return null
      },
    },
  },
  {
    name: '行级报错：行内同时携带扣款周期与合同天数（互斥）',
    text: '新瑜伽卡\t\t2026-12-31\t\t\t是\t月\t30\t2026-12-31',
    expect: { creates: 0, updates: 0, errors: 1 },
  },
  {
    name: '行级报错：新增行只带每周期次数、缺剩余次数',
    text: '新普拉提卡\t\t\t\t20',
    expect: { creates: 0, updates: 0, errors: 1 },
  },
  {
    name: '行级报错：total_sessions ≤ 0',
    text: '新拳击卡\t\t\t\t10\t0',
    expect: { creates: 0, updates: 0, errors: 1 },
  },
  {
    name: '行级报错：起始日超出配置 A 窗口（早于今天−2 年）',
    text: '古董卡\t2023-01-01\t2026-12-31',
    expect: { creates: 0, updates: 0, errors: 1 },
  },
  {
    name: '行级报错：DDL 晚于今天 + 配置 B（2099 式脏数据）',
    text: '超长卡\t2026-08-31\t2099-12-31',
    expect: { creates: 0, updates: 0, errors: 1 },
  },
  {
    // 用户裁定 2026-09-03（二次修订）：续费行扣款日一律强制 = 生效 DDL——
    // 行内显式扣款日 2026-10-01 被忽略，落库为合成后的终止日期 2026-12-31
    name: '续费行扣款日强制 = DDL（行内显式扣款日被忽略）',
    text: '爱奇艺月会员\t\t2026-12-31\t\t\t\t\t\t2026-10-01',
    expect: {
      creates: 0,
      updates: 1,
      errors: 0,
      assert: (r) => {
        const u = r.updates[0]
        const diff = Object.fromEntries(u.diff.map((d) => [d.field, d.new]))
        if (diff.end_date !== '2026-12-31') return 'end_date 应 2026-09-14 → 2026-12-31'
        if (diff.next_billing_date !== '2026-12-31') return '扣款日应强制 = 新终止日期 2026-12-31（行内 2026-10-01 被忽略）'
        return null
      },
    },
  },
  {
    name: '宽容忽略：auto_renew=false 携带扣款字段不报错（B26）',
    text: '超鹿30次卡\t\t\t\t\t否\t月\t\t2026-09-14',
    expect: {
      creates: 0,
      updates: 1,
      errors: 0,
      assert: (r) => {
        const u = r.updates[0]
        if (!u.ignoredBilling) return 'resolved 续费为关 → 扣款字段应标注忽略'
        if (u.diff.some((d) => d.field === 'next_billing_date' || d.field === 'billing_cycle')) {
          return 'diff 不应包含被忽略的扣款字段'
        }
        return null
      },
    },
  },
  {
    // 用户裁定 2026-09-03：合并态缺扣款日（行内未带且库内为空）→ 自动取库内
    // 终止日期，不再行报错；周期/天数缺失仍行报错
    name: '更新行翻转 auto_renew=true 缺扣款日 → 自动取库内终止日期',
    text: '超鹿30次卡\t\t\t\t\t是\t月',
    expect: {
      creates: 0,
      updates: 1,
      errors: 0,
      assert: (r) => {
        const u = r.updates[0]
        const diff = Object.fromEntries(u.diff.map((d) => [d.field, d.new]))
        if (diff.auto_renew !== true) return 'auto_renew 应 false → true'
        if (diff.next_billing_date !== '2026-09-30') return '扣款日应自动取库内终止日期 2026-09-30'
        return null
      },
    },
  },
  {
    // 4-B20「关闭续费时扣款字段保留」的洗车月卡 + 行内翻转续费开：扣款日不再
    // 保留旧现值——强制 = 生效 DDL（2026-12-31），对齐"续费卡 DDL ≡ 扣款日"，
    // diff = auto_renew + next_billing_date 两条
    name: '更新行翻转 auto_renew=true（现值完整）→ 扣款日强制 = 库内 DDL',
    text: '洗车月卡\t\t\t\t\t是',
    expect: {
      creates: 0,
      updates: 1,
      errors: 0,
      assert: (r) => {
        const u = r.updates[0]
        const diff = Object.fromEntries(u.diff.map((d) => [d.field, d.new]))
        if (diff.auto_renew !== true) return 'auto_renew 应 false → true'
        if (diff.next_billing_date !== '2026-12-31') return '扣款日应强制 = 库内终止日期 2026-12-31（旧现值 2026-09-15 被覆盖）'
        if (u.diff.length !== 2) return `diff 应只有 auto_renew 与 next_billing_date（实际 ${u.diff.map((d) => d.field).join(',')}）`
        return null
      },
    },
  },
]
