window.__ModuleLoader__.load({
	id: "dsh-plugin-safe-upgrade",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/**
		* dsh-plugin-safe-upgrade — browser half.
		*
		* /upgrade  : upgrade dsh to the latest/next release (or dry-run it), with
		*             automatic rollback when the new version does not boot cleanly.
		* /rollback : put config (and, when saved, the dsh install) back to a
		*             known-good boot or an earlier config snapshot.
		* After a job this tab started — or any job that finished while no tab was
		* open — a notice reports the outcome once.
		*
		* An unofficial community plugin: its commands and notices say so, so
		* nobody mistakes them for part of dsh.
		*/
		const UNOFFICIAL = "unofficial plugin";
		const NOTICE_TITLE = `safe-upgrade (${UNOFFICIAL})`;
		const API = "/api/safe-upgrade";
		const SEEN_KEY = "dsh-safe-upgrade:seen-job";
		const FINISHED = new Set(["ok", "noop", "rolled-back", "failed"]);

		async function api(path, body) {
			const response = await fetch(`${API}/${path}`, body === void 0 ? { cache: "no-store" } : {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			let data = {};
			try {
				data = await response.json();
			} catch {}
			if (!response.ok) throw new Error(data.error ?? `safe-upgrade: HTTP ${response.status}`);
			return data;
		}

		function ago(iso) {
			if (!iso) return "never";
			const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
			if (seconds < 90) return `${seconds}s ago`;
			if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
			if (seconds < 129600) return `${Math.round(seconds / 3600)} h ago`;
			return `${Math.round(seconds / 86400)} d ago`;
		}

		function when(iso) {
			try {
				return new Date(iso).toLocaleString(void 0, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
			} catch {
				return iso;
			}
		}

		function describeJob(job) {
			const what = job.kind === "upgrade" ? job.dryRun ? `Dry run ${job.toVersion ?? job.target}` : `Upgrade ${job.fromVersion ?? "?"} → ${job.toVersion ?? job.target}` : job.kind === "auto-rollback" ? `Automatic recovery (dsh failed to start) to ${job.target ?? "the last good config"}` : `Rollback to ${job.target}`;
			const outcome = {
				ok: job.dryRun ? "passed" : "done",
				noop: "nothing to do",
				"rolled-back": `failed at ${job.failedStep ?? "?"}, rolled back`,
				failed: `failed at ${job.failedStep ?? "?"}`,
				running: "running…",
				queued: "starting…"
			}[job.status] ?? job.status;
			const warned = job.warnings?.length ? ` · ${job.warnings.length} warning(s)` : "";
			return `${what}: ${outcome}${warned}`;
		}

		/** One-shot notice: system notification when allowed, else an in-page toast. */
		function notify(title, body) {
			if (typeof Notification !== "undefined" && Notification.permission === "granted") {
				try {
					new Notification(title, { body, tag: "dsh-safe-upgrade" });
					return;
				} catch {}
			}
			if (typeof document === "undefined") return;
			const toast = document.createElement("div");
			toast.setAttribute("role", "status");
			toast.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:min(420px,calc(100vw - 32px));padding:12px 14px;border-radius:10px;font:13px/1.45 system-ui,sans-serif;background:var(--dsw-alias-bg-elevated,#1f2329);color:var(--dsw-alias-label-primary,#f5f6f7);box-shadow:0 8px 24px rgba(0,0,0,.25);white-space:pre-wrap;cursor:pointer";
			toast.textContent = `${title}\n${body}`;
			toast.addEventListener("click", () => toast.remove());
			document.body.appendChild(toast);
			setTimeout(() => toast.remove(), 15e3);
		}

		function markSeen(id) {
			try {
				localStorage.setItem(SEEN_KEY, id);
			} catch {}
		}

		function seen(id) {
			try {
				return localStorage.getItem(SEEN_KEY) === id;
			} catch {
				return false;
			}
		}

		function reportIfNew(job) {
			if (job === void 0 || !FINISHED.has(job.status) || seen(job.id)) return;
			markSeen(job.id);
			const failed = job.status === "failed" || job.status === "rolled-back";
			const warnings = (job.warnings ?? []).slice(0, 3).map((text) => `• ${text}`).join("\n");
			notify(failed ? `${NOTICE_TITLE}: problem` : NOTICE_TITLE, `${describeJob(job)}${job.error ? `\n${job.error}` : ""}${warnings ? `\n${warnings}` : ""}`);
		}

		/** Follow a job across the dsh restart until it finishes (max 25 min). */
		async function follow(id) {
			const deadline = Date.now() + 25 * 60e3;
			while (Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 5e3));
				try {
					const status = await api("status");
					if (status.lastJob?.id === id && FINISHED.has(status.lastJob.status)) {
						reportIfNew(status.lastJob);
						return;
					}
				} catch {
					// dsh is restarting; keep waiting.
				}
			}
		}

		function requireIdle(status) {
			if (!status.supervised) throw new Error("dsh is not running as a systemd service here; use the dsh-safe-upgrade CLI.");
			if (status.busyJob) throw new Error(`A safe-upgrade job (${status.busyJob}) is already running.`);
			if (!status.idle) throw new Error(`A turn is running (${status.runningTurns}). Try again when idle.`);
		}

		async function start(kind, body, label) {
			const result = await api(kind, body);
			const effect = body.dryRun ? "Nothing live changes." : "dsh will restart.";
			notify(NOTICE_TITLE, `${label} started. ${effect} You'll get a notice when it's done.`);
			void follow(result.id);
		}

		async function upgradeOptions() {
			const status = await api("status");
			const current = status.dshVersion ?? "unknown";
			const idleText = status.idle ? "idle ✓" : `${status.runningTurns} turn(s) running`;
			const options = [];
			for (const [tag, info] of Object.entries(status.updates ?? {})) {
				if (!info.newer) continue;
				options.push({
					id: `upgrade:${info.version}`,
					label: `Upgrade to ${info.version} (${tag})`,
					description: `Current ${current} · ${idleText} · rolls back automatically if it fails`
				});
			}
			const latest = status.updates?.[status.channel]?.version;
			if (latest && latest !== current) options.push({
				id: `dry:${latest}`,
				label: `Dry run ${latest}`,
				description: "Install into a side copy and validate every profile; nothing live changes"
			});
			if (options.length === 0) options.push({
				id: "none",
				label: `dsh ${current} is up to date`,
				description: status.checkError ? `Last check failed: ${status.checkError}` : `Checked ${ago(status.checkedAt)}`
			});
			options.push({
				id: "check",
				label: "Check for updates now",
				description: `Last checked ${ago(status.checkedAt)}${status.guard ? " · boot guard installed" : " · boot guard not installed"}`
			});
			if (status.lastJob) options.push({
				id: "last",
				label: "Last job",
				description: `${describeJob(status.lastJob)} · ${ago(status.lastJob.finishedAt ?? status.lastJob.createdAt)}`
			});
			return options;
		}

		async function onUpgrade(option) {
			if (option.id === "check") {
				await api("check", {});
				return;
			}
			if (option.id === "none" || option.id === "last") return;
			const status = await api("status");
			requireIdle(status);
			const [kind, version] = option.id.split(":");
			if (kind === "dry") await start("upgrade", { version, dryRun: true }, `Dry run of ${version}`);
			else await start("upgrade", { version }, `Upgrade to ${version}`);
		}

		async function rollbackOptions() {
			const status = await api("status");
			const options = [];
			for (const tag of status.goodTags ?? []) options.push({
				id: `ref:${tag.name}`,
				label: `Known-good boot · ${when(tag.date)}`,
				description: `${tag.name} · dsh ${tag.meta?.dshVersion ?? "?"} · restores config${tag.meta?.dshVersion && tag.meta.dshVersion !== status.dshVersion ? " and install" : ""}`
			});
			for (const commit of status.snapshots ?? []) options.push({
				id: `ref:${commit.sha}`,
				label: `${when(commit.date)} · ${commit.subject}`.slice(0, 90),
				description: `Config snapshot ${commit.sha.slice(0, 8)}`
			});
			if (options.length === 0) options.push({
				id: "none",
				label: "No config history yet",
				description: "History starts on the first boot with this plugin"
			});
			return options;
		}

		async function onRollback(option) {
			if (!option.id.startsWith("ref:")) return;
			const status = await api("status");
			requireIdle(status);
			const ref = option.id.slice(4);
			await start("rollback", { ref }, `Rollback to ${ref.slice(0, 16)}`);
		}

		const inject = ["commandUi"];

		function apply(ctx) {
			ctx.effect(() => {
				const timer = setTimeout(() => {
					api("status").then((status) => reportIfNew(status.lastJob)).catch(() => {});
				}, 4e3);
				return () => clearTimeout(timer);
			}, "safe-upgrade: last job notice");

			ctx.inject(["commandUi"], (scope) => {
				const command = scope.get("commandUi");
				// `available` is part of the command contract: dsh calls it on every dispatch.
				scope.effect(() => command.register({
					name: "upgrade",
					description: () => `Upgrade dsh safely (auto-rollback on failure) · ${UNOFFICIAL}`,
					available: () => true,
					ui: {
						kind: "popupSelect",
						options: upgradeOptions,
						onSelect: onUpgrade
					}
				}), "safe-upgrade: /upgrade");
				scope.effect(() => command.register({
					name: "rollback",
					description: () => `Restore a known-good dsh config · ${UNOFFICIAL}`,
					available: () => true,
					ui: {
						kind: "popupSelect",
						options: rollbackOptions,
						onSelect: onRollback
					}
				}), "safe-upgrade: /rollback");
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
