// 扫描 public/small_icon/ 下的图标文件，生成 public/icon-manifest.json
// 前端（新增/修改弹窗的图标选择器 + 自动匹配建议）靠这份清单知道"现在有哪些图标可选"，
// 不需要额外维护配置——往 public/small_icon/ 里扔一张图，重新构建一次清单就会更新。
//
// 用法：node scripts/gen-icon-manifest.js
// 建议接到 package.json 的 build 脚本前面，例如：
//   "build": "node scripts/gen-icon-manifest.js && vite build"

import { readdirSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ICON_DIR = join(__dirname, '..', 'public', 'small_icon')
const OUT_FILE = join(__dirname, '..', 'public', 'icon-manifest.json')

function main() {
  if (!existsSync(ICON_DIR)) {
    console.warn(`[icon-manifest] 没找到目录 ${ICON_DIR}，写出空清单`)
    writeFileSync(OUT_FILE, JSON.stringify([]))
    return
  }

  const keys = readdirSync(ICON_DIR)
    .filter((f) => /\.png$/i.test(f))
    .map((f) => f.replace(/\.png$/i, ''))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))

  writeFileSync(OUT_FILE, JSON.stringify(keys))
  console.log(`[icon-manifest] 写入 ${keys.length} 个图标到 ${OUT_FILE}`)
}

main()