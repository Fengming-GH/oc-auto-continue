# @fengming-gh/oc-auto-continue

OpenCode auto-resume plugin.

## Features

- Auto-resume on transient errors: `MessageOutputLengthError`, `APIError`, `UnknownError` (terminated)
- Auto-reload AGENTS.md after context compaction
- Zero UI pollution — operates entirely in the background

## Install

```json
{
  "plugin": ["@fengming-gh/oc-auto-continue"]
}
```

## Behavior

| Event | Action |
|-------|--------|
| `APIError` / `MessageOutputLengthError` | Auto-sends "continue" |
| `UnknownError` (terminated) | Auto-resumes with "侦测到 terminated" |
| Context compaction | Sends prompt to re-read AGENTS.md |
