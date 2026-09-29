# dsh-plugin-safe-upgrade

> [!IMPORTANT]
> **Unofficial community plugin.** It is not made, endorsed or supported by
> DeepSeek or the DeepSeek Harness (dsh) team. It only uses dsh's public
> plugin interface. Report problems in this repository's issues, never to the
> dsh project. "DeepSeek" and "DeepSeek Harness" belong to their owners and are
> used here only to say what the plugin works with.

Safe config history, guarded upgrades and automatic rollback for
[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (`dsh`).

dsh ships release candidates often, and a single wrong row in a
`cordis.patch.yml` can stop it from booting. This plugin makes both boring:

- **Config history.** Every edit to the files that decide whether dsh boots
  (`settings.yaml`, profile patches and manifests, agent presets, `AGENTS.md`)
  is committed to a git repo in `$DSH_HOME` a few seconds after it happens,
  including profiles and preset folders created later. Sessions, credentials,
  caches and `node_modules` are never tracked, and a secret guard refuses any
  file that contains a literal key before it is written to git at all.
- **Known-good boots.** After every start the plugin checks the plugin loader
  for failed plugins, plugins that never finish loading, and broken presets.
  A clean boot tags its config `good-<time>` along with the dsh version it
  ran, once per config and version.
- **`/upgrade`.** Upgrades dsh without touching the running service until the
  last moment. The new version is installed into a side copy, every profile
  is validated with `dsh --dump-config` in a throwaway copy of `$DSH_HOME`,
  idleness is checked again, and only then does it stop dsh, swap directories
  and start. If the new version doesn't come back healthy, the previous
  install and config are restored automatically. Downtime is the swap plus
  one boot (a few seconds).
- **Your sessions keep working.** Before any downtime, the plugin opens a
  copy of every stored session with both the running and the new dsh. If
  sessions that open today would not open after the upgrade, the upgrade
  stops. If sessions were recorded under an agent preset the new version no
  longer defines (for example a `~/.dsh/.agent-presets` folder, which 0.1.7
  stopped reading), the plugin adds a legacy copy of the default preset under
  the old name, so those conversations can still be continued. A rollback
  warns when sessions continued on the newer version would disappear from an
  older dsh.
- **Web UI check.** After the new version boots, the real web app is loaded
  in headless Chromium. If dsh shows its "Failed to load plugins" screen, the
  upgrade rolls back. This catches browser-side plugin failures that the
  server never sees, such as a client half waiting for a service the new
  version removed.
- **Warnings, not surprises.** Upgrades, dry runs and rollbacks report patches
  that no longer match anything in the new version and errors that plugins log
  without failing. Turn on `failOnWarnings` to treat those as failures: a dry
  run fails, an upgrade stops before dsh is touched (config warnings) or rolls
  back (boot warnings), and a manual rollback is undone. Automatic recovery is
  never undone by warnings.
- **`/rollback`.** Go back to any known-good boot or config snapshot. The
  target config is validated before dsh is stopped. When the tag was recorded
  on another dsh version whose install copy still exists, that install is
  swapped back too.
- **Boot guard (optional).** A systemd drop-in validates the config before
  every start. If dsh fails to start three times, the newest known-good config
  the machine can return to is restored and dsh is started again. This also
  catches broken hand edits, not just upgrades. It runs at most once per 15
  minutes, so it can't loop, and it runs as the same account as dsh.
- **Optional Telegram alerts** for every upgrade, rollback and recovery.

## How an upgrade runs

```
/upgrade ─▶ host half (inside dsh): idle? no job running? ─▶ systemd-run a supervisor unit
                                                              │  (survives the dsh restart)
supervisor ─▶ take the job lock, snapshot + tag pre-upgrade-* │
           ─▶ cp -a install → install.next-<v>, pin @deepseek-ai/* to <v>, npm install
           ─▶ dsh --profile <each> --dump-config in a throwaway $DSH_HOME   (nothing live touched)
           ─▶ open a copy of every session with the old and the new dsh: none may stop opening;
              presets the new dsh lacks get legacy copies, composed with the new version first
           ─▶ still idle? (waits up to idleWaitMs for running turns)
           ─▶ stop dsh, confirm it is down ─▶ install → install.prev-<old>, install.next-<v> → install
           ─▶ write the legacy presets (if any) into the profile patch ─▶ start
           ─▶ wait for HTTP + a fresh boot marker: right version, no failed or stuck plugins
           ─▶ load the web UI in headless Chromium: composer, or "Failed to load plugins"?
           ─▶ collect warnings from the journal
   failure ─▶ stop ─▶ restore install.prev + pre-upgrade config ─▶ start ─▶ verify
```

`dsh --dump-config` is not read-only: dsh 0.1.7 rewrites each profile's
`cordis.yml`, normalizes shipped profile manifests and deletes 0.1.5 link
projections while it composes. Validation therefore runs against a copy of the
config files, with each profile's `node_modules` linked in read-only fashion
(minus the projection dsh would delete), and the live `$DSH_HOME` is never
written by a dry run or a rejected upgrade.

## Requirements

- dsh 0.1.5 or later, installed with npm (the folder whose `node_modules`
  holds `@deepseek-ai/dsh`), running as a **systemd service** (system or user).
- Linux with `git`, `npm`, `cp` and `systemd-run`. Node 22 or later.
- Optional: Chromium or Chrome for the web UI check. Without it the check is
  skipped and reported as a warning.
- The session check copies `$DSH_HOME/sessions` for the duration of the check,
  so it needs that much free disk space next to `$DSH_HOME`.
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
dsh-safe-upgrade sessions        # which sessions fail to open, and which can't be continued
dsh-safe-upgrade sessions --fix-presets   # add legacy presets for sessions whose preset is gone
dsh-safe-upgrade install-guard --unit dsh [--remove]
```

`sessions` works on a copy of `$DSH_HOME/sessions` and never changes a
session. `--fix-presets` composes the legacy presets with the running dsh
before it appends them to the profile's `cordis.patch.yml`; a profile with
`patchReload: live` picks them up without a restart.

The CLI runs jobs in their own systemd unit and follows their log, so you can
disconnect safely. Without a global install, run it as
`node ~/.dsh/plugins/safe-upgrade/bin/dsh-safe-upgrade.mjs <command>`.
`--force` skips both idle checks (when the job is requested and right before
dsh is stopped).

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
| `bootTimeoutMs` | 120000 | how long plugins may stay loading before the boot counts as unhealthy |
| `idleWaitMs` | 300000 | how long an upgrade or rollback waits for running turns before it gives up without stopping dsh |
| `channel` | `latest` | dist-tag offered first; tags behind it are hidden |
| `checkIntervalHours` | 6 | npm dist-tag check interval |
| `keepPrev` | 2 | previous install copies kept for rollback |
| `keepGoodTags` | 10 | `good-*` tags kept |
| `snapshots` | true | auto-commit config edits |
| `failOnWarnings` | false | treat warnings as failures (dry runs, upgrades, manual rollbacks) |
| `uiCheck` | `auto` | `auto`: roll back on dsh's failure screen, warn if the check can't run; `true`: also roll back when it can't run; `false`: skip |
| `chromium` | detected | path to a Chromium/Chrome binary for the UI check |
| `uiTimeoutMs` | 45000 | how long the UI may take to show the composer |
| `sessionCheck` | `true` | open every stored session with the old and new dsh before an upgrade; `false` skips it |
| `legacyPresets` | `true` | add legacy copies of the default preset for sessions whose preset the new dsh lacks; `false` stops the upgrade instead |
| `telegram` | off | `{envFile?, tokenVar?, chatVar?}` |

## What is tracked

The plugin records and restores these files only, whatever `.gitignore` says:

```
.gitignore  settings.yaml  AGENTS.md  cordis.patch.yml  .agent-presets/**
profiles/*/{package.json,pnpm-lock.yaml,pnpm-workspace.yaml,cordis.yml,cordis.patch.yml}
```

(`node_modules`, `*.bak*` and `*.tmp-*` are always excluded.) When the plugin
creates the repo it writes a matching whitelist `.gitignore` so `git status`
stays readable; an existing repo and `.gitignore` are adopted unchanged, and
anything the owner committed outside the list is never rolled back.

Snapshots never run `git add`. Each file is read once, scanned, and exactly
those bytes are committed, so a file that looks like it holds a literal secret,
or is over 2 MiB, keeps its last recorded version and never reaches git's
object store. When a rollback replaces a file whose current content is not in
history (for example one skipped for a secret), a copy goes to
`$DSH_HOME/safe-upgrade/restore-backups/` first.

## Safety notes

- Upgrades run as the user that runs dsh (often root). The HTTP routes use
  dsh's own authentication (`connection.requestRejection`). Upgrade and
  rollback return 409 while any turn is running or another job holds the lock.
  The lock is taken atomically, so two jobs can never run at once.
- Idleness is checked again right before dsh is stopped, since staging can
  take minutes. dsh has no stable way for a plugin to hold new turns, so a
  turn that starts during the `systemctl stop` call itself is still cut off.
- If dsh cannot be stopped, the job aborts before any install or config change.
- **dsh running as an unprivileged system unit** (`User=` set): the supervisor
  and the boot guard's recovery run as that same account, never as root
  (root must not execute plugin code the service account can write). That
  account then needs permission to manage its own unit and start transient
  `dsh-safe-upgrade-*` units, for example with a polkit rule like the one
  below (a starting point; not tested here, where dsh runs as root). Re-run
  `install-guard` whenever you change the unit's `User=`.

  ```js
  // /etc/polkit-1/rules.d/50-dsh-safe-upgrade.rules
  polkit.addRule(function (action, subject) {
    if (action.id === "org.freedesktop.systemd1.manage-units" && subject.user === "dsh") {
      var unit = action.lookup("unit") || ""
      if (unit === "dsh.service" || unit.indexOf("dsh-safe-upgrade-") === 0) return polkit.Result.YES
    }
  })
  ```
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
- **Old conversations could not be continued.** A session resumes only under
  the preset it was recorded with, so 94 sessions created with a
  `.agent-presets/standard-tools` folder failed with `Unknown agent preset:
  standard-tools`, and dsh refuses to switch a started session to another
  preset. The session check and legacy presets exist for this (reported
  upstream in [discussion #8320](https://github.com/deepseek-ai/deepseek-harness/discussions/8320)).
- **Some subagent transcripts cannot be opened at all.** Sessions written in
  format v0 by dsh 0.0.1-rc.1 through 0.1.1-rc.2 carry a subagent record that
  0.1.5 and later refuse (`uses unsupported descriptor version 2`). The
  session check reports them but does not count them against an upgrade,
  because the running version already can't open them.
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
npm test                                         # unit suites: engine, repo, host, client, systemd, UI check
scripts/install-dsh.sh latest /tmp/dsh           # a real dsh from npm, for the regression suite
DSH_E2E_INSTALL=/tmp/dsh DSH_E2E_UPGRADE_TO=next npm run test:e2e
```

The tests put stub `systemctl`, `npm`, `systemd-run`, `journalctl` and `dsh`
binaries on `PATH`. The stub `dsh --dump-config` writes into `$DSH_HOME` the
way 0.1.7 does, so the tests prove validation never touches the live home.
They cover the real upgrade, rollback and recovery code paths, including
failures at every stage (half-finished swaps, a stop that fails, concurrent
jobs, a turn starting mid-upgrade), without touching a live service.

The regression suite (`tests/e2e/`) uses no stubs. It boots a real dsh from
npm with this plugin linked into a throwaway profile, then checks the boot
marker, the known-good tag, the authenticated routes, the web UI in headless
Chrome and a live config snapshot. It proves `--dump-config` validation leaves
the live `$DSH_HOME` byte-for-byte unchanged, and dry-runs a real upgrade
(npm pins and all) to the next dsh release.

### CI/CD

| Workflow | When | What |
|---|---|---|
| `ci.yml` | every push and PR | conventional-commit lint, syntax and package contents, unit suites on Node 22 and 24, regression suite against dsh `latest` |
| `e2e.yml` | nightly, and on demand | regression suite against dsh `latest` (plus a dry-run upgrade to `next`) and `next`, so a dsh release that breaks the plugin is caught before you upgrade |
| `pr-title.yml` | PRs | the PR title (the squash-merge commit) is a conventional commit |
| `release.yml` | push to `main` | release-please keeps a release PR with the next version and changelog; merging it tags `vX.Y.Z`, publishes the GitHub release and attaches the `npm pack` tarball |

Dependabot keeps the workflow actions current.

### Commits and releases

Commits follow [Conventional Commits](https://www.conventionalcommits.org):
`feat:` for a new capability (minor release), `fix:` for a bug fix (patch),
`feat!:` or a `BREAKING CHANGE:` footer for a breaking change. `docs:`, `test:`,
`ci:`, `refactor:` and `chore:` don't cut a release by themselves. Squash-merge
PRs so the PR title becomes the commit on `main`.

Nobody edits the version or `CHANGELOG.md` by hand: release-please does both
in its release PR.
The UI check test drives a real headless Chromium when one is installed.

## License

MIT. An unofficial community project, provided as-is with no warranty (see
[LICENSE](LICENSE)). Not affiliated with DeepSeek.
