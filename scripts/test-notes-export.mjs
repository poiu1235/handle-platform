// 便利贴导出判据（src/lib/notesExport.js + src/lib/xlsxWriter.js）。
// 运行：npm run test:notes-export。断言风格对照 test-notes-domain.mjs（手工计数 + ✓/✗）。
//
// 两块各自独立：表构建只验口径（剔除清除行 / 状态文案 / 截止日期来源 / 排序），
// 写出器只验容器与 XML 转义——CRC 用 node 的 zlib.crc32 复算（第三方实现，
// 不用写出器自己的表），zip 条目由测试侧独立解析，避免「自己写自己读」的自证。
// 时区：夹具时间戳统一取本地正午，跨 UTC−11…UTC+11 都落在同一本地日，
// 与 test-notes-domain.mjs 同一手法。

import { crc32 as nodeCrc32 } from 'node:zlib'
import { buildNotesExport, exportFileName, EXPORT_HEADERS } from '../src/lib/notesExport.js'
import { buildXlsx, XLSX_MIME } from '../src/lib/xlsxWriter.js'
import { localDayOf } from '../shared/notesDomain.js'

let failed = 0
function check(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect)
  if (ok) {
    console.log(`✓ ${name}`)
  } else {
    failed += 1
    console.log(`✗ ${name}：期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(actual)}`)
  }
}
function checkTrue(name, cond, detail = '') {
  if (cond) {
    console.log(`✓ ${name}`)
  } else {
    failed += 1
    console.log(`✗ ${name}${detail ? `：${detail}` : ''}`)
  }
}

const T = '2026-09-12' // 今天（查看设备本地日历）
const NOW = Date.parse('2026-09-12T12:00:00Z')

const row = (over = {}) => ({
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'memo',
  content: '内容',
  pinned: false,
  due_date: null,
  finished_at: null,
  created_at: '2026-09-12T12:00:00Z',
  ...over,
})

// ── 表构建：行范围 ──
{
  const rows = [
    row({ id: 'a', content: '今天到期', due_date: '2026-09-12' }),
    row({ id: 'b', content: '过期三天', due_date: '2026-09-09' }),
    row({ id: 'c', content: '自动归档', due_date: '2026-09-02' }), // 距今 10 天 → done-auto，未清除
    row({ id: 'd', content: '手动完成', finished_at: '2026-09-01T12:00:00Z' }),
    row({ id: 'e', content: '灵感', kind: 'idea' }),
    row({ id: 'f', content: '早该清掉', due_date: '2026-08-01' }), // 距今 42 天 ≥ 38 → 已清除
    row({ id: 'g', content: '手动早就清掉', finished_at: '2026-08-01T12:00:00Z' }), // 42 天 ≥ 30 → 已清除
  ]
  const { exported, cleared } = buildNotesExport(rows, T, NOW)
  check('未清除行数（7 行里剔 2 行）', exported, 5)
  check('被剔除的清除行计数', cleared, 2)
  check('非数组入参当空表', buildNotesExport(null, T, NOW).exported, 0)
}

// ── 表构建：列内容与面板口径逐字对齐 ──
{
  const byId = (over) => buildNotesExport([row(over)], T, NOW).sheet.rows[0]
  check('正常备忘（列 1 类型 / 列 2 内容 / 列 3 状态）', byId({ content: '买牛奶', due_date: '2026-09-15' }).slice(0, 3), ['备忘', '买牛奶', '正常'])
  check('已过期徽标天数与 expiredDays 同口径', byId({ due_date: '2026-09-09' })[2], '已过期 3 天')
  check('手动完成标识', byId({ finished_at: '2026-09-01T12:00:00Z' })[2], '手动完成')
  check('超期自动归档标识', byId({ due_date: '2026-09-02' })[2], '超期自动归档')
  check('灵感不参与流转（永远正常）', byId({ kind: 'idea' })[2], '正常')
  check('用户设过的截止日期原样给', byId({ due_date: '2026-09-15' })[3], '2026-09-15')
  check('未设日期标出推算来源', byId({ created_at: '2026-09-10T12:00:00Z' })[3], '推算 2026-09-17')
  check('灵感没有日期概念 → 空', byId({ kind: 'idea' })[3], '')
  check('置顶列中文是/否', byId({ pinned: true })[4], '是')
  check('灵感无完成时间', byId({ kind: 'idea' })[6], '')
  check(
    '手动完成行给出完成时刻（列数校验）',
    byId({ finished_at: '2026-09-01T12:00:00Z' })[6].slice(0, 10),
    '2026-09-01'
  )
  checkTrue(
    '时间列形状为 YYYY-MM-DD HH:mm',
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(byId({})[5]),
    `实际 ${byId({})[5]}`
  )
  checkTrue(
    '创建时间列的本地日与面板 agoText 同一天',
    byId({ created_at: '2026-09-10T12:00:00Z' })[5].slice(0, 10) === localDayOf('2026-09-10T12:00:00Z')
  )
  check('表头数量 = 列数', EXPORT_HEADERS.length, 7)
  check('文件名带当天日期', exportFileName(T), '便利贴导出-2026-09-12.xlsx')
}

// ── 表构建：排序 = 创建时间倒序（与主时间线同一支序）──
{
  const { sheet } = buildNotesExport(
    [
      row({ id: 'old', content: '旧', created_at: '2026-09-10T12:00:00Z' }),
      row({ id: 'new', content: '新', created_at: '2026-09-12T12:00:00Z' }),
      row({ id: 'mid', content: '中', created_at: '2026-09-11T12:00:00Z' }),
    ],
    T,
    NOW
  )
  check('创建倒序', sheet.rows.map((r) => r[1]), ['新', '中', '旧'])
}

