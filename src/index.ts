import type { Plugin } from "@opencode-ai/plugin"
import type { EventMessageUpdated, EventSessionIdle, EventSessionCreated, EventSessionDeleted, EventSessionCompacted, AssistantMessage, Session } from "@opencode-ai/sdk"
import { appendFileSync, mkdirSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const CONTINUE_ERRORS = new Set(["MessageOutputLengthError", "APIError", "UnknownError"])
const pending = new Map<string, boolean>()
const sidTitle = new Map<string, string>()

function t(sid: string): string {
  return sidTitle.get(sid) ?? "?" + sid.slice(0, 8)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOG_PATH = resolve(__dirname, "log", "auto-continue.log")

function bjNow(): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(new Date()).replace(/\//g, "-")
}

function log(level: string, msg: string) {
  try {
    appendFileSync(LOG_PATH, `${bjNow()} [${level}] ${msg}\n`, "utf-8")
  } catch {
    // best effort
  }
}

export const AutoContinuePlugin: Plugin = async ({ client }) => {
  await client.app.log({
    body: {
      service: "auto-continue",
      level: "info",
      message: "auto-continue plugin loaded",
    },
  })

  try { mkdirSync(dirname(LOG_PATH), { recursive: true }) } catch { /* ok */ }
  log("INFO", "++++++++ plugin loaded ++++++++")

  setTimeout(async () => {
    try {
      const resp: any = await client.session.list()
      const all: Session[] = Array.isArray(resp) ? resp : resp.data ?? []
      for (const s of all) {
        if (!s.parentID) sidTitle.set(s.id, s.title)
      }
      log("INFO", `init: ${sidTitle.size} sessions`)
    } catch (err) {
      log("INFO", `init fail: ${err}`)
    }
  }, 0)

  return {
    event: async ({ event }) => {
      // Auto-continue: detect error → mark pending
      if (event.type === "message.updated") {
        const ev = event as EventMessageUpdated
        const msg = ev.properties.info
        if (msg.role === "assistant") {
          const am = msg as AssistantMessage
          const err = am.error
          const finish = am.finish
          if (err && CONTINUE_ERRORS.has(err.name)) {
            log("MSG_DONE", `[${t(msg.sessionID)}] finish=${finish ?? "(none)"} err=${err.name}`)
            pending.set(msg.sessionID, true)
          }
        }
        return
      }

      // === session lifecycle: maintain title cache ===
      if (event.type === "session.created") {
        const ev = event as EventSessionCreated
        const s = ev.properties.info
        if (!s.parentID) {
          sidTitle.set(s.id, s.title)
          log("SESSION", `[${t(s.id)}] created`)
        }
        return
      }

      if (event.type === "session.updated") {
        const ev: any = event
        const s: Session = ev.properties.info
        if (!s.parentID && sidTitle.has(s.id)) {
          const old = sidTitle.get(s.id)!
          if (old !== s.title) {
            sidTitle.set(s.id, s.title)
            log("SESSION", `[${old}] → [${s.title}]`)
          }
        }
        return
      }

      if (event.type === "session.deleted") {
        const ev = event as EventSessionDeleted
        const s = ev.properties.info
        const title = sidTitle.get(s.id)
        pending.delete(s.id)
        sidTitle.delete(s.id)
        if (title) log("SESSION", `[${title}] deleted`)
        return
      }

      // Auto-continue: session idle → resume if pending
      if (event.type === "session.idle") {
        const ev = event as EventSessionIdle
        const sid = ev.properties.sessionID
        log("IDLE", `[${t(sid)}] pending=${!!pending.get(sid)}`)
        if (!pending.get(sid)) return
        pending.delete(sid)

        try {
          await client.session.prompt({
            path: { id: sid },
            body: {
              parts: [{
                type: "text",
                text: "侦测到 terminated，继续你刚才的工作",
              }],
            },
          })
          log("AUTO_CONTINUE", `[${t(sid)}] resume sent`)
        } catch (err) {
          log("AUTO_CONTINUE_FAIL", `[${t(sid)}] ${err}`)
        }
        return
      }

      // Context compression → re-read AGENTS.md
      if (event.type === "session.compacted") {
        const ev = event as EventSessionCompacted
        const sid = ev.properties.sessionID
        log("COMPACTED", `[${t(sid)}] compacted`)

        try {
          await client.session.prompt({
            path: { id: sid },
            body: {
              parts: [{
                type: "text",
                text: "[上下文已压缩] 请重新读取项目根目录下的 AGENTS.md 以恢复项目上下文和规则。",
              }],
            },
          })
          log("COMPACTED_OK", `[${t(sid)}] prompt sent`)
        } catch (err) {
          log("COMPACTED_FAIL", `[${t(sid)}] ${err}`)
        }
      }
    },
  }
}
