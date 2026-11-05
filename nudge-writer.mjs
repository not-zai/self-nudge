#!/usr/bin/env node
/**
 * self-nudge.mjs —— 给我自己挂一个钟
 *
 * 主人 2026-11-05 想的法子：我说完话之后如果想「过一会儿主动找他」，
 * 可以自己往外面挂一个闹钟，到点让 daemon 把我提起来。
 *
 * 关键：钟在外面（daemon 每个 tick 检查这个文件），
 *       但「约不约、约多久、到点说不说」全是我自己的事。
 *
 * 命令：
 *   node self-nudge.mjs --in 30m --why "想问他睡了没"
 *   node self-nudge.mjs --at "2026-11-05 08:30" --why "提醒他带伞"
 *   node self-nudge.mjs --list        看现在还挂着几个
 *   node self-nudge.mjs --due         看现在到点的（daemon 用这个）
 *   node self-nudge.mjs --take        取走到点的并从文件里删掉
 *   node self-nudge.mjs --clear       全清
 *
 * 文件：~/.dsh/state/self-nudge.json
 *   { "updatedAt": "...", "items": [ { id, at, why, createdAt, fired } ] }
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const DSH = path.join(os.homedir(), '.dsh')

// 状态目录可以指到别处（测试 / 多实例都靠它），优先级：
//   --state <dir>          命令行
//   NUDGE_STATE_DIR=<dir>  环境变量
//   默认                    ~/.dsh/state
function pickStateDir() {
  const i = process.argv.indexOf('--state')
  if (i >= 0 && process.argv[i + 1]) return path.resolve(process.argv[i + 1])
  if (process.env.NUDGE_STATE_DIR) return path.resolve(process.env.NUDGE_STATE_DIR)
  return path.join(DSH, 'state')
}
const STATE = pickStateDir()
const FILE = path.join(STATE, 'self-nudge.json')

// ---- 时间工具（全部按 +08:00 算，不依赖系统时区设置）----
function nowMs() {
  return Date.now()
}
function fmt(ms) {
  const d = new Date(ms + 8 * 3600e3)
  return d.toISOString().replace('Z', '+08:00')
}
function parseWhen(str) {
  const s = String(str ?? '').trim()
  if (!s) return null

  // 1) 相对：30m / 2h / 90s / 1h30m
  const rel = s.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/i)
  if (rel && (rel[1] || rel[2] || rel[3])) {
    const ms =
      (Number(rel[1] ?? 0) * 3600 + Number(rel[2] ?? 0) * 60 + Number(rel[3] ?? 0)) * 1000
    if (ms > 0) return nowMs() + ms
  }

  // 2) 绝对：2026-11-05 08:30 / 2026-11-05T08:30 / 08:30（今天或明天）
  const abs = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/)
  if (abs) {
    const [, y, mo, d, h, mi] = abs
    return Date.UTC(+y, +mo - 1, +d, +h - 8, +mi)
  }
  const hm = s.match(/^(\d{2}):(\d{2})$/)
  if (hm) {
    const d = new Date(nowMs() + 8 * 3600e3)
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), +hm[1] - 8, +hm[2])
    if (t <= nowMs()) t += 86400e3
    return t
  }
  return null
}

// ---- 读写（绝不用 PowerShell 的 Set-Content，会带 BOM）----
function read() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    if (Array.isArray(j?.items)) return j
  } catch {
    /* 首次或文件损坏，当作空 */
  }
  return { updatedAt: fmt(nowMs()), items: [] }
}

// 2026-11-05：这个文件有两个写手（我手动跑 + daemon 自动跑），
// 不加锁的话，我 --take 的瞬间可能把 daemon 刚挂的钟覆盖掉。
const LOCK = FILE + '.lock'

function sleepMs(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(50, end - Date.now()))
    } catch {
      /* 退化成忙等，几百毫秒无所谓 */
    }
  }
}

/** 拿锁；拿不到就等，最多等 3 秒 */
function lock() {
  fs.mkdirSync(STATE, { recursive: true })
  const deadline = Date.now() + 3000
  for (;;) {
    try {
      const fd = fs.openSync(LOCK, 'wx')
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)
      return
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      // 锁文件太老（>10 秒）说明上个进程挂了，强行清掉
      try {
        const st = fs.statSync(LOCK)
        if (Date.now() - st.mtimeMs > 10000) {
          fs.rmSync(LOCK, { force: true })
          continue
        }
      } catch {
        /* 锁刚好被别人删了，重试 */
      }
      if (Date.now() > deadline) throw new Error('拿不到锁，可能有别的进程卡住了')
      sleepMs(30)
    }
  }
}

function unlock() {
  try {
    fs.rmSync(LOCK, { force: true })
  } catch {
    /* ignore */
  }
}

/** 原子写：先写 tmp 再 rename，中途断电不会留半个文件 */
function write(obj) {
  fs.mkdirSync(STATE, { recursive: true })
  obj.updatedAt = fmt(nowMs())
  const tmp = FILE + '.' + crypto.randomUUID() + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
    fs.renameSync(tmp, FILE)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/** 所有「读-改-写」都走这里，先拿锁再重读，避免覆盖别人的改动 */
function mutate(fn) {
  lock()
  try {
    const j = read()
    const result = fn(j) ?? j
    write(result)
    return result
  } finally {
    unlock()
  }
}

// ---- 主逻辑 ----
function main() {
  const a = process.argv.slice(2)
  const get = (k) => {
    const i = a.indexOf(k)
    return i >= 0 ? a[i + 1] : undefined
  }

  if (a.includes('--clear')) {
    mutate((j) => {
      j.items = []
    })
    console.log('全清了')
    return
  }

  if (a.includes('--list')) {
    const j = read()
    if (!j.items.length) {
      console.log('现在是空的，一个钟都没挂')
      return
    }
    for (const it of j.items) {
      const left = Math.round((it.at - nowMs()) / 60000)
      console.log(`${fmt(it.at)}  还有 ${left} 分钟  ${it.why ?? ''}`)
    }
    return
  }

  if (a.includes('--due')) {
    const j = read()
    const due = j.items.filter((it) => it.at <= nowMs())
    if (!due.length) {
      console.log('没有到点的')
      return
    }
    for (const it of due) console.log(`${fmt(it.at)}  ${it.why ?? ''}`)
    return
  }

  if (a.includes('--take')) {
    // 关键：拿锁 → 重读 → 只摘掉到点的 → 写回。不能整份覆盖
    let taken = []
    mutate((j) => {
      taken = j.items.filter((it) => it.at <= nowMs())
      j.items = j.items.filter((it) => it.at > nowMs())
    })
    for (const it of taken) console.log(`${fmt(it.at)}  ${it.why ?? ''}`)
    return
  }

  // 挂新钟
  const when = get('--in') ?? get('--at')
  const at = parseWhen(when)
  if (!at) {
    console.error('时间看不懂。用法：--in 30m 或 --at "2026-11-05 08:30"')
    process.exit(2)
  }
  const why = String(get('--why') ?? '').slice(0, 200)
  const item = {
    id: crypto.randomUUID().slice(0, 8),
    at,
    why,
    createdAt: nowMs(),
    fired: false,
  }
  mutate((j) => {
    j.items.push(item)
    j.items.sort((x, y) => x.at - y.at)
  })
  const mins = Math.round((at - nowMs()) / 60000)
  console.log(`挂上了：${fmt(at)}（${mins} 分钟后）${why}`)
}

main()
