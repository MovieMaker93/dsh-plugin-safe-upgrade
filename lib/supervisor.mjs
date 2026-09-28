#!/usr/bin/env node
/**
 * Supervisor entry: `node supervisor.mjs --job <path>`. Launched by the host
 * half in its own transient systemd unit so that stopping and restarting dsh
 * does not kill the job that is doing it.
 * @module dsh-plugin-safe-upgrade/supervisor
 */

import { JobRunner } from './engine.js'
import { readJson } from './util.js'

const at = process.argv.indexOf('--job')
const path = at === -1 ? undefined : process.argv[at + 1]
const job = path === undefined ? undefined : readJson(path)
if (job === undefined) {
  console.error('usage: supervisor.mjs --job <job.json>')
  process.exit(2)
}
const runner = new JobRunner(job, path, { log: (line) => console.log(line) })
await runner.runJob()
process.exit(runner.job.status === 'ok' || runner.job.status === 'noop' ? 0 : 1)
