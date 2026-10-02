// ============================================================
// 极简 .xlsx 写出器：单 sheet、单元格一律文本、ZIP 条目不压缩（method=0 Stored）。
// 只在网页端使用，零依赖、无 DOM——产物是 Uint8Array，调用方自己包 Blob 下载。
//
// 两个刻意的取舍（都不是「不能」，是「不值当」）：
//   · 不压缩：便利贴单用户上限 500 行（notesConfig NOTES_CAP），压缩省的那点体积
//     换不开一个 CRC/DEFLATE 实现；ZIP 规范把 Stored 列为合法方法，Excel 认未压缩的 OPC 包。
//   · 不用共享字符串表：inlineStr（<is><t>）省掉 stringTable 部件与去重逻辑，
//     500 行量级的解析成本对 Excel 可忽略。
//
// 表头加粗 + 冻结首行需要 styles.xml 与 sheetView/pane，两者都留了最小形态；
// styles 里刻意不引用 theme 颜色，这样包里不必带 theme1.xml 部件。
// ============================================================

export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const utf8 = new TextEncoder()

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const NS_DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const NS_PKG_CT = 'http://schemas.openxmlformats.org/package/2006/content-types'

const HEADER_STYLE = 1 // cellXfs 里第 2 个 xf = 加粗，表头行专用

// ---------- XML 文本 ----------

// XML 1.0 不接受的控制字符（textarea 粘贴可带进来）一律换成空格：Excel 自己的
// _xHHHH_ 转义要额外处理「原文就有 _x0001_」的二义，对导出场景是过度设计。
// \r 折成 \n，\n 保留（写成 &#10;，单元格内换行），\t 属合法字符原样走。
function xmlText(value) {
  const source = String(value ?? '').replace(/\r\n?/g, '\n')
  let out = ''
  for (const ch of source) {
    const c = ch.codePointAt(0)
    const valid =
      c === 0x9 ||
      c === 0xa ||
      (c >= 0x20 && c <= 0xd7ff) ||
      (c >= 0xe000 && c <= 0xfffd) ||
      (c >= 0x10000 && c <= 0x10ffff)
    if (c === 0x26) out += '&amp;'
    else if (c === 0x3c) out += '&lt;'
    else if (c === 0x3e) out += '&gt;'
    else if (c === 0xa) out += '&#10;'
    else out += valid ? ch : ' '
  }
  return out
}

// 0→A、25→Z、26→AA
function columnName(index) {
  let n = index + 1
  let name = ''
  while (n > 0) {
    const rest = (n - 1) % 26
    name = String.fromCharCode(65 + rest) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

// ---------- OOXML 部件 ----------

function contentTypesXml() {
  return (
    `${XML_HEADER}<Types xmlns="${NS_PKG_CT}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>'
  )
}

function rootRelsXml() {
  return (
    `${XML_HEADER}<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${NS_DOC_REL}/officeDocument" Target="xl/workbook.xml"/>` +
    '</Relationships>'
  )
}

function workbookXml(name) {
  return (
    `${XML_HEADER}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_DOC_REL}">` +
    `<sheets><sheet name="${xmlText(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`
  )
}

function workbookRelsXml() {
  return (
    `${XML_HEADER}<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${NS_DOC_REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="${NS_DOC_REL}/styles" Target="styles.xml"/>` +
    '</Relationships>'
  )
}

function stylesXml() {
  return (
    `${XML_HEADER}<styleSheet xmlns="${NS_MAIN}">` +
    '<fonts count="2">' +
    '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
    '</fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'
  )
}

function cellXml(ref, value, styleIdx) {
  const style = styleIdx ? ` s="${styleIdx}"` : ''
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`
}

function sheetXml(sheet) {
  const { header, rows, widths } = sheet
  const cols = widths?.length
    ? `<cols>${widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join('')}</cols>`
    : ''

  const body = [header, ...rows]
    .map((cells, r) => {
      const styleIdx = r === 0 ? HEADER_STYLE : 0
      const inner = cells
        .map((value, c) => cellXml(`${columnName(c)}${r + 1}`, value, styleIdx))
        .join('')
      return `<row r="${r + 1}">${inner}</row>`
    })
    .join('')

  const lastCol = columnName(Math.max(header.length, ...rows.map((r) => r.length)) - 1)
  return (
    `${XML_HEADER}<worksheet xmlns="${NS_MAIN}">` +
    `<dimension ref="A1:${lastCol}${rows.length + 1}"/>` +
    '<sheetViews><sheetView workbookViewId="0">' +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '</sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    cols +
    `<sheetData>${body}</sheetData>` +
    '</worksheet>'
  )
}

// sheet 名：Excel 限制 31 字符，且不许出现 \ / ? * [ ] :
function safeSheetName(name) {
  return (String(name ?? 'Sheet1').replace(/[\\/?*[\]:]/g, '') || 'Sheet1').slice(0, 31)
}

// ---------- ZIP（Stored） ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosStamp(now) {
  return {
    time: (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
    // ZIP 的时间戳从 1980 年起算，早于 1980 的时钟（如本机时间被改坏）夹到 1980
    date: ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
  }
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

// entries: [{ name, bytes }]
function zipStore(entries, stamp) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const name = utf8.encode(entry.name)
    const size = entry.bytes.length
    const crc = crc32(entry.bytes)

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0, true) // flags：部件名与内容各自处理，这里不放 UTF-8 位
    lv.setUint16(8, 0, true) // method = Stored
    lv.setUint16(10, stamp.time, true)
    lv.setUint16(12, stamp.date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true) // 压缩后 = 原始（未压缩）
    lv.setUint32(22, size, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true) // extra 长度
    local.set(name, 30)
    locals.push(local, entry.bytes)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0, true) // flags
    cv.setUint16(10, 0, true) // method = Stored
    cv.setUint16(12, stamp.time, true)
    cv.setUint16(14, stamp.date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, name.length, true)
    // 30..41：extra / comment / disk / 属性，全 0
    cv.setUint32(42, offset, true) // 本地头偏移
    central.set(name, 46)
    centrals.push(central)

    offset += local.length + size
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(4, 0, true) // 本盘编号
  ev.setUint16(6, 0, true) // CD 所在盘
  ev.setUint16(8, entries.length, true) // 本盘条目数
  ev.setUint16(10, entries.length, true) // 总条目数
  ev.setUint32(12, centralSize, true) // CD 字节数
  ev.setUint32(16, offset, true) // CD 起始偏移
  // 20：注释长度 = 0（整包 22 字节，无注释）
  return concat([...locals, ...centrals, end])
}

// ---------- 出口 ----------

// 入参 sheet = { name, header: string[], rows: (string|number)[][], widths?: number[] }
// 返回整个 .xlsx 的字节；单元格一律文本（导出的表没有需要参与计算的数值列）
export function buildXlsx(sheet) {
  const safe = { ...sheet, name: safeSheetName(sheet.name) }
  const entries = [
    { name: '[Content_Types].xml', bytes: utf8.encode(contentTypesXml()) },
    { name: '_rels/.rels', bytes: utf8.encode(rootRelsXml()) },
    { name: 'xl/workbook.xml', bytes: utf8.encode(workbookXml(safe.name)) },
    { name: 'xl/_rels/workbook.xml.rels', bytes: utf8.encode(workbookRelsXml()) },
    { name: 'xl/styles.xml', bytes: utf8.encode(stylesXml()) },
    { name: 'xl/worksheets/sheet1.xml', bytes: utf8.encode(sheetXml(safe)) },
  ]
  return zipStore(entries, dosStamp(new Date()))
}
