# @fengming-gh/oc-auto-continue

OpenCode 自动续命插件 — 让 AI 工作持久化。

## 痛点描述

### 场景一：AI 被 terminated（网络不稳定中断）

AI 在运行过程中，因网络波动或 provider 侧异常导致连接断开，消息显示 terminated，AI 停在当前工作一半的位置。

**传统做法：** 人工发消息让 AI "继续"。

### 场景二：AI 输出太长被截断

AI 输出了大量数据，达到 token 上限，消息显示 finish=length，AI 停在半句话。

**传统做法：** 人工点继续。

### 场景三：API 突然报错

API 调用失败，AI 被打断。人不在电脑前时，任务白跑。

### 场景四：上下文压缩后失忆

对话进行到一定时间后上下文超长，OC 自动压缩。压缩后 AI 不再记得项目结构、代码规范、当前任务进度。

**传统做法：** 手动告诉 AI "重新读一下 AGENTS.md"。

---

## 工作机制

### 错误检测流程

事件链：message.updated → assistant 消息 → error 字段 → 匹配 CONTINUE_ERRORS

```
message.updated 事件触发
  ↓
检查是否为 assistant 消息
  ↓
检查 assistant 消息是否有 error 字段
  ↓
检查 error.name 是否在 CONTINUE_ERRORS 集合中
  ↓
匹配 → 写 MSG_DONE 日志 → pending.set(sessionID, true)
不匹配 → 忽略
  ↓
返回
```

CONTINUE_ERRORS 定义了需要续命的错误类型：

```typescript
CONTINUE_ERRORS = ["MessageOutputLengthError", "APIError", "UnknownError"]
```

| 错误类型 | 触发条件 |
|:---------|:---------|
| UnknownError | 网络不稳定 / provider 侧中断（terminated） |
| MessageOutputLengthError | AI 输出达到 token 上限 |
| APIError | API 调用失败、超时、限流 |

### 续命触发流程

事件链：session.idle → 检查 pending → 发 prompt → 日志

```
session.idle 事件触发
  ↓
检查 pending.get(sessionID) 是否为 true
  ↓
  false → 忽略，返回
  true  → 继续
  ↓
pending.delete(sessionID)   // 消费掉，避免重复续命
  ↓
发送续命消息：
"侦测到 terminated，继续你刚才的工作"
  ↓
成功 → log("AUTO_CONTINUE")
失败 → log("AUTO_CONTINUE_FAIL")
```

注意：续命只在**该会话 idle 且 pending 标记为 true** 时触发。如果用户自己已经开始输入新消息，pending 在 idle 时已被清除，不会干扰。

### 压缩续命流程

事件链：session.compacted → 立即发 prompt → 重读规则

```
session.compacted 事件触发
  ↓
写 COMPACTED 日志
  ↓
发送消息：
"[上下文已压缩] 请重新读取项目根目录下的 AGENTS.md ，若有未尽事宜就继续。"
  ↓
成功 → log("COMPACTED_OK")
失败 → log("COMPACTED_FAIL")
```

压缩续命**不依赖 pending 标记**，每次压缩都触发。

### 会话标题缓存

启动时 setTimeout(0) 调用 client.session.list()，通过 session.created/updated/deleted 事件增量维护。仅用于日志显示可读的会话名称（如 `[项目研发]` 而非 `[ses_12dc...]`）。

---

## 续命场景对照表

| 触发条件 | 错误类型 | 判断方式 | 恢复行为 |
|:---------|:---------|:---------|:---------|
| 网络不稳定 / provider 中断 | UnknownError | message.updated + error.name | 发送"侦测到 terminated，继续你刚才的工作" |
| AI 输出达到 token 上限 | MessageOutputLengthError | message.updated + error.name | 发送"继续" |
| API 调用失败/超时 | APIError | message.updated + error.name | 发送"继续" |
| 上下文超长被压缩 | 无（非错误） | session.compacted | 发送"重新读取 AGENTS.md，若有未尽事宜就继续" |
| 用户主动输入了消息 | 无 | session.idle → pending=false | 不触发，等用户自己继续 |

---

## 完整交互示例

### 场景 A：被 terminated → 自动续命

```
[「项目研发」会话中，AI 正在重构代码]
  ↓（网络波动导致连接断开，显示 terminated）
  ↓
[auto-continue 检测到 UnknownError，标记 pending]
  ↓（会话 idle → pending=true → 触发续命）
  ↓
[项目研发 会话收到续命消息]
  侦测到 terminated，继续你刚才的工作
  ↓
AI 恢复：刚才分析到 BLE 重连时序的 rx_timeout...
继续：rx_timeout 应该改成 500ms，因为...
```

### 场景 B：上下文压缩 → 自动重读规则

```
[「项目研发」会话已运行较长时间，上下文超长]
  ↓
OC 自动执行 context compaction
  ↓
auto-continue 检测到 session.compacted
  ↓
[项目研发 会话收到提示]
  [上下文已压缩] 请重新读取项目根目录下的 AGENTS.md ，若有未尽事宜就继续。
  ↓
AI：好的，已重新读取 AGENTS.md，了解项目规则和当前进度。
若有未尽事宜，继续之前的工作...
```

---

## 关键技术决策

| 决策 | 实现 | 原因 |
|:----|:-----|:------|
| 续命时机 | session.idle + pending 标记 | 避免重复续命，防止无限循环 |
| 错误类型集合 | 白名单（只处理已知类型） | 不会因为未知错误盲目续命 |
| 压缩续命 | 每次压缩都触发 | 压缩必然丢失上下文，安全 |
| 续命消息 | 中文明文 | AI 理解准确，不会混淆 |
| 日志 | 独立文件 appendFileSync | 排查问题无需看 OC 主日志 |
| 标题缓存 | 事件驱动 | 日志可读性好 |

---

## 日志

位置：.opencode/plugins/log/auto-continue.log

```
2026-06-22 03:04:39 [INFO] ++++++++ plugin loaded ++++++++
2026-06-22 03:04:39 [INFO] init: 4 sessions
2026-06-22 03:06:17 [COMPACTED] [项目研发] compacted
2026-06-22 03:06:17 [COMPACTED_OK] [项目研发] prompt sent
2026-06-22 03:53:34 [MSG_DONE] [项目研发] finish=(none) err=UnknownError
2026-06-22 03:53:34 [IDLE] [项目研发] pending=true
2026-06-22 03:53:34 [AUTO_CONTINUE] [项目研发] resume sent
```

---

## 安装

```json
{
  "plugin": ["@fengming-gh/oc-auto-continue"]
}
```

OC 启动时自动安装。
