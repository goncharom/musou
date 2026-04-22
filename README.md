# pi-musou

Musou is a small pi extension that watches your session and proposes improvements to existing `AGENTS.md` files and skill docs.

## What it does

- tracks session activity
- periodically runs a background analysis
- suggests updates to instruction files
- lets you review proposals before applying them

## Install

Published package:

```bash
pi install npm:pi-musou
```

From git:

```bash
pi install git:github.com/you/pi-musou
```

From this repo:

```bash
pi install -l .
```

Run without installing:

```bash
pi -e .
```

## Use

Reload or start pi, then use:

- `/musou`
- `/musou-review`
- `/musou-status`

## Config

Optional config files:

- `~/.pi/agent/musou.json`
- `.pi/musou.json`

Project config overrides global config.

Example:

```json
{
  "musouEvery": 20,
  "maxFileLengthChars": 4000,
  "timeoutMs": 120000,
  "thinkingLevel": "medium"
}
```

Fields:

- `musouEvery`
- `maxFileLengthChars`
- `timeoutMs`
- `thinkingLevel`

Per-file cap override:

```md
<!-- musou-cap: 8000 -->
```

## Targets

Musou proposes changes for existing files under:

- `~/.pi/agent/AGENTS.md`
- `./AGENTS.md`
- `~/.pi/agent/skills/**/*.md`
- `.pi/skills/**/*.md`

It can also propose new skill markdown files under the skill roots above.

## Notes

- review is always explicit
- accepted proposals are written directly to disk
- Musou requires a persisted session; it does not run in `--no-session` mode
