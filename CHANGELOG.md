# Changelog

## [0.4.0](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/compare/v0.3.0...v0.4.0) (2026-09-29)


### Features

* **cli:** add sessions [--fix-presets] to report and repair sessions on the running dsh ([c429ba9](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/c429ba9b25489352f5a29cb263ac8e496b377419))
* keep stored sessions working across dsh upgrades ([c429ba9](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/c429ba9b25489352f5a29cb263ac8e496b377419))
* **rollback:** warn when a rollback would hide sessions continued on a newer session format ([c429ba9](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/c429ba9b25489352f5a29cb263ac8e496b377419))
* **sessions:** add legacy presets for sessions whose preset the new dsh does not define ([c429ba9](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/c429ba9b25489352f5a29cb263ac8e496b377419))
* **sessions:** open a copy of every stored session with the running and the new dsh before an upgrade ([c429ba9](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/c429ba9b25489352f5a29cb263ac8e496b377419))
* **sessions:** stop an upgrade when sessions that open today would not open afterwards ([c429ba9](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/c429ba9b25489352f5a29cb263ac8e496b377419))


### Documentation

* make clear this is an unofficial community plugin ([cbcb11e](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/cbcb11e94e86ddea2791fb7c3497b539835f3e4c))

## [0.3.0](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/compare/v0.2.0...v0.3.0) (2026-09-28)


### Features

* **config:** add idleWaitMs and bootTimeoutMs settings ([accb2f8](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/accb2f8af1587e182a3ed14dd84be33696a6efc6))


### Bug Fixes

* **boot:** count plugins still loading at the deadline as an unhealthy boot ([accb2f8](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/accb2f8af1587e182a3ed14dd84be33696a6efc6))
* **boot:** record a known-good boot for each dsh version, not only each config ([accb2f8](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/accb2f8af1587e182a3ed14dd84be33696a6efc6))
* **engine:** abort an upgrade or rollback when dsh cannot be stopped ([accb2f8](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/accb2f8af1587e182a3ed14dd84be33696a6efc6))
* **engine:** apply failOnWarnings to dry runs, config warnings and manual rollbacks ([accb2f8](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/accb2f8af1587e182a3ed14dd84be33696a6efc6))
* **engine:** re-check idleness right before stopping dsh and wait for running turns ([accb2f8](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/accb2f8af1587e182a3ed14dd84be33696a6efc6))
* **engine:** take the job lock atomically; a job only releases its own lock ([accb2f8](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/accb2f8af1587e182a3ed14dd84be33696a6efc6))
* **engine:** validate with --dump-config in a throwaway $DSH_HOME, never the live one ([accb2f8](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/accb2f8af1587e182a3ed14dd84be33696a6efc6))
* **guard:** run boot-guard recovery as the dsh unit's own account, never as root ([accb2f8](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/accb2f8af1587e182a3ed14dd84be33696a6efc6))
* harden config history, job locking and the upgrade and rollback flows ([accb2f8](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/accb2f8af1587e182a3ed14dd84be33696a6efc6))
* **history:** commit exactly the scanned bytes; content failing the scan never reaches git ([accb2f8](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/accb2f8af1587e182a3ed14dd84be33696a6efc6))
* **history:** enforce the config allowlist whatever .gitignore says, also on rollback ([accb2f8](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/accb2f8af1587e182a3ed14dd84be33696a6efc6))
* **history:** refuse files over 2 MiB instead of committing them unscanned ([accb2f8](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/accb2f8af1587e182a3ed14dd84be33696a6efc6))
* **history:** snapshot profile and preset folders created after startup ([accb2f8](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/accb2f8af1587e182a3ed14dd84be33696a6efc6))
* **rollback:** undo an install swap that failed half way ([accb2f8](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/accb2f8af1587e182a3ed14dd84be33696a6efc6))
* **systemd:** let EnvironmentFile= values override Environment=, as systemd does ([accb2f8](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/accb2f8af1587e182a3ed14dd84be33696a6efc6))
* **ui:** bound every DevTools call and report why a web UI check timed out ([8c228cf](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/8c228cf6fc0931c44d02db3974a78facec442d6c))
* **ui:** never fail a web UI check on browser profile cleanup ([accb2f8](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/accb2f8af1587e182a3ed14dd84be33696a6efc6))


### Documentation

* document the hardened flows, the regression suite and releases ([dc0b7d0](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/dc0b7d0f7956679c86eb48caab62b2dc7cc2c50d))

## [0.2.0](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/compare/v0.1.0...v0.2.0) (2026-09-28)


### Features

* load the web UI in headless Chromium after an upgrade and roll back when dsh cannot load its web app ([658eeb0](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/658eeb018a0928261a94d13b05568c4c40064ee7))

## 0.1.0 (2026-09-28)


### Features

* config history, guarded upgrades and automatic rollback for dsh ([82ff8d0](https://github.com/MovieMaker93/dsh-plugin-safe-upgrade/commit/82ff8d03fc44b64b51f89eb228addd94804532a5))
