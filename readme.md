# pi configs

beware: garbage code. i mainly just tell pi what settings i want
to change and it patches without any regard for good
config practices.

This repo is a **pi package** — it is not a standalone application. It is loaded by a pi instance via `~/.config/pi/agent/settings.json` as a package source:


```json
{
  "packages": [
    {
      "source": "/Users/blink/Code/pi-harness",
      "extensions": [
        "+extensions/ask-user-question.ts",
        "+extensions/modes.ts",
        "+extensions/pi-undo-redo.ts",
        "+extensions/vim-quit.ts",
        "+extensions/ui/index.ts",
        "+extensions/orchestration/index.ts"
      ]
    }
  ]
}
```
