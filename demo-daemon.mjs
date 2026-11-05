#!/usr/bin/env node
/**
 * demo-daemon.mjs —— 最小可跑的示例：每 15 秒心跳一次，把到点的钟打印出来。
 *
 * 它演示"消费者"该怎么接：
 *   1. 建 consumer，给 stateDir 和一个 onDue
 *   2. 定时调 tick()
 *   3. onDue 里做你自己的投递（这里只打印；真实项目里是投给 agent 的会话）
 *
 * 跑：
 *   node demo-daemon.mjs                       # 用 ./state 当状态目录
 *   node demo-daemon.mjs --dir D:\some\state    # 指定目录
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNudgeConsumer } from './nudge-consumer.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const argDir = process.argv.indexOf('--dir')
const stateDir = argDir >= 0 ? process.argv[argDir + 1] : path.join(ROOT, 'state')
const log = (...a) => console.log(new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a)

const consumer = createNudgeConsumer({
  stateDir,
  log,
  onDue: async (n) => {
    // ↓↓↓ 换成你自己的投递：POST 到本地服务、写进消息队列、调用 agent 的会话接口……
    log(`钟响了 → 「${n.why}」（原定 ${n.when}，现在 ${n.hhmm}）`)
  },
})

log('自鸣钟消费者已启动，状态目录：' + stateDir)
log('挂一个 1 分钟后的钟试试：node nudge-writer.mjs --in 1m --why "测试一下"')

// 每 15 秒一拍。生产里 60 秒足够——钟的粒度本来就是分钟级。
setInterval(() => {
  consumer.tick().catch((e) => log('tick 出错：' + e.message))
}, 15_000)

// 启动时先看一眼有没有已经过期的钟
consumer.tick().catch(() => {})