// ── 写出器：zip 容器（条目由测试侧独立解析、CRC 用 node zlib 复算）──
const td = new TextDecoder()
const bytes = buildXlsx({
  name: '便利贴/改名:测试', // 非法字符应被剥掉并截到 31 字符
  header: EXPORT_HEADERS,
  widths: [8, 60],
  rows: [
    ['备忘', '第一行\n第二行 & <标签> \u0001', '正常', '2026-09-15', '否', '2026-09-12 12:00', ''],
  ],
})

function parseZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('找不到中央目录结束记录')
  const total = dv.getUint16(eocd + 10, true)
  const cdSize = dv.getUint32(eocd + 12, true)
  const cdOffset = dv.getUint32(eocd + 16, true)
  const entries = []
  let p = cdOffset
  for (let n = 0; n < total; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error(`第 ${n} 条中央目录签名不对`)
    const method = dv.getUint16(p + 10, true)
    const crc = dv.getUint32(p + 16, true)
    const size = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const localOff = dv.getUint32(p + 42, true)
    const name = td.decode(buf.subarray(p + 46, p + 46 + nameLen))
    if (dv.getUint32(localOff, true) !== 0x04034b50) throw new Error(`${name} 本地头签名不对`)
    const localNameLen = dv.getUint16(localOff + 26, true)
    const localExtraLen = dv.getUint16(localOff + 28, true)
    const dataStart = localOff + 30 + localNameLen + localExtraLen
    entries.push({
      name,
      method,
      crc,
      size,
      data: buf.subarray(dataStart, dataStart + size),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return { entries, cdSize, total, cdOffset }
}

{
  check('zip 本地头签名', [...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04])
  let parsed
  try {
    parsed = parseZip(bytes)
  } catch (err) {
    checkTrue('zip 可被解析', false, err.message)
  }
  if (parsed) {
    checkTrue('zip 可被解析', true)
    check(
      '部件清单',
      parsed.entries.map((e) => e.name),
      [
        '[Content_Types].xml',
        '_rels/.rels',
        'xl/workbook.xml',
        'xl/_rels/workbook.xml.rels',
        'xl/styles.xml',
        'xl/worksheets/sheet1.xml',
      ]
    )
    check('全部条目为 Stored（method 0）', parsed.entries.every((e) => e.method === 0), true)
    check(
      '每条 CRC 与 node zlib 复算一致',
      parsed.entries.every((e) => nodeCrc32(e.data) >>> 0 === e.crc),
      true
    )
    check(
      '中央目录末条之后正是 EOCD',
      parsed.cdOffset + parsed.cdSize === bytes.length - 22,
      true
    )

    const part = (name) => td.decode(parsed.entries.find((e) => e.name === name).data)
    const sheet = part('xl/worksheets/sheet1.xml')
    const row2 = sheet.slice(sheet.indexOf('<row r="2"'), sheet.indexOf('</row>', sheet.indexOf('<row r="2"')))
    // 逐码位判存在性：写成正则字符类会被 no-control-regex 拦（夹具里就是要放一个控制字符）
    const hasRawControl = [...sheet].some((ch) => {
      const c = ch.codePointAt(0)
      return c < 0x20 && c !== 0x9 && c !== 0xa && c !== 0xd
    })

    checkTrue(
      '换行写成 &#10;，包内不留裸控制字符',
      sheet.includes('第一行&#10;第二行') && !hasRawControl,
      row2
    )
    checkTrue(
      '& < > 全部转义、控制字符换成空格',
      sheet.includes('第二行 &amp; &lt;标签&gt;  '),
      row2
    )
    checkTrue(
      'sheet 名非法字符被剥掉',
      part('xl/workbook.xml').includes('<sheet name="便利贴改名测试" sheetId="1" r:id="rId1"/>'),
      part('xl/workbook.xml')
    )
    checkTrue('表头行走加粗样式 s="1"', /<row r="1"><c r="A1" s="1" t="inlineStr">/.test(sheet), sheet.slice(0, 260))
    checkTrue('数据行不带 s 属性', /<row r="2"><c r="A2" t="inlineStr">/.test(sheet), row2)
    checkTrue('dimension 覆盖到 G 列第 2 行', sheet.includes('<dimension ref="A1:G2"/>'), '')
    checkTrue('列宽按传入值写出', sheet.includes('<col min="1" max="1" width="8" customWidth="1"/>'), '')
    checkTrue(
      'styles 里第 2 个 xf 引用加粗字体',
      part('xl/styles.xml').includes('<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'),
      ''
    )
    checkTrue(
      'workbook rels 同时指向 sheet1 与 styles',
      part('xl/_rels/workbook.xml.rels').includes(
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      ) &&
        part('xl/_rels/workbook.xml.rels').includes(
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        ),
      ''
    )
  }
  check('MIME 常量', XLSX_MIME, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
}

// ── 写出器：空表（只有表头）也要能出合法包 ──
{
  const empty = parseZip(buildXlsx({ name: '便利贴', header: EXPORT_HEADERS, rows: [] }))
  check('空表 sheet1 尺寸非零', empty.entries.find((e) => e.name === 'xl/worksheets/sheet1.xml').size > 0, true)
  check('空表 dimension 只含表头行', td.decode(empty.entries.find((e) => e.name === 'xl/worksheets/sheet1.xml').data).includes('<dimension ref="A1:G1"/>'), true)
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 个断言失败`)
process.exit(failed === 0 ? 0 : 1)
