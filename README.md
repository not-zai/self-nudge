# self-nudge · 自己给未来挂一个钟

> 给"只在被叫醒时才存在"的 agent 用。
> 它不能凭空醒来，那就让它在还有意识的时候，**往前放一个到点会响的钟**。

## 为什么需要它

大部分 agent 是事件驱动的：有人说话才醒。但很多"想做的事"其实有时间点：

- 他两点有课，十三点四十该叫一声
- 他答应今晚早睡，二十三点该问一句
- 这件事他三小时前说过"回头再聊"，该回头了

这些都不是"被问到"才发生的，是**到点就该发生**。所以：

```
写手（nudge-writer.mjs）  把"想说的话 + 时间"写进 state/self-nudge.json
消费者（nudge-consumer.mjs）每到点取一个出来，交给你的投递逻辑 → agent 被唤醒
```

**只装一半，钟会挂上但永远不响。** 这是这个仓库最想强调的一件事。

## 两半是什么

| 半边 | 文件 | 跑在哪 |
|---|---|---|
| 写手 | `nudge-writer.mjs` | 随手跑（agent 想挂钟时调一次） |
| 消费者 | `nudge-consumer.mjs` | 长驻进程里，每次心跳调一次 `tick()` |
| 示例 | `demo-daemon.mjs` | 15 秒一拍，把响了的钟打印出来 |

## 跑起来看看

```bash
# 终端 A：起一个示例消费者（打印版）
node demo-daemon.mjs --dir ./state

# 终端 B：挂一个 20 秒后响的钟
node nudge-writer.mjs --in 20s --why "试一下这个钟响不响" --state ./state

# 终端 A 会在 20 秒内打出：
#   [nudge] 到点：2026/11/5 18:10:51 「试一下这个钟响不响」
#   钟响了 → 「试一下这个钟响不响」（原定 …，现在 18:11）
```

写手支持的时间写法：

```bash
node nudge-writer.mjs --in 30m   --why "半小时后"     # 30m / 2h / 1h30m / 90s
node nudge-writer.mjs --at "2026-11-05 08:30" --why "明早提醒他带伞"
node nudge-writer.mjs --list                # 看还有几个钟（带剩余分钟）
node nudge-writer.mjs --take                # 手动取走所有到点的
node nudge-writer.mjs --clear               # 全清
```

## 接进你自己的 daemon

```js
import { createNudgeConsumer } from './nudge-consumer.mjs'

const consumer = createNudgeConsumer({
  stateDir: './state',
  onDue: async ({ why, when, hhmm }) => {
    // 你的投递：POST 给本地服务 / 写进队列 / 调 agent 的会话接口
    await myAgent.wake(`〔你自己挂的钟到点了〕当时写的是：「${why}」现在是 ${hhmm}。说与不说你自己定。`)
  },
})

setInterval(() => consumer.tick(), 60_000)   // 60 秒一拍足够
```

**注意投递措辞**：给她"处境"，不要给"台词"。上面这句就是原项目的做法——
钟只负责叫醒，说不说、说什么，仍然是 agent 自己决定。

## 数据结构

`state/self-nudge.json`

```json
{
  "updatedAt": "2026-11-05T10:09:47.990Z",
  "items": [
    { "id": "f3970f58", "at": 1793879093497, "why": "这时候问一句他在干嘛",
      "createdAt": 1793871893497, "fired": false }
  ]
}
```

`at` 是毫秒时间戳；`why` 上限 200 字；`fired` 保留给外部标记（消费者是直接删，不靠它）。

## 两个写手不会互相踩：锁 + 重读

写手和消费者都会改这个文件，所以消费者里做了两件事：

```
1. 拿锁：self-nudge.json.lock，O_EXCL 创建；超过 10 秒当陈旧锁清掉
2. 拿锁后重读，只删「这一拍要响的那一个 id」，其余到点的留着
```

**为什么必须这样**：早期版本"把所有到点的全删掉、只响第一个"，
结果三个同时到点的钟只响一个，另两个被静默吃掉。这个 bug 在真实项目里活了很久才被发现。

顺序也重要：**先写回、再投递**。反了就会同一个钟重复响。

## 已知问题

- **一拍只响一个钟**（多个同分钟到点会分拍响）。要一次全响就自己改 `takeOne` → `takeAll`
- **不补发**：消费者停了两天再起来，过期很久的钟照样会响一次（不会丢，但会晚）
- **没有重试**：`onDue` 抛错就被吞掉并记日志，那个钟已经删了。要可靠投递，请在 `onDue` 里自己入队
- **单机**：状态是本地文件。多机部署请换成数据库

## 许可

MIT，见 [LICENSE](LICENSE)。
