/**
 * nudge-consumer.mjs —— 自鸣钟的"消费者"半边（写手是 nudge-writer.mjs）。
 *
 * 为什么拆成两半
 *   写手只负责"把话存到未来"，不负责叫醒谁；消费者负责"到点了把它取出来、交给你的 agent"。
 *   只装一半的结果是：钟挂上了，永远不响。
 *
 * 这份是从真实项目里**节选 + 重写**的独立实现（原版长在一个 1000 行的 daemon 里）。
 * 语义与写手完全对齐：
 *   - 同一份 self-nudge.json
 *   - 同一把锁 self-nudge.json.lock（O_EXCL 创建，>10 秒视为陈旧锁清掉）
 *   - 先写回（原子写、无 BOM）再投递 —— 顺序反了会重复响
 *   - 一拍只取一个钟，其余到点的留在文件里（别一次把人砸醒三回）
 *
 * 用法：
 *   const consumer = createNudgeConsumer({ stateDir, onDue })
 *   await consumer.tick()          // 每次心跳调一次（60 秒足够）
 *
 * onDue({ id, at, why, when, hhmm }) 里做你的事——投给会话、发通知、打印都行。
 * 消费者不替你说话，只说"有个钟到点了"。
 */

import fs from 'node:fs'
import path from 'node:path'

const LOCK_STALE_MS = 10_000

export function createNudgeConsumer({ stateDir, onDue, log = () => {} } = {}) {
  if (!stateDir) throw new Error('createNudgeConsumer: 需要 stateDir')
  const FILE = path.join(stateDir, 'self-nudge.json')
  const LOCK = FILE + '.lock'

  const readState = () => {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return null }
  }

  /** O_EXCL 创建锁；EEXIST 且超过 10 秒 → 当陈旧锁清掉再试一次 */
  function acquire() {
    const tryOnce = () => {
      try { return fs.openSync(LOCK, 'wx') } catch (e) { return (e && e.code === 'EEXIST') ? null : undefined }
    }
    let fd = tryOnce()
    if (fd === undefined) return { ok: false, release() {} }
    if (fd === null) {
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(LOCK)
          fd = tryOnce()
        }
      } catch { fd = tryOnce() }
    }
    if (fd === null || fd === undefined) return { ok: false, release() {} }
    try { fs.closeSync(fd) } catch { /* ignore */ }
    return { ok: true, release() { try { fs.unlinkSync(LOCK) } catch { /* ignore */ } } }
  }

  /** 取一个到点的钟（没有就返回 null）。写回是原子的、无 BOM。 */
  function takeOne(now = Date.now()) {
    const peek = readState()
    const peekItems = Array.isArray(peek?.items) ? peek.items : []
    if (!peekItems.some((i) => i && !i.fired && Number(i.at) <= now)) return null

    const lock = acquire()
    if (!lock.ok) return null                     // 写手正在写，下一拍再来
    try {
      // 拿锁后必须重读：这中间写手可能刚挂了个新钟，整份覆盖会把它抹掉
      const st = readState()
      const items = Array.isArray(st?.items) ? st.items : []
      const due = items
        .filter((i) => i && !i.fired && Number(i.at) <= now)
        .sort((a, b) => Number(a.at) - Number(b.at))
      if (!due.length) return null

      const item = due[0]
      const rest = items.filter((i) => i.id !== item.id)   // 只删这一个 id
      const tmp = FILE + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ ...st, items: rest, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8')
      fs.renameSync(tmp, FILE)
      return item
    } catch (e) {
      log('[nudge] 写回失败：' + (e?.message ?? e))
      return null
    } finally {
      lock.release()
    }
  }

  /** 一次心跳：取一个到点的钟，交给 onDue */
  async function tick() {
    const item = takeOne()
    if (!item) return { fired: false }
    const at = new Date(Number(item.at))
    const payload = {
      id: item.id,
      at: Number(item.at),
      why: String(item.why ?? '').slice(0, 200),
      when: at.toLocaleString('zh-CN', { hour12: false }),
      hhmm: new Date().toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5),
    }
    log(`[nudge] 到点：${payload.when} 「${payload.why}」`)
    try { await onDue?.(payload) } catch (e) { log('[nudge] onDue 抛错：' + (e?.message ?? e)) }
    return { fired: true, ...payload }
  }

  /** 还剩几个钟（只读，给诊断用） */
  function pending() {
    const st = readState()
    const items = Array.isArray(st?.items) ? st.items : []
    return items.filter((i) => i && !i.fired).map((i) => ({
      id: i.id,
      why: i.why,
      at: Number(i.at),
      leftMin: Math.max(0, Math.round((Number(i.at) - Date.now()) / 60000)),
    }))
  }

  return { tick, pending, takeOne, file: FILE, lock: LOCK }
}
