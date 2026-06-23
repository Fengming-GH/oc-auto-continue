# @fengming-gh/oc-auto-continue

OpenCode auto-resume plugin — keep your AI working continuously.

## Pain Points

### Scenario 1: AI terminated (network instability)

The AI is disconnected mid-work due to network fluctuations or provider issues. The session shows "terminated" and the AI stops halfway.

**Without plugin:** Manually send "continue" to the AI.

### Scenario 2: Output truncated (token limit reached)

The AI generates too much output, hits the token limit, and stops mid-sentence (finish=length).

**Without plugin:** Manually click "continue" and hope the AI remembers where it was.

### Scenario 3: API error

API call fails, the AI is interrupted. If nobody is at the computer, the work is lost.

### Scenario 4: Context compaction amnesia

After a long session, OpenCode automatically compacts the context. The AI no longer remembers project structure, coding standards, or the current task.

**Without plugin:** Manually tell the AI "re-read AGENTS.md".

---

## How It Works

### Error Detection

Event chain: message.updated → assistant message → error field → match CONTINUE_ERRORS

```
message.updated event fires
  ↓
Check if it's an assistant message
  ↓
Check if assistant message has an error field
  ↓
Check if error.name is in CONTINUE_ERRORS set
  ↓
Match → log("MSG_DONE") → pending.set(sessionID, true)
No match → ignore
  ↓
Return
```

CONTINUE_ERRORS defines which errors trigger auto-resume:

```typescript
CONTINUE_ERRORS = ["MessageOutputLengthError", "APIError", "UnknownError"]
```

| Error Type | Trigger |
|:-----------|:--------|
| UnknownError | Network instability / provider interrupt (terminated) |
| MessageOutputLengthError | AI output reached token limit |
| APIError | API call failed, timeout, or rate limited |

### Resume Flow

Event chain: session.idle → check pending → send prompt → log

```
session.idle event fires
  ↓
Check pending.get(sessionID) === true
  ↓
  false → ignore, return
  true  → continue
  ↓
pending.delete(sessionID)   // consume the flag
  ↓
Send resume message:
"侦测到 terminated，继续你刚才的工作"
  ↓
Success → log("AUTO_CONTINUE")
Fail    → log("AUTO_CONTINUE_FAIL")
```

Resume only triggers when **the session is idle AND pending is set**. If the user has already typed a new message, pending is cleared on idle and won't interfere.

### Compaction Resume

Event chain: session.compacted → immediately send prompt → re-read rules

```
session.compacted event fires
  ↓
log("COMPACTED")
  ↓
Send message:
"[上下文已压缩] 请重新读取项目根目录下的 AGENTS.md ，若有未尽事宜就继续。"
  ↓
Success → log("COMPACTED_OK")
Fail    → log("COMPACTED_FAIL")
```

Compaction resume always triggers (no pending flag check), because compaction always loses context.

### Session Title Cache

On startup, `setTimeout(0)` calls `client.session.list()`. Maintained incrementally via session.created/updated/deleted events. Used only for readable session names in logs (e.g., `[项目研发]` instead of `[ses_12dc...]`).

---

## Resume Scenarios

| Trigger | Error Type | Detection | Recovery |
|:--------|:-----------|:----------|:---------|
| Network instability / provider interrupt | UnknownError | message.updated + error.name | Send "侦测到 terminated，继续你刚才的工作" |
| AI output hit token limit | MessageOutputLengthError | message.updated + error.name | Send "continue" |
| API call failed / timeout | APIError | message.updated + error.name | Send "continue" |
| Context compaction | N/A (not an error) | session.compacted | Send "re-read AGENTS.md" |
| User typed a new message | N/A | session.idle → pending=false | No action, let user continue |

---

## Usage Examples

### Scenario A: AI terminated → auto-resume

```
[In "项目研发" session, AI is refactoring code]
  ↓ (Network fluctuation causes termination)
  ↓
[auto-continue detects UnknownError, sets pending]
  ↓ (Session idle → pending=true → resume triggered)
  ↓
[Session receives resume message]
  "侦测到 terminated，继续你刚才的工作"
  ↓
AI resumes: was analyzing BLE reconnection timing...
Continues: rx_timeout should be 500ms because...
```

### Scenario B: Context compaction → re-read rules

```
[Session has been running for hours, context too long]
  ↓
OC executes context compaction
  ↓
auto-continue detects session.compacted
  ↓
[Session receives message]
  "[上下文已压缩] 请重新读取项目根目录下的 AGENTS.md ，
   若有未尽事宜就继续。"
  ↓
AI: Re-read AGENTS.md, understand project rules and current progress.
Continuing previous work...
```

---

## Key Design Decisions

| Decision | Implementation | Rationale |
|:---------|:---------------|:----------|
| Resume timing | session.idle + pending flag | Prevents duplicate resumes and infinite loops |
| Error set | Whitelist of known types | Won't blindly resume on unknown errors |
| Compaction resume | Always triggers | Compaction always loses context, safe to always resume |
| Resume message | Plain text | AI understands accurately, no confusion |
| Logging | appendFileSync | Debug without checking OC main logs |
| Title cache | Event-driven | Readable log output |

---

## Log

Location: .opencode/plugins/log/auto-continue.log

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

## Install

```json
{
  "plugin": ["@fengming-gh/oc-auto-continue"]
}
```

OC auto-installs on startup.
