# dsh-plugin-safe-upgrade

Safe config history, guarded upgrades and automatic rollback for
[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (`dsh`).

dsh ships release candidates often, and a single wrong row in a
`cordis.patch.yml` can stop it from booting. This plugin makes both boring:

- **Config history.** Every edit to the files that decide whether dsh boots
  (`settings.yaml`, profile patches and manifests, agent presets, `AGENTS.md`)
  is committed to a git repo in `$DSH_HOME` a few seconds after it happens.
  Sessions, credentials, caches and `node_modules` are never tracked, and a
  secret guard refuses any file that contains a literal key.
- **Known-good boots.** After every start the plugin checks the plugin loader
  for failed plugins and broken presets. A clean boot tags its config
  `good-<time>` along with the dsh version it ran.
- **`/upgrade`.** Upgrades dsh without touching the running service until the
  last moment. The new version is installed into a side copy, every profile
  is validated with `dsh --dump-config`, and only then does it stop dsh, swap
  directories and start. If the new version doesn't come back healthy, the
  previous install and config are restored automatically. Downtime is the
  swap plus one boot (a few seconds).
- **Web UI check.** After the new version boots, the real web app is loaded
  in headless Chromium. If dsh shows its "Failed to load plugins" screen, the
  upgrade rolls back. This catches browser-side plugin failures that the
  server never sees, such as a client half waiting for a service the new
  version removed.
- **Warnings, not surprises.** Upgrades and dry runs report patches that no
  longer match anything in the new version and errors that plugins log without
  failing. Turn on `failOnWarnings` to treat those as failures.
- **`/rollback`.** Go back to any known-good boot or config snapshot. When the
  tag was recorded on another dsh version whose install copy still exists,
  that install is swapped back too.
- **Boot guard (optional).** A systemd drop-in validates the config before
  every start. If dsh fails to start three times, the last known-good config
  is restored and dsh is started again. This also catches broken hand edits,
  not just upgrades. It runs at most once per 15 minutes, so it can't loop.
- **Optional Telegram alerts** for every upgrade, rollback and recovery.

## How an upgrade runs

```
/upgrade ─▶ host half (inside dsh): idle? no job running? ─▶ systemd-run a supervisor unit
                                                              │  (survives the dsh restart)
supervisor ─▶ snapshot + tag pre-upgrade-*                    │
           ─▶ cp -a install → install.next-<v>, pin @deepseek-ai/* to <v>, npm install
           ─▶ dsh --profile <each> --dump-config   (still nothing live touched)
           ─▶ stop dsh ─▶ install → install.prev-<old>, install.next-<v> → install ─▶ start
           ─▶ wait for HTTP + a fresh boot marker: right version, no failed plugins
           ─▶ load the web UI in headless Chromium: composer, or "Failed to load plugins"?
           ─▶ collect warnings from the journal
   failure ─▶ stop ─▶ restore install.prev + pre-upgrade config ─▶ start ─▶ verify
```

## Requirements

- dsh 0.1.5 or later, installed with npm (the folder whose `node_modules`
  holds `@deepseek-ai/dsh`), running as a **systemd service** (system or user).
- Linux with `git`, `npm`, `cp` and `systemd-run`. Node 22 or later.
- Optional: Chromium or Chrome for the web UI check. Without it the check is
  skipped and reported as a warning.
- The plugin needs no dependencies of its own.

Config history and the boot health check also work without systemd. Upgrades
and rollbacks need it.

## Install

```bash
git clone https://github.com/MovieMaker93/dsh-plugin-safe-upgrade ~/.dsh/plugins/safe-upgrade
dsh plugin --profile web add link:$HOME/.dsh/plugins/safe-upgrade
sudo systemctl restart dsh          # or whatever your unit is called
```

`dsh plugin add` registers the package as a profile bundle, which inserts the
`safe-upgrade` row. On the first boot the plugin starts the config history
and tags the boot as good.

Optional boot guard (run once, as the user that owns the unit):

```bash
node ~/.dsh/plugins/safe-upgrade/bin/dsh-safe-upgrade.mjs install-guard --unit dsh
```

## Use

In the web UI, type the command and press Enter:

| Command | What it does |
|---|---|
| `/upgrade` | Lists newer `latest`/`next` releases, a dry run, "check now" and the last job. Refuses while a turn is running. |
| `/rollback` | Lists known-good boots and recent config snapshots. |

When a job finishes you get a notice: a browser notification if notifications
are allowed, otherwise an in-page toast. From a shell:

```bash
dsh-safe-upgrade status
dsh-safe-upgrade upgrade latest --dry-run
dsh-safe-upgrade upgrade 0.1.7-rc.2
dsh-safe-upgrade rollback good-20260928-190522
dsh-safe-upgrade check-ui        # does the web UI actually load right now?
dsh-safe-upgrade install-guard --unit dsh [--remove]
```

The CLI runs jobs in their own systemd unit and follows their log, so you can
disconnect safely. Without a global install, run it as
`node ~/.dsh/plugins/safe-upgrade/bin/dsh-safe-upgrade.mjs <command>`.

## Configuration

Everything is auto-detected: the unit from the process cgroup, the install
directory from the running `dsh` binary, the health URL from `--host`/`--port`,
and the profiles from `$DSH_HOME/profiles`. To override, add a row to your
profile's `cordis.patch.yml`. A patch replaces the whole config, so list every
key you want to keep.

```yaml
- id: safe-upgrade
  config:
    channel: latest              # dist-tag that /upgrade offers first
    failOnWarnings: false
    telegram:                    # optional; credentials are read at send time
      envFile: /etc/dsh/alerts.env
      tokenVar: TELEGRAM_BOT_TOKEN
      chatVar: TELEGRAM_CHAT_ID
```

| Key | Default | Meaning |
|---|---|---|
| `unit` / `scope` | detected | systemd unit and `system`/`user` scope |
| `installDir` | detected | folder whose `node_modules` holds `@deepseek-ai/dsh` |
| `profiles` | all | profiles validated with `--dump-config` |
| `healthUrl` | from `--port` | any HTTP answer except 5xx counts as up (401 is normal) |
| `healthTimeoutMs` | 150000 | how long a new boot may take |
| `channel` | `latest` | dist-tag offered first; tags behind it are hidden |
| `checkIntervalHours` | 6 | npm dist-tag check interval |
| `keepPrev` | 2 | previous install copies kept for rollback |
| `keepGoodTags` | 10 | `good-*` tags kept |
| `snapshots` | true | auto-commit config edits |
| `failOnWarnings` | false | roll back when the new boot logs errors |
| `uiCheck` | `auto` | `auto`: roll back on dsh's failure screen, warn if the check can't run; `true`: also roll back when it can't run; `false`: skip |
| `chromium` | detected | path to a Chromium/Chrome binary for the UI check |
| `uiTimeoutMs` | 45000 | how long the UI may take to show the composer |
| `telegram` | off | `{envFile?, tokenVar?, chatVar?}` |

## What is tracked

The repo in `$DSH_HOME` uses a whitelist `.gitignore`. It is written only when
the plugin creates the repo; an existing repo and `.gitignore` are adopted
unchanged. Tracked files:

```
settings.yaml  AGENTS.md  cordis.patch.yml  .agent-presets/**
profiles/*/{package.json,pnpm-lock.yaml,pnpm-workspace.yaml,cordis.yml,cordis.patch.yml}
```

## Safety notes

- Upgrades run as the user that runs dsh (often root). The HTTP routes use
  dsh's own authentication (`connection.requestRejection`). Upgrade and
  rollback return 409 while any turn is running or another job holds the lock.
- Each previous install copy is the size of your dsh install (about 300 MB).
  Two are kept by default.
- Rollback restores tracked config only. It never touches sessions,
  credentials, attachments or anything outside `$DSH_HOME` and the install
  directory.
- `testing: true` enables fault injection (`simulateFailure`) through the API.
  Leave it off in production.

## Found while upgrading a real install from 0.1.5-rc.1 to 0.1.7-rc.2

These are what the checks are for:

- **The web UI stopped loading while the server looked healthy.** Smart-DSH's
  `dsh-esc-stop` browser half waits for the `settingsScope` service, which
  0.1.7 removed, so the page stops at "Failed to load plugins — dsh-esc-stop:
  pending (waiting for service: settingsScope)". Every host plugin was
  active, so only the web UI check catches this. It was added after this
  exact incident and verified against a real 0.1.7 instance.
- `patch: entry "agent-presets" not found`: 0.1.7 replaced directory-based
  agent presets (`$DSH_HOME/.agent-presets/*`) with `agent-preset-registry`
  and `preset-*` rows. A patch that targeted `agent-presets` is silently
  ignored, and custom preset folders are no longer read.
- `[esc-stop] settings registration failed TypeError: settingsCtx.settings.register is not a function`:
  the host settings API changed too. Plugins built for 0.1.5 log this error
  instead of failing.
- On first boot 0.1.7 **moves `settings.yaml` into the booted profile's
  `cordis.patch.yml`** (keeping `settings.yaml.imported`). The config history
  records it as one "boot: config at startup" commit, and a rollback brings
  `settings.yaml` back. Other profiles, such as `headless`, don't get the
  imported model providers.

## Development

```bash
npm test     # node --test: engine, repo, host, client and systemd suites
```

The tests put stub `systemctl`, `npm`, `systemd-run`, `journalctl` and `dsh`
binaries on `PATH`. They cover the real upgrade, rollback and recovery code
paths, including failures at every stage, without touching a live service.
The UI check test drives a real headless Chromium when one is installed.

## License

MIT
