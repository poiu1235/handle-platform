// scripts/generate-icon-colors.mjs
//
// 用法：
//   npm install node-vibrant
//   node scripts/generate-icon-colors.mjs
//
// 扫描 public/small_icon/*.png，为每张图提取主色（按聚类像素占比/面积从大到小
// 排序），写出 src/lib/iconColors.json。图片文件名（去掉扩展名）就是 icon key，
// 不需要在文件名里塞颜色。

import { Vibrant } from 'node-vibrant/node'
import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ICON_DIR = path.resolve('public/small_icon')
const OUTPUT_FILE = path.resolve('src/lib/iconColors.json')
const MAX_COLORS = 5

async function extractColors(filePath) {
  // getPalette 返回若干 swatch，每个 swatch 带 population（聚类像素数，
  // 近似“面积”），按 population 降序排列就是“主色面积从大到小”。
  const palette = await Vibrant.from(filePath).getPalette()
  const swatches = Object.values(palette).filter(Boolean)
  swatches.sort((a, b) => b.population - a.population)
  return swatches.slice(0, MAX_COLORS).map((s) => s.hex)
}

async function main() {
  const files = (await readdir(ICON_DIR)).filter((f) => /\.png$/i.test(f))
  const manifest = {}
  const failed = []

  for (const file of files) {
    const key = file.replace(/\.png$/i, '')
    try {
      manifest[key] = await extractColors(path.join(ICON_DIR, file))
      console.log(`✓ ${key}: ${manifest[key].join(', ')}`)
    } catch (err) {
      failed.push(key)
      console.warn(`✗ ${key}: ${err.message}`)
    }
  }

  await writeFile(OUTPUT_FILE, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
  console.log(`\n写入 ${OUTPUT_FILE}，共 ${Object.keys(manifest).length} 个，失败 ${failed.length} 个`)
  if (failed.length) console.log('失败列表：', failed.join(', '))
}

main()
