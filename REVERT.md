# Revert ledger — memory-stack-lab

Everything this lab touches, and how to undo it. Research only; nothing here is production.

## Blast radius

| | |
|---|---|
| Lab root | `~/memory-stack-lab` (outside the vault, by design) |
| Vault writes | notes under `projects/versed/` only, via git — revert with `git revert`/`git checkout` |
| Global qmd collections | **none.** Every index is a project-local `.qmd/` inside `runs/` |
| Network pushes | **none.** `upstream/` clones are read-only, never pushed |

## Full undo

> [!warning] `~/memory-stack-lab` holds the ONLY working copy of the Vestige plugin
> It is not a git repo. Before tearing anything down, confirm the vault archives are current:
> `projects/vestige/vestige-plugin.zip` (the deliverable), `projects/vestige/vestige-lab.zip`
> (the benchmark harness around it), `projects/versed/memory-stack-lab-harness.zip` (this lab).
> Everything here is reproducible from those three plus the pinned upstream SHAs. Nothing else is.

```bash
rm -rf ~/memory-stack-lab          # removes harness, corpora, indexes, clones, AND the plugin
```

## Installed for V0 only (recorded as they happen)

| What | Install | Uninstall |
|---|---|---|
| Ollama 0.33.2 | tarball extracted to `~/memory-stack-lab/tools/` (NOT `/usr/local`, no systemd unit) | `rm -rf ~/memory-stack-lab` |
| Ollama models | `OLLAMA_MODELS=~/memory-stack-lab/tools/models` (NOT `~/.ollama`) | same |
| `docs-mcp-server` | `npm install --prefix ~/memory-stack-lab/tools` (local, not `-g`) | same |

No `sudo` was used, no systemd service was created, and no package manager ran. The 262 MB of
model weights and the 4.2 MB docs-mcp store both stayed inside the lab as intended.

**Correction (verified 2026-08-31, after claiming otherwise):** three small files DO land outside
the lab, created on first run regardless of the env vars above. `rm -rf ~/memory-stack-lab` alone
does not remove them:

| Path | What | Remove |
|---|---|---|
| `~/.ollama/id_ed25519`, `.pub` | Ollama identity keypair | `rm -rf ~/.ollama` |
| `~/.ollama/cache/model-recommendations.json` | cached model list | same |
| `~/.local/share/docs-mcp-server/installation.id` | telemetry installation id — written on first run **despite `--telemetry false` on every command** | `rm -rf ~/.local/share/docs-mcp-server` |

Full undo is therefore three commands, not one:

```bash
rm -rf ~/memory-stack-lab ~/.ollama ~/.local/share/docs-mcp-server
```

## Guardrail

`qmd init` / `qmd collection add` are run ONLY from inside `runs/**` index dirs, never from
the lab root and never from a real vault. Verify: `qmd collection list` inside any index dir
must show exactly one collection scoped to a `runs/` path.

## Restarting the lab later

Ollama is not a service here; start it only when running V0:

```bash
cd ~/memory-stack-lab/tools
OLLAMA_MODELS="$PWD/models" ./bin/ollama serve &
```

## Disk

Everything is removed by `rm -rf ~/memory-stack-lab`.
