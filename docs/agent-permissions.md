# Agent permissions

Because every mutation lives under `ywiki page <verb>`, one deny-all rule plus
per-read allow rules is enough to keep an agent read-only. In OpenCode the last
matching rule wins.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "shell", "resource": "ywiki *", "effect": "ask" },
    { "action": "shell", "resource": "ywiki page *", "effect": "deny" },
    { "action": "shell", "resource": "ywiki page get *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki page search *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki page descendants *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki page locate *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki page history *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki page revision *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki page comments *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki page comment list *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki get *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki search *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki tree *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki spaces *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki space *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki api GET *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki whoami *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki skill *", "effect": "allow" }
  ]
}
```

`deny` keeps an agent read-only; `ask` (or `allow`) permits edits after review.
A new read verb without its own rule is denied — the split fails closed.
