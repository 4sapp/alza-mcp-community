# Running the live canary from a home or office machine

The scheduled workflow (`.github/workflows/live-canary.yml`) cannot see Alza from GitHub-hosted runners: Cloudflare challenges their IPs whatever client is used (re-tested 2026-10-07, see `docs/gap-analysis.md`). `scripts/local-canary.sh` runs the same read-only checks (`scripts/validate-api.ts`) from a machine where Alza answers, and reports the same way:

- **a check fails:** one `canary` issue is opened, or commented on if it is already open
- **everything passes:** the open `canary` issue gets a comment and is closed
- **Cloudflare challenges this machine too:** nothing is filed

It works in its own clone (default `~/.cache/alza-mcp-canary`), never in your working tree, and is anonymous (`ALZA_TOKEN_FILE=none`). It needs git, Node 20+, npm, python3 (optional, for the sidecar) and an authenticated GitHub CLI (`gh auth status`) with permission to file issues.

```bash
CANARY_DRY_RUN=1 scripts/local-canary.sh   # run the checks, print the summary, touch nothing on GitHub
scripts/local-canary.sh                    # run for real
```

## Daily systemd user timer

`~/.config/systemd/user/alza-mcp-canary.service`:

```ini
[Unit]
Description=alza-mcp live canary

[Service]
Type=oneshot
Environment=PATH=%h/.nvm/versions/node/current/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash %h/.local/bin/alza-mcp-canary
TimeoutStartSec=30min
```

`~/.config/systemd/user/alza-mcp-canary.timer`:

```ini
[Unit]
Description=Daily alza-mcp live canary

[Timer]
OnCalendar=*-*-* 06:17:00
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
```

Copy the script to `~/.local/bin/alza-mcp-canary` (the script updates its own clone, so don't point the service at that clone), set `PATH` to wherever your `node` lives, then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now alza-mcp-canary.timer
systemctl --user list-timers alza-mcp-canary.timer
journalctl --user -u alza-mcp-canary.service -n 50   # last run
```

The timer only fires while your user session is running (or enable lingering with `loginctl enable-linger $USER`). Remove it with `systemctl --user disable --now alza-mcp-canary.timer`.
