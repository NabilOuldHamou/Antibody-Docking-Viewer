#!/usr/bin/env node
/**
 * Preprocessing script: converts PLY + RCBR asset files to binary model files
 * for efficient loading in Three.js.
 *
 * Output format per .bin file:
 *   [uint32]  vertCount
 *   [uint32]  triCount
 *   [float32] cx, cy, cz  (original centroid, used to compute dock offsets)
 *   [float32] scale       (20 / longest_extent, used for dock offset computation)
 *   [float32 * vertCount * 3] positions  (already centered & scaled)
 *   [float32 * vertCount * 3] normals    (smooth per-vertex normals)
 *   [uint8  * vertCount * 4] colors      (RGBA, CDR-coloured or gray)
 *   [uint32 * triCount  * 3] indices
 *
 * Run from the anim_web directory:
 *   node scripts/preprocess.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ASSETS   = resolve(__dirname, '../../assets/6bft')
const OUT_DIR  = resolve(__dirname, '../public/models')

mkdirSync(OUT_DIR, { recursive: true })

// ── RCBR parsing ─────────────────────────────────────────────────────────────

function parseRCBR(filename) {
  const text = readFileSync(filename, 'utf-8')
  const residues = []
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 8 || parts[0] !== 'RESIDUE') continue
    residues.push({
      cdr: parts[3],
      x: parseFloat(parts[5]),
      y: parseFloat(parts[6]),
      z: parseFloat(parts[7]),
    })
  }
  return residues
}

function cdrColor(cdr) {
  switch (cdr) {
    case 'PARA': return [0, 255, 0]
    case 'EPI':  return [180, 0, 0]
    default:     return [180, 180, 180]
  }
}

// ── PLY parsing ───────────────────────────────────────────────────────────────

function loadPLY(filename, residues) {
  console.log(`Parsing ${filename} ...`)
  const text  = readFileSync(filename, 'utf-8')
  const lines = text.split('\n')
  let li = 0

  // ── header ─────────────────────────────────────────────────────────────────
  let numVertices = 0
  let numFaces    = 0
  while (li < lines.length && lines[li].trim() !== 'end_header') {
    const parts = lines[li].trim().split(/\s+/)
    if (parts[0] === 'element' && parts[1] === 'vertex') numVertices = parseInt(parts[2])
    if (parts[0] === 'element' && parts[1] === 'face')   numFaces    = parseInt(parts[2])
    li++
  }
  li++ // skip 'end_header'

  // ── vertices ───────────────────────────────────────────────────────────────
  const posRaw = new Float32Array(numVertices * 3)
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity

  for (let vi = 0; vi < numVertices; vi++, li++) {
    const parts = lines[li].trim().split(/\s+/)
    const x = parseFloat(parts[0])
    const y = parseFloat(parts[1])
    const z = parseFloat(parts[2])
    posRaw[vi * 3]     = x
    posRaw[vi * 3 + 1] = y
    posRaw[vi * 3 + 2] = z
    if (x < minX) minX = x;  if (x > maxX) maxX = x
    if (y < minY) minY = y;  if (y > maxY) maxY = y
    if (z < minZ) minZ = z;  if (z > maxZ) maxZ = z
  }

  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const cz = (minZ + maxZ) / 2
  let extent = maxX - minX
  if (maxY - minY > extent) extent = maxY - minY
  if (maxZ - minZ > extent) extent = maxZ - minZ
  const scale = extent > 0 ? 20.0 / extent : 1.0

  // Center and scale vertices
  for (let vi = 0; vi < numVertices; vi++) {
    posRaw[vi * 3]     = (posRaw[vi * 3]     - cx) * scale
    posRaw[vi * 3 + 1] = (posRaw[vi * 3 + 1] - cy) * scale
    posRaw[vi * 3 + 2] = (posRaw[vi * 3 + 2] - cz) * scale
  }

  // ── CDR coloring ───────────────────────────────────────────────────────────
  // Collect non-gray CDR positions (in PLY-space units)
  const cdrPos  = []
  const cdrCols = []
  for (const r of residues) {
    const col = cdrColor(r.cdr)
    if (col[0] !== 180 || col[1] !== 180 || col[2] !== 180) {
      cdrPos.push([(r.x - cx) * scale, (r.y - cy) * scale, (r.z - cz) * scale])
      cdrCols.push(col)
    }
  }

  const vertColors = new Uint8Array(numVertices * 4)
  // Default: gray (180, 180, 180, 255)
  for (let vi = 0; vi < numVertices; vi++) {
    vertColors[vi * 4]     = 180
    vertColors[vi * 4 + 1] = 180
    vertColors[vi * 4 + 2] = 180
    vertColors[vi * 4 + 3] = 255
  }

  if (cdrPos.length > 0) {
    const sqThresh = (8.0 * scale) * (8.0 * scale)
    for (let vi = 0; vi < numVertices; vi++) {
      const vx = posRaw[vi * 3]
      const vy = posRaw[vi * 3 + 1]
      const vz = posRaw[vi * 3 + 2]
      let bestDist = sqThresh
      let bestCol  = null
      for (let ci = 0; ci < cdrPos.length; ci++) {
        const dx = vx - cdrPos[ci][0]
        const dy = vy - cdrPos[ci][1]
        const dz = vz - cdrPos[ci][2]
        const d  = dx * dx + dy * dy + dz * dz
        if (d < bestDist) { bestDist = d; bestCol = cdrCols[ci] }
      }
      if (bestCol) {
        vertColors[vi * 4]     = bestCol[0]
        vertColors[vi * 4 + 1] = bestCol[1]
        vertColors[vi * 4 + 2] = bestCol[2]
      }
    }
  }

  // ── faces (fan triangulation) ──────────────────────────────────────────────
  const indices = []
  for (let fi = 0; fi < numFaces; fi++, li++) {
    const parts = lines[li].trim().split(/\s+/)
    const count = parseInt(parts[0])
    const idxs  = []
    for (let k = 0; k < count; k++) idxs.push(parseInt(parts[1 + k]))
    for (let k = 1; k < count - 1; k++) {
      indices.push(idxs[0], idxs[k], idxs[k + 1])
    }
  }
  const triCount = indices.length / 3

  // ── smooth vertex normals ─────────────────────────────────────────────────
  const normals = new Float32Array(numVertices * 3)
  for (let ti = 0; ti < triCount; ti++) {
    const ai = indices[ti * 3], bi = indices[ti * 3 + 1], ci2 = indices[ti * 3 + 2]
    const ax = posRaw[ai * 3], ay = posRaw[ai * 3 + 1], az = posRaw[ai * 3 + 2]
    const bx = posRaw[bi * 3], by = posRaw[bi * 3 + 1], bz = posRaw[bi * 3 + 2]
    const cx2 = posRaw[ci2 * 3], cy2 = posRaw[ci2 * 3 + 1], cz2 = posRaw[ci2 * 3 + 2]
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx2 = cx2 - ax, vy2 = cy2 - ay, vz2 = cz2 - az
    const nx = uy * vz2 - uz * vy2
    const ny = uz * vx2 - ux * vz2
    const nz = ux * vy2 - uy * vx2
    for (const vi of [ai, bi, ci2]) {
      normals[vi * 3]     += nx
      normals[vi * 3 + 1] += ny
      normals[vi * 3 + 2] += nz
    }
  }
  for (let vi = 0; vi < numVertices; vi++) {
    const nx = normals[vi * 3], ny = normals[vi * 3 + 1], nz = normals[vi * 3 + 2]
    const l  = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (l > 0) {
      normals[vi * 3]     /= l
      normals[vi * 3 + 1] /= l
      normals[vi * 3 + 2] /= l
    }
  }

  console.log(`  → ${numVertices} vertices, ${triCount} triangles`)
  return { posRaw, normals, vertColors, indices: new Uint32Array(indices), triCount, cx, cy, cz, scale }
}

// ── Binary writer ─────────────────────────────────────────────────────────────

function writeBin(outPath, data) {
  const { posRaw, normals, vertColors, indices, triCount, cx, cy, cz, scale } = data
  const vertCount = posRaw.length / 3

  // Header: 8 x uint32/float32 = 32 bytes
  const headerBuf = Buffer.allocUnsafe(32)
  headerBuf.writeUInt32LE(vertCount, 0)
  headerBuf.writeUInt32LE(triCount,  4)
  headerBuf.writeFloatLE(cx,         8)
  headerBuf.writeFloatLE(cy,        12)
  headerBuf.writeFloatLE(cz,        16)
  headerBuf.writeFloatLE(scale,     20)
  headerBuf.writeUInt32LE(0,        24)  // padding
  headerBuf.writeUInt32LE(0,        28)  // padding

  writeFileSync(outPath, Buffer.concat([
    headerBuf,
    Buffer.from(posRaw.buffer),
    Buffer.from(normals.buffer),
    Buffer.from(vertColors.buffer),
    Buffer.from(indices.buffer),
  ]))
  console.log(`Wrote ${outPath}`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

const agRCBR   = parseRCBR(resolve(ASSETS, '6bft_ag.rcbr'))
const abHLRCBR = parseRCBR(resolve(ASSETS, '6bft_ab_hl.rcbr'))
const abABRCBR = parseRCBR(resolve(ASSETS, '6bft_ab_ab.rcbr'))

const agData   = loadPLY(resolve(ASSETS, '6bft_ag.ply'),    agRCBR)
const abHLData = loadPLY(resolve(ASSETS, '6bft_ab_hl.ply'), abHLRCBR)
const abABData = loadPLY(resolve(ASSETS, '6bft_ab_ab.ply'), abABRCBR)

writeBin(resolve(OUT_DIR, 'ag.bin'),    agData)
writeBin(resolve(OUT_DIR, 'ab_hl.bin'), abHLData)
writeBin(resolve(OUT_DIR, 'ab_ab.bin'), abABData)

// Meta JSON: center & scale for each model, needed to compute dock offsets
const meta = {
  ag:   { cx: agData.cx,   cy: agData.cy,   cz: agData.cz,   scale: agData.scale   },
  abHL: { cx: abHLData.cx, cy: abHLData.cy, cz: abHLData.cz, scale: abHLData.scale },
  abAB: { cx: abABData.cx, cy: abABData.cy, cz: abABData.cz, scale: abABData.scale },
}
writeFileSync(resolve(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2))
console.log('Wrote meta.json')
console.log('Done.')
