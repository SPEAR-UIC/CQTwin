/* snapshot.js - Snap Shot: snapshot and what-if scenario explorer */

const SnapShot = {
    data: [],
    _bound: false,
    _runPage: 1,
    _lastPayload: null,
    _lastRequestBody: null,
    _selectedJobId: null,
    _activeForkId: "",
    _routeForkLoadedId: "",
    _requestSeq: 0,

    init(data) {
        this.data = (data || []).map(d => App.normalizeSummaryEntry(d));
        this.bind();
        this.populateRuns();
        this.syncRunContext();
        this.refreshForks();
        this._maybeLoadForkFromRoute();
        if (this._lastPayload) {
            this.render(this._lastPayload);
        }
    },

    _esc(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    },

    _parsePositiveInt(value, fallback) {
        const n = parseInt(value, 10);
        return Number.isFinite(n) && n > 0 ? n : fallback;
    },

    _policyFromRun(run) {
        const raw = String(run?.algorithm || run?.variant || "fcfs").trim().toLowerCase();
        // Legacy aliases from older runs → their current distinct equivalents.
        if (raw.includes("wait_time_ratio")) return "wfp1";
        if (raw.includes("wfp_alcf")) return "wfp3";
        if (raw.includes("fifo")) return "fcfs";  // retired alias of fcfs
        // Ordered most-specific first so wfp3 beats wfp2/wfp1, lcfs beats lcf, etc.
        const KNOWN = ["wfp1", "wfp2", "wfp3", "sww", "fcsj", "lcfs", "fcfs",
                       "sjf", "ljf", "srf", "lrf", "scf", "lcf", "fat",
                       "unicep", "bsld", "f1", "f2", "f3", "f4"];
        for (const p of KNOWN) if (raw.includes(p)) return p;
        if (raw.includes("wfp")) return "wfp3";  // retired bare alias == cubic wfp3
        return "fcfs";
    },

    _runSearchQuery() {
        const el = document.getElementById("op-run-search");
        return String(el?.value || "").trim().toLowerCase();
    },

    _allRuns() {
        return [...this.data].sort((a, b) => App.runFullLabel(a).localeCompare(App.runFullLabel(b)));
    },

    populateRuns() {
        const runSel = document.getElementById("op-run-select");
        const pageSel = document.getElementById("op-run-page");
        const pageSizeSel = document.getElementById("op-run-page-size");
        const countEl = document.getElementById("op-run-count");
        if (!runSel) return;

        const prevRun = runSel.value;
        const allRows = this._allRuns();
        const q = this._runSearchQuery();
        const filteredRows = q
            ? allRows.filter(d => App.runFullLabel(d).toLowerCase().includes(q))
            : allRows;

        const pageSize = this._parsePositiveInt(pageSizeSel?.value, 50);
        const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
        const requestedPage = this._parsePositiveInt(pageSel?.value || this._runPage, 1);
        const page = Math.min(pageCount, Math.max(1, requestedPage));
        this._runPage = page;

        if (pageSel) {
            pageSel.innerHTML = Array.from({ length: pageCount }, (_, i) => {
                const p = i + 1;
                return `<option value="${p}">${p}/${pageCount}</option>`;
            }).join("");
            pageSel.value = String(page);
            pageSel.disabled = filteredRows.length === 0;
        }

        const start = (page - 1) * pageSize;
        const pageRows = filteredRows.slice(start, start + pageSize);
        runSel.innerHTML = pageRows.map(d => {
            const key = App.runKey(d);
            const label = App.runFullLabel(d);
            return `<option value="${this._esc(key)}">${this._esc(label)}</option>`;
        }).join("");

        if (pageRows.length) {
            const keep = pageRows.some(d => App.runKey(d) === prevRun);
            runSel.value = keep ? prevRun : App.runKey(pageRows[0]);
            runSel.disabled = false;
        } else {
            runSel.innerHTML = '<option value="">No runs match current filter</option>';
            runSel.disabled = true;
        }

        if (countEl) {
            const shownFrom = pageRows.length ? start + 1 : 0;
            const shownTo = start + pageRows.length;
            countEl.textContent =
                `Showing ${shownFrom}-${shownTo} of ${filteredRows.length}` +
                (q ? ` filtered (${allRows.length} total)` : "");
        }
    },

    selectRunByKey(runKey) {
        const runSel = document.getElementById("op-run-select");
        const searchEl = document.getElementById("op-run-search");
        const pageSizeSel = document.getElementById("op-run-page-size");
        if (!runSel || !runKey) return false;

        const allRows = this._allRuns();
        const pageSize = this._parsePositiveInt(pageSizeSel?.value, 50);
        const idx = allRows.findIndex(d => App.runKey(d) === runKey);
        if (idx < 0) return false;

        if (searchEl) searchEl.value = "";
        this._runPage = Math.floor(idx / pageSize) + 1;
        this.populateRuns();
        runSel.value = runKey;
        this.syncRunContext();
        return true;
    },

    bind() {
        if (this._bound) return;
        this._bound = true;

        const refreshRuns = ({ resetPage = false } = {}) => {
            if (resetPage) this._runPage = 1;
            const prev = document.getElementById("op-run-select")?.value || "";
            this.populateRuns();
            const next = document.getElementById("op-run-select")?.value || "";
            if (prev !== next) this.syncRunContext();
        };

        document.getElementById("op-run-select")?.addEventListener("change", () => this.syncRunContext());
        document.getElementById("op-run-search")?.addEventListener("input", () => refreshRuns({ resetPage: true }));
        document.getElementById("op-run-page-size")?.addEventListener("change", () => refreshRuns({ resetPage: true }));
        document.getElementById("op-run-page")?.addEventListener("change", () => refreshRuns());
        document.getElementById("op-time-mode")?.addEventListener("change", () => this.syncTimeControls());
        document.getElementById("op-time-slider")?.addEventListener("input", () => this._syncTimeFromSlider());
        document.getElementById("op-time-input")?.addEventListener("input", () => this._syncTimeFromInput());
        document.getElementById("btn-op-run")?.addEventListener("click", () => this.evaluate());
        document.getElementById("btn-op-save-fork")?.addEventListener("click", () => this.saveFork({ openNewTab: false }));
        document.getElementById("btn-op-open-fork")?.addEventListener("click", () => this.saveFork({ openNewTab: true }));
        document.getElementById("btn-op-refresh-forks")?.addEventListener("click", () => this.refreshForks());
        document.getElementById("btn-op-load-fork")?.addEventListener("click", () => {
            const forkId = document.getElementById("op-saved-forks")?.value || "";
            if (forkId) this.loadFork(forkId);
        });
        document.getElementById("btn-op-clear-force")?.addEventListener("click", async () => {
            const input = document.getElementById("op-force-job");
            if (input) input.value = "";
            if (this._lastRequestBody?.force_job_id != null && this._lastRequestBody?.force_job_id !== "") {
                await this.evaluate();
            } else if (this._lastPayload) {
                this.render(this._lastPayload);
            }
        });

        const queueBody = document.querySelector("#op-queue-table tbody");
        if (queueBody) {
            queueBody.addEventListener("click", async evt => {
                const actionBtn = evt.target.closest("[data-force-job]");
                if (actionBtn) {
                    const jobId = actionBtn.getAttribute("data-force-job");
                    await this.previewPinnedJob(jobId ? Number(jobId) : null);
                    return;
                }
                const rowEl = evt.target.closest("tr[data-job-id]");
                if (rowEl) {
                    await this.previewPinnedJob(Number(rowEl.getAttribute("data-job-id")));
                }
            });
        }
    },

    currentRun() {
        const key = document.getElementById("op-run-select")?.value || "";
        return this.data.find(d => App.runKey(d) === key) || null;
    },

    syncRunContext() {
        const run = this.currentRun();
        const policySel = document.getElementById("op-preview-policy");
        const backfillSel = document.getElementById("op-preview-backfill");
        const windowInput = document.getElementById("op-preview-window");
        const metaEl = document.getElementById("op-run-meta");

        if (!run) {
            if (metaEl) metaEl.classList.add("hidden");
            return;
        }

        if (policySel && !policySel.dataset.locked) policySel.value = this._policyFromRun(run);
        if (backfillSel && !backfillSel.dataset.locked) backfillSel.value = String(Number.isFinite(Number(run.backfill)) ? Number(run.backfill) : 2);
        if (windowInput && !windowInput.dataset.locked) windowInput.value = "";

        if (metaEl) {
            metaEl.classList.remove("hidden");
            metaEl.innerHTML = [
                `<span><b>Run:</b> ${this._esc(App.runFullLabel(run))}</span>`,
                `<span><b>Current Policy:</b> ${this._esc(String(run.algorithm || this._policyFromRun(run)).toUpperCase())}</span>`,
                `<span><b>Backfill:</b> ${this._esc(String(run.backfill ?? 2))}</span>`,
                `<span><b>Makespan:</b> ${this._esc(App.formatTime(run.makespan || 0))}</span>`,
            ].join("");
        }

        this.syncTimeControls();
    },

    syncTimeControls() {
        const run = this.currentRun();
        const slider = document.getElementById("op-time-slider");
        const input = document.getElementById("op-time-input");
        const mode = document.getElementById("op-time-mode")?.value || "percent";
        const hint = document.getElementById("op-time-hint");
        const makespan = Math.max(1, Number(run?.makespan || 1));
        if (!slider || !input) return;

        if (mode === "percent") {
            slider.min = "0";
            slider.max = "100";
            slider.step = "0.1";
            input.min = "0";
            input.max = "100";
            input.step = "0.1";
            if (Number(input.value) > 100 || Number(input.value) < 0) {
                input.value = "50";
                slider.value = "50";
            }
        } else {
            slider.min = "0";
            slider.max = String(Math.ceil(makespan));
            slider.step = "1";
            input.min = "0";
            input.max = String(Math.ceil(makespan));
            input.step = "1";
            const currentSec = this.snapshotSeconds();
            slider.value = String(Math.min(makespan, Math.max(0, currentSec)));
            input.value = String(Math.min(makespan, Math.max(0, currentSec)));
        }

        const sec = this.snapshotSeconds();
        if (hint) {
            const pct = makespan > 0 ? (sec / makespan) * 100.0 : 0.0;
            hint.textContent = `${App.formatTime(sec)} from start (${pct.toFixed(1)}% of makespan)`;
        }
    },

    _syncTimeFromSlider() {
        const slider = document.getElementById("op-time-slider");
        const input = document.getElementById("op-time-input");
        if (slider && input) input.value = slider.value;
        this.syncTimeControls();
    },

    _syncTimeFromInput() {
        const slider = document.getElementById("op-time-slider");
        const input = document.getElementById("op-time-input");
        if (slider && input) slider.value = input.value;
        this.syncTimeControls();
    },

    snapshotSeconds() {
        const run = this.currentRun();
        const makespan = Math.max(1, Number(run?.makespan || 1));
        const mode = document.getElementById("op-time-mode")?.value || "percent";
        const raw = Number(document.getElementById("op-time-input")?.value || 0);
        if (mode === "percent") {
            const pct = Math.min(100, Math.max(0, raw));
            return (pct / 100.0) * makespan;
        }
        return Math.min(makespan, Math.max(0, raw));
    },

    setStatus(msg, isError = false) {
        const el = document.getElementById("op-status");
        if (!el) return;
        el.textContent = msg || "";
        el.style.color = isError ? "#fca5a5" : "";
    },

    _collectRequestPayload() {
        const run = this.currentRun();
        if (!run) return null;

        const forceRaw = String(document.getElementById("op-force-job")?.value || "").trim();
        const windowRaw = String(document.getElementById("op-preview-window")?.value || "").trim();
        const plannedDowntimeOffset = String(document.getElementById("op-planned-downtime-offset")?.value || "").trim();
        const selectedJobId = forceRaw
            ? Number(forceRaw)
            : (this._selectedJobId == null ? NaN : Number(this._selectedJobId));
        const payload = {
            run_name: App.runKey(run),
            snapshot_time: this.snapshotSeconds(),
            preview_policy: document.getElementById("op-preview-policy")?.value || this._policyFromRun(run),
            preview_backfill_mode: Number(document.getElementById("op-preview-backfill")?.value || run.backfill || 2),
            horizon_hours: Number(document.getElementById("op-horizon-hours")?.value || 24),
            downtime_hours: Number(document.getElementById("op-downtime-hours")?.value || 4),
            planned_downtime_notice_hours: Number(document.getElementById("op-planned-downtime-notice")?.value || 48),
        };
        if (Number.isFinite(selectedJobId)) payload.selected_job_id = selectedJobId;
        if (windowRaw) payload.preview_window_size = Number(windowRaw);
        if (forceRaw) payload.force_job_id = Number(forceRaw);
        if (plannedDowntimeOffset) payload.planned_downtime_offset_hours = Number(plannedDowntimeOffset);
        return payload;
    },

    async _requestPreview(payload, { statusMessage, successMessage } = {}) {
        if (!payload) return null;
        const requestToken = ++this._requestSeq;
        this.setStatus(statusMessage || "Evaluating snapshot...");
        try {
            const resp = await fetch("/api/snapshot/preview", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const data = await resp.json();
            if (requestToken !== this._requestSeq) return null;
            if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);
            this._lastPayload = data;
            this._lastRequestBody = payload;
            if (!this._selectedJobId && Array.isArray(data?.queued_jobs) && data.queued_jobs.length) {
                this._selectedJobId = Number(data.queued_jobs[0].job_id);
            }
            this.render(data);
            this.setStatus(successMessage || `Snapshot evaluated for ${App.runKey(this.currentRun())} at ${App.formatTime(payload.snapshot_time)}.`);
            return data;
        } catch (err) {
            if (requestToken !== this._requestSeq) return null;
            this.setStatus(`Snap Shot preview failed: ${err.message}`, true);
            return null;
        }
    },

    async evaluate() {
        const run = this.currentRun();
        if (!run) {
            this.setStatus("Select a run first.", true);
            return null;
        }
        const payload = this._collectRequestPayload();
        if (Number.isFinite(Number(payload?.selected_job_id))) {
            this._selectedJobId = Number(payload.selected_job_id);
        }
        return this._requestPreview(payload, {
            statusMessage: "Evaluating snapshot...",
            successMessage: `Snapshot evaluated for ${App.runKey(run)} at ${App.formatTime(payload.snapshot_time)}.`,
        });
    },

    async previewPinnedJob(jobId) {
        if (!Number.isFinite(Number(jobId))) return null;
        const run = this.currentRun();
        if (!run) {
            this.setStatus("Select a run first.", true);
            return null;
        }

        this._setSelectedJob(Number(jobId));
        const input = document.getElementById("op-force-job");
        if (input) input.value = String(jobId);

        const payload = this._collectRequestPayload();
        const lastForce = Number(this._lastRequestBody?.force_job_id);
        const sameRequest = !!this._lastPayload && JSON.stringify(payload) === JSON.stringify(this._lastRequestBody || {});
        if (sameRequest && lastForce === Number(jobId)) {
            this.render(this._lastPayload);
            this.setStatus(`Pinned scenario already loaded for job ${jobId}.`);
            return this._lastPayload;
        }

        return this._requestPreview(payload, {
            statusMessage: `Evaluating pinned scenario for job ${jobId}...`,
            successMessage: `Pinned scenario loaded for job ${jobId}.`,
        });
    },

    async saveFork({ openNewTab = false } = {}) {
        const request = this._collectRequestPayload();
        if (!request) {
            this.setStatus("Select a run first.", true);
            return;
        }

        let result = this._lastPayload;
        const requestSig = JSON.stringify(request);
        const lastSig = JSON.stringify(this._lastRequestBody || {});
        if (!result || requestSig !== lastSig) {
            result = await this.evaluate();
            if (!result) return;
        }

        const forkName = String(document.getElementById("op-fork-name")?.value || "").trim();
        this.setStatus(openNewTab ? "Saving fork and opening a new tab..." : "Saving fork...");
        try {
            const resp = await fetch("/api/snapshot/forks", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: forkName,
                    run_name: request.run_name,
                    request,
                    result,
                    selected_job_id: this._selectedJobId,
                }),
            });
            const data = await resp.json();
            if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);

            this._activeForkId = data.fork_id || "";
            this._writeForkRoute(this._activeForkId);
            this._syncActiveFork();
            await this.refreshForks();

            if (openNewTab && data.fork_id) {
                const url = new URL(window.location.href);
                url.searchParams.set("tab", "snapshot");
                url.searchParams.set("fork", data.fork_id);
                window.open(url.toString(), "_blank", "noopener");
            }
            this.setStatus(openNewTab ? "Fork saved and opened in a new tab." : "Fork saved.");
        } catch (err) {
            this.setStatus(`Saving fork failed: ${err.message}`, true);
        }
    },

    async refreshForks() {
        const sel = document.getElementById("op-saved-forks");
        if (!sel) return;
        try {
            const payload = await fetch("/api/snapshot/forks?limit=150", { cache: "no-store" }).then(r => r.json());
            const forks = Array.isArray(payload?.forks) ? payload.forks : [];
            if (!forks.length) {
                sel.innerHTML = '<option value="">No saved forks yet</option>';
                sel.value = "";
                this._syncActiveFork();
                return;
            }
            sel.innerHTML = forks.map(fork => {
                const label = fork.name
                    ? `${fork.name} [${fork.id}]`
                    : `${fork.run_name || "run"} @ ${App.formatTime(fork.snapshot_time || 0)} [${fork.id}]`;
                return `<option value="${this._esc(fork.id)}">${this._esc(label)}</option>`;
            }).join("");
            if (this._activeForkId && forks.some(f => f.id === this._activeForkId)) {
                sel.value = this._activeForkId;
            }
            this._syncActiveFork();
        } catch {
            sel.innerHTML = '<option value="">Unable to load saved forks</option>';
        }
    },

    _forkRouteId() {
        try {
            return new URLSearchParams(window.location.search).get("fork") || "";
        } catch {
            return "";
        }
    },

    _writeForkRoute(forkId) {
        try {
            const url = new URL(window.location.href);
            url.searchParams.set("tab", "snapshot");
            if (forkId) url.searchParams.set("fork", forkId);
            else url.searchParams.delete("fork");
            window.history.replaceState({}, "", url.toString());
        } catch {}
    },

    async _maybeLoadForkFromRoute() {
        const forkId = this._forkRouteId();
        if (!forkId || forkId === this._routeForkLoadedId) return;
        await this.loadFork(forkId, { quiet: true });
        this._routeForkLoadedId = forkId;
    },

    async loadFork(forkId, { quiet = false } = {}) {
        if (!forkId) return;
        if (!quiet) this.setStatus("Loading saved fork...");
        try {
            const record = await fetch(`/api/snapshot/forks/${encodeURIComponent(forkId)}`, { cache: "no-store" }).then(r => r.json());
            if (record?.error) throw new Error(record.error);
            this._applyForkRecord(record);
            this._activeForkId = forkId;
            this._writeForkRoute(forkId);
            this._syncActiveFork();
            if (!quiet) this.setStatus(`Loaded saved fork ${forkId}.`);
        } catch (err) {
            this.setStatus(`Loading fork failed: ${err.message}`, true);
        }
    },

    _applyForkRecord(record) {
        const request = record?.request || {};
        const result = record?.result || {};
        const runKey = String(record?.run_name || request?.run_name || result?.run_name || "").trim();
        if (runKey) this.selectRunByKey(runKey);

        const modeSel = document.getElementById("op-time-mode");
        const input = document.getElementById("op-time-input");
        const slider = document.getElementById("op-time-slider");
        if (modeSel) modeSel.value = "absolute";
        if (input) input.value = String(Number(request?.snapshot_time || 0));
        if (slider) slider.value = String(Number(request?.snapshot_time || 0));

        const setValue = (id, value) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.value = value == null ? "" : String(value);
        };
        setValue("op-preview-policy", request?.preview_policy || "");
        setValue("op-preview-backfill", request?.preview_backfill_mode ?? "");
        setValue("op-preview-window", request?.preview_window_size ?? "");
        setValue("op-horizon-hours", request?.horizon_hours ?? 24);
        setValue("op-downtime-hours", request?.downtime_hours ?? 4);
        setValue("op-planned-downtime-offset", request?.planned_downtime_offset_hours ?? "");
        setValue("op-planned-downtime-notice", request?.planned_downtime_notice_hours ?? 48);
        setValue("op-force-job", request?.force_job_id ?? "");
        setValue("op-fork-name", record?.name || "");
        this.syncTimeControls();

        this._selectedJobId = record?.selected_job_id != null ? Number(record.selected_job_id) : null;
        this._lastPayload = result || null;
        this._lastRequestBody = request || null;
        if (this._lastPayload) {
            if (!this._selectedJobId && Array.isArray(this._lastPayload?.queued_jobs) && this._lastPayload.queued_jobs.length) {
                this._selectedJobId = Number(this._lastPayload.queued_jobs[0].job_id);
            }
            this.render(this._lastPayload);
        }
    },

    _syncActiveFork() {
        const el = document.getElementById("op-active-fork");
        const sel = document.getElementById("op-saved-forks");
        if (!el) return;
        if (sel && this._activeForkId) sel.value = this._activeForkId;
        el.textContent = this._activeForkId ? `Active fork: ${this._activeForkId}` : "";
    },

    _setSelectedJob(jobId) {
        this._selectedJobId = Number.isFinite(Number(jobId)) ? Number(jobId) : null;
        if (this._lastPayload) this.render(this._lastPayload);
    },

    _selectedQueueRow(rows) {
        const list = Array.isArray(rows) ? rows : [];
        if (!list.length) return null;
        const exact = list.find(row => Number(row.job_id) === Number(this._selectedJobId));
        if (exact) return exact;
        this._selectedJobId = Number(list[0].job_id);
        return list[0];
    },

    _card(label, value) {
        return `
            <div class="card">
                <div class="label">${this._esc(label)}</div>
                <div class="value">${this._esc(value)}</div>
            </div>
        `;
    },

    _fmtSignedTime(value) {
        const n = Number(value || 0);
        if (!Number.isFinite(n) || Math.abs(n) < 1e-9) return "0.00s";
        const sign = n > 0 ? "+" : "-";
        return `${sign}${App.formatTime(Math.abs(n))}`;
    },

    _fmtUser(value) {
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? String(Math.trunc(n)) : "-";
    },

    _fmtUserMasked(value) {
        const raw = this._fmtUser(value);
        if (raw === "-") return "-";
        const head = raw.slice(0, 4);
        return `user ${head}${raw.length > 4 ? "....." : ""}`;
    },

    _fmtMaybeTime(value) {
        return value == null || Number(value) < 0 ? "-" : App.formatTime(value);
    },

    _fmtConfidenceLabel(value) {
        const raw = String(value || "").trim().toLowerCase();
        if (!raw) return "-";
        return raw.charAt(0).toUpperCase() + raw.slice(1);
    },

    _deltaClass(value) {
        const n = Number(value || 0);
        if (n < 0) return "delta-better";
        if (n > 0) return "delta-worse";
        return "delta-neutral";
    },

    render(payload) {
        const run = this.currentRun();
        const snapshot = payload?.snapshot || {};
        const snapshotCards = document.getElementById("op-snapshot-summary");
        const impactCards = document.getElementById("op-impact-summary");
        const forceGrid = document.getElementById("op-force-summary");
        const queueRows = payload?.queued_jobs || [];

        if (snapshotCards) {
            snapshotCards.innerHTML = [
                this._card("Snapshot Time", App.formatTime(snapshot.snapshot_time || 0)),
                this._card("Queued Jobs", App.formatNum(snapshot.queued_count || 0)),
                this._card("Running Jobs", App.formatNum(snapshot.running_count || 0)),
                this._card("Future Submits", App.formatNum(snapshot.future_submit_count || 0)),
                this._card("Available Procs", `${App.formatNum(snapshot.available_procs || 0)} / ${App.formatNum(snapshot.total_procs || 0)}`),
                this._card("Next Completion", snapshot.next_completion_time == null ? "-" : App.formatTime((snapshot.next_completion_time || 0) - (snapshot.snapshot_time || 0))),
            ].join("");
        }

        const impact = payload?.impact_summary || {};
        if (impactCards) {
            const cards = [
                this._card("Baseline Avg Remaining", App.formatTime(impact.baseline_avg_remaining_wait || 0)),
                this._card("Preview Avg Remaining", App.formatTime(impact.preview_avg_remaining_wait || 0)),
                this._card("Preview Jobs Earlier", App.formatNum(impact.preview_jobs_moved_earlier || 0)),
                this._card("Preview Jobs Later", App.formatNum(impact.preview_jobs_moved_later || 0)),
                this._card("Avg Preview Delta", this._fmtSignedTime(impact.avg_preview_delta_wait || 0)),
            ];
            if (payload?.force_result) {
                cards.push(this._card("Avg Force Delta", this._fmtSignedTime(impact.avg_forced_delta_wait || 0)));
            }
            impactCards.innerHTML = cards.join("");
        }

        if (forceGrid) {
            const force = payload?.force_result;
            if (force) {
                forceGrid.innerHTML = `
                    <div class="insight"><b>Pinned job:</b> ${this._esc(force.requested_job_id)}</div>
                    <div class="insight"><b>Status:</b> ${this._esc(force.reason || "unknown")}</div>
                    <div class="insight"><b>Projected start:</b> ${this._esc(this._fmtMaybeTime(force.scheduled_start))}</div>
                    <div class="insight"><b>Wait until start:</b> ${this._esc(App.formatTime(force.wait_until_start || 0))}</div>
                `;
            } else {
                forceGrid.innerHTML = `
                    <div class="insight"><b>Fork policy:</b> ${this._esc(String(payload?.meta?.preview_policy || this._policyFromRun(run)).toUpperCase())}</div>
                    <div class="insight"><b>Pin a queued job</b> to reserve it as the next primary dispatch candidate and measure the impact on the rest of the queue.</div>
                `;
            }
        }

        this._renderRunningTable(payload?.running_jobs || []);
        this._renderQueueTable(queueRows, !!payload?.force_result);
        this._renderSelectedJob(queueRows, payload);
        this._renderValidation(payload);
        this._renderHorizon("baseline", payload?.baseline_horizon_state || {});
        this._renderHorizon("preview", payload?.preview_horizon_state || {});
        this._renderHorizon("downtime", payload?.downtime_horizon_state || {});
        this._renderDowntime("baseline", payload?.baseline_downtime_advisor || []);
        this._renderDowntime("preview", payload?.preview_downtime_advisor || []);
        this._renderDowntimeImpact(queueRows, payload?.downtime_impact_summary || {}, payload?.planned_downtime || null);
    },

    _renderSelectedJob(rows, payload) {
        const summaryEl = document.getElementById("op-selected-job-summary");
        const detailsEl = document.getElementById("op-selected-job-details");
        if (!summaryEl || !detailsEl) return;

        const row = this._selectedQueueRow(rows);
        const selectedRaw = payload?.selected_job || {};
        const selected = Number(selectedRaw?.job_id) === Number(row?.job_id) ? selectedRaw : {};
        if (!row) {
            summaryEl.innerHTML = this._card("Selected Job", "No queued job selected");
            detailsEl.innerHTML = '<div class="insight">Evaluate a snapshot with queued jobs, then click a queue row to pin that job and inspect its impact interactively.</div>';
            return;
        }

        const cards = [
            this._card("Job", row.job_id),
            this._card("User", this._fmtUserMasked(row.user_id)),
            this._card("Req Procs", App.formatNum(row.req_proc || 0)),
            this._card("Req Walltime", App.formatTime(row.req_walltime || 0)),
            this._card("Current Wait", App.formatTime(row.current_wait || 0)),
            this._card("Preview Delta", this._fmtSignedTime(row.preview_delta_wait || 0)),
            this._card("Policy Rank", selected.policy_rank > 0 ? `#${selected.policy_rank}` : "-"),
            this._card("Capacity-Only Start", this._fmtMaybeTime(selected.earliest_capacity_start)),
        ];
        if (row.downtime_delta_wait != null) {
            cards.push(this._card("Downtime Delta", this._fmtSignedTime(row.downtime_delta_wait || 0)));
        }
        if (row.forced_delta_wait != null) {
            cards.push(this._card("Pinned Delta", this._fmtSignedTime(row.forced_delta_wait || 0)));
        }
        if (selected?.confidence?.label) {
            cards.push(this._card("Estimate Confidence", this._fmtConfidenceLabel(selected.confidence.label)));
        }
        summaryEl.innerHTML = cards.join("");

        const details = [
            `<div class="insight"><b>Submit:</b> ${this._esc(this._fmtMaybeTime(row.submit))}</div>`,
            `<div class="insight"><b>Baseline start:</b> ${this._esc(this._fmtMaybeTime(row.baseline_start))}</div>`,
            `<div class="insight"><b>Preview start:</b> ${this._esc(this._fmtMaybeTime(row.preview_start))}</div>`,
            `<div class="insight"><b>Baseline remaining wait:</b> ${this._esc(App.formatTime(row.baseline_wait_remaining || 0))}</div>`,
            `<div class="insight"><b>Preview remaining wait:</b> ${this._esc(App.formatTime(row.preview_wait_remaining || 0))}</div>`,
            `<div class="insight"><b>Interaction:</b> Click any queued row to re-simulate with that job pinned as the next primary dispatch candidate.</div>`,
        ];
        if (selected.queue_position > 0) {
            details.push(`<div class="insight"><b>Raw queue position:</b> #${this._esc(selected.queue_position)}</div>`);
        }
        if (selected.policy_rank > 0) {
            details.push(`<div class="insight"><b>Policy dispatch rank:</b> #${this._esc(selected.policy_rank)}</div>`);
        }
        if (selected.effective_start_rank > 0) {
            details.push(`<div class="insight"><b>Projected start order:</b> #${this._esc(selected.effective_start_rank)}</div>`);
        }
        if (selected.capacity_wait_remaining != null) {
            details.push(`<div class="insight"><b>Capacity-only earliest start:</b> ${this._esc(this._fmtMaybeTime(selected.earliest_capacity_start))} (${this._esc(App.formatTime(selected.capacity_wait_remaining || 0))} from now)</div>`);
        }
        if (selected.policy_delay_remaining != null) {
            details.push(`<div class="insight"><b>Extra delay beyond raw capacity:</b> ${this._esc(App.formatTime(selected.policy_delay_remaining || 0))}</div>`);
        }
        if (row.downtime_wait_remaining != null) {
            const planned = payload?.planned_downtime || {};
            details.push(`<div class="insight"><b>With planned downtime:</b> ${this._esc(App.formatTime(row.downtime_wait_remaining || 0))}</div>`);
            details.push(`<div class="insight"><b>Planned downtime offset:</b> ${this._esc(planned.offset_label || this._fmtMaybeTime(planned.offset_seconds || 0))}</div>`);
        }
        if (row.forced_wait_remaining != null) {
            details.push(`<div class="insight"><b>When pinned:</b> ${this._esc(App.formatTime(row.forced_wait_remaining || 0))}</div>`);
        }
        if (Array.isArray(selected.explanation_lines) && selected.explanation_lines.length) {
            details.push(`<div class="insight snapshot-explain-block"><b>Why this job is waiting:</b><ul>${selected.explanation_lines.map(line => `<li>${this._esc(line)}</li>`).join("")}</ul></div>`);
        }
        if (Array.isArray(selected.ahead_jobs) && selected.ahead_jobs.length) {
            details.push(`<div class="insight snapshot-explain-block"><b>Queued jobs projected earlier:</b><ul>${selected.ahead_jobs.map(row => `<li>Job ${this._esc(row.job_id)} (${this._esc(this._fmtUserMasked(row.user_id))}, ${this._esc(App.formatNum(row.req_proc || 0))} procs) starts in ${this._esc(App.formatTime(row.starts_in || 0))} because it is ${this._esc(row.reason || "ahead")}</li>`).join("")}</ul></div>`);
        }
        if (Array.isArray(selected.running_blockers) && selected.running_blockers.length) {
            details.push(`<div class="insight snapshot-explain-block"><b>Running jobs still occupying capacity:</b><ul>${selected.running_blockers.map(row => `<li>Job ${this._esc(row.job_id)} (${this._esc(this._fmtUserMasked(row.user_id))}, ${this._esc(App.formatNum(row.req_proc || 0))} procs) ends in ${this._esc(App.formatTime(row.remaining_runtime || 0))}</li>`).join("")}</ul></div>`);
        }
        if (selected.next_maintenance && Object.keys(selected.next_maintenance).length) {
            details.push(`<div class="insight"><b>Next maintenance window:</b> starts in ${this._esc(App.formatTime(selected.next_maintenance.starts_in || 0))}, lasts ${this._esc(App.formatTime(selected.next_maintenance.duration || 0))}</div>`);
        }
        if (selected.confidence && Object.keys(selected.confidence).length) {
            details.push(`<div class="insight"><b>Confidence basis:</b> ${this._esc(this._fmtConfidenceLabel(selected.confidence.label))} confidence from ${this._esc(selected.confidence.analog_jobs || 0)} similar completed jobs; p50 historical wait ${this._esc(App.formatTime(selected.confidence.wait_p50 || 0))}, p90 ${this._esc(App.formatTime(selected.confidence.wait_p90 || 0))}.</div>`);
        }
        detailsEl.innerHTML = details.join("");
    },

    _renderValidation(payload) {
        const banner = document.getElementById("op-validation-banner");
        if (!banner) return;
        const globalSignals = payload?.validation_signals || {};
        const selected = payload?.selected_job || {};
        const selectedValidation = selected?.validation || {};
        const selectedConfidence = selected?.confidence || {};

        const cards = [
            `<div class="insight"><b>${this._esc(globalSignals.engine_label || "Validated replay engine")}:</b> ${this._esc(globalSignals.engine_detail || "")}</div>`,
            `<div class="insight"><b>${this._esc(globalSignals.projection_label || "Simulated estimate")}:</b> ${this._esc(globalSignals.projection_detail || "")}</div>`,
            `<div class="insight"><b>${this._esc(globalSignals.scope_label || "Validation scope")}:</b> ${this._esc(globalSignals.scope_detail || "")}</div>`,
        ];
        if (selectedConfidence?.analog_jobs != null) {
            cards.push(`<div class="insight"><b>Selected-job confidence:</b> ${this._esc(this._fmtConfidenceLabel(selectedConfidence.label))} from ${this._esc(selectedConfidence.analog_jobs)} analog jobs. Basis: ${this._esc(selectedConfidence.basis || "none")}.</div>`);
        } else if (selectedValidation?.analogs_count != null) {
            cards.push(`<div class="insight"><b>Selected-job confidence:</b> ${this._esc(this._fmtConfidenceLabel(selectedValidation.analogs_confidence))} from ${this._esc(selectedValidation.analogs_count)} analog jobs.</div>`);
        }
        banner.innerHTML = cards.join("");
    },

    _renderRunningTable(rows) {
        const body = document.querySelector("#op-running-table tbody");
        if (!body) return;
        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="8">No running jobs at this snapshot.</td></tr>';
            return;
        }
        body.innerHTML = rows.map(row => `
            <tr>
                <td>${this._esc(row.job_id)}</td>
                <td>${this._esc(this._fmtUser(row.user_id))}</td>
                <td>${this._esc(App.formatNum(row.req_proc || 0))}</td>
                <td>${this._esc(App.formatTime(row.req_walltime || 0))}</td>
                <td>${this._esc(this._fmtMaybeTime(row.submit))}</td>
                <td>${this._esc(this._fmtMaybeTime(row.start))}</td>
                <td>${this._esc(this._fmtMaybeTime(row.end))}</td>
                <td>${this._esc(App.formatTime(row.remaining_runtime || 0))}</td>
            </tr>
        `).join("");
    },

    _renderQueueTable(rows, hasForce) {
        const body = document.querySelector("#op-queue-table tbody");
        if (!body) return;
        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="13">No queued jobs at this snapshot.</td></tr>';
            return;
        }
        const pinnedJobId = Number(this._lastPayload?.force_result?.requested_job_id ?? NaN);
        body.innerHTML = rows.map(row => {
            const forceDelta = row.forced_delta_wait == null ? "" : `<div class="${this._deltaClass(row.forced_delta_wait)}">${this._esc(this._fmtSignedTime(row.forced_delta_wait))}</div>`;
            const forcePreview = row.forced_wait_remaining == null ? "" : `<div class="small-note">${this._esc(App.formatTime(row.forced_wait_remaining))}</div>`;
            const activeCls = Number(row.job_id) === Number(this._selectedJobId) ? " snapshot-selected-row" : "";
            const isPinned = Number(row.job_id) === pinnedJobId;
            return `
                <tr class="${activeCls.trim()}" data-job-id="${this._esc(row.job_id)}">
                    <td>${this._esc(row.queue_pos)}</td>
                    <td>${this._esc(row.job_id)}</td>
                    <td>${this._esc(this._fmtUser(row.user_id))}</td>
                    <td>${this._esc(App.formatNum(row.req_proc || 0))}</td>
                    <td>${this._esc(App.formatTime(row.req_walltime || 0))}</td>
                    <td>${this._esc(this._fmtMaybeTime(row.submit))}</td>
                    <td>${this._esc(App.formatTime(row.current_wait || 0))}</td>
                    <td>${this._esc(this._fmtMaybeTime(row.baseline_start))}</td>
                    <td>${this._esc(App.formatTime(row.baseline_wait_remaining || 0))}</td>
                    <td>${this._esc(this._fmtMaybeTime(row.preview_start))}</td>
                    <td>${this._esc(App.formatTime(row.preview_wait_remaining || 0))}</td>
                    <td class="${this._deltaClass(row.preview_delta_wait)}">${this._esc(this._fmtSignedTime(row.preview_delta_wait || 0))}</td>
                    <td>
                        ${forcePreview || forceDelta ? `${forcePreview}${forceDelta}` : ""}
                        <button type="button" class="btn-ghost btn-inline" data-force-job="${this._esc(row.job_id)}">${isPinned ? "Pinned" : "Pin + Simulate"}</button>
                    </td>
                </tr>
            `;
        }).join("");
    },

    _renderHorizon(kind, payload) {
        const summaryEl = document.getElementById(`op-${kind}-horizon-summary`);
        const body = document.querySelector(`#op-${kind}-horizon-table tbody`);
        if (!summaryEl || !body) return;

        if (!payload || Object.keys(payload).length === 0) {
            summaryEl.innerHTML = this._card("Status", kind === "downtime" ? "No planned downtime scenario" : "No data");
            body.innerHTML = `<tr><td colspan="6">${kind === "downtime" ? "Set a planned downtime offset to simulate maintenance impact." : "No queued jobs at the selected horizon."}</td></tr>`;
            return;
        }

        summaryEl.innerHTML = [
            this._card("Queued", App.formatNum(payload.queued_count || 0)),
            this._card("Running", App.formatNum(payload.running_count || 0)),
            this._card("Completed", App.formatNum(payload.completed_count || 0)),
            this._card("Future", App.formatNum(payload.future_submit_count || 0)),
        ].join("");

        const rows = payload?.queued_jobs || [];
        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="6">No queued jobs at the selected horizon.</td></tr>';
            return;
        }
        body.innerHTML = rows.map(row => `
            <tr>
                <td>${this._esc(row.queue_pos)}</td>
                <td>${this._esc(row.job_id)}</td>
                <td>${this._esc(this._fmtUser(row.user_id))}</td>
                <td>${this._esc(App.formatNum(row.req_proc || 0))}</td>
                <td>${this._esc(App.formatTime(row.req_walltime || 0))}</td>
                <td>${this._esc(App.formatTime(row.remaining_wait || 0))}</td>
            </tr>
        `).join("");
    },

    _renderDowntime(kind, rows) {
        const body = document.querySelector(`#op-${kind}-downtime-table tbody`);
        if (!body) return;
        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="6">No downtime candidates available.</td></tr>';
            return;
        }
        body.innerHTML = rows.map(row => `
            <tr>
                <td>${this._esc(row.rank)}</td>
                <td>${this._esc(row.offset_label || App.formatTime(row.offset_seconds || 0))}</td>
                <td>${this._esc(App.formatNum(row.queued_jobs || 0))}</td>
                <td>${this._esc(App.formatNum(row.running_jobs || 0))}</td>
                <td>${this._esc(App.formatNum(row.running_procs || 0))}</td>
                <td>${this._esc(String(row.impact_score ?? "-"))}</td>
            </tr>
        `).join("");
    },

    _renderDowntimeImpact(rows, summary, planned) {
        const summaryEl = document.getElementById("op-downtime-summary");
        const body = document.querySelector("#op-downtime-table tbody");
        if (!summaryEl || !body) return;

        if (!planned || !planned.enabled) {
            summaryEl.innerHTML = [
                this._card("Planned Downtime", "Disabled"),
                this._card("How To Use", "Set a start offset above"),
            ].join("");
            body.innerHTML = '<tr><td colspan="6">Set a planned downtime offset to compare preview waits against a maintenance scenario.</td></tr>';
            return;
        }

        summaryEl.innerHTML = [
            this._card("Offset", planned.offset_label || this._fmtMaybeTime(planned.offset_seconds || 0)),
            this._card("Duration", App.formatTime(planned.duration_seconds || 0)),
            this._card("Jobs Delayed", App.formatNum(summary.jobs_delayed || 0)),
            this._card("Avg Delta", this._fmtSignedTime(summary.avg_delta_wait || 0)),
            this._card("Worst Increase", this._fmtSignedTime(summary.max_wait_increase || 0)),
        ].join("");

        const impacted = (rows || []).filter(row => row.downtime_wait_remaining != null);
        if (!impacted.length) {
            body.innerHTML = '<tr><td colspan="6">No queue rows were affected by the planned downtime scenario.</td></tr>';
            return;
        }

        body.innerHTML = impacted.map(row => `
            <tr>
                <td>${this._esc(row.queue_pos)}</td>
                <td>${this._esc(row.job_id)}</td>
                <td>${this._esc(this._fmtUser(row.user_id))}</td>
                <td>${this._esc(App.formatTime(row.preview_wait_remaining || 0))}</td>
                <td>${this._esc(App.formatTime(row.downtime_wait_remaining || 0))}</td>
                <td class="${this._deltaClass(row.downtime_delta_wait)}">${this._esc(this._fmtSignedTime(row.downtime_delta_wait || 0))}</td>
            </tr>
        `).join("");
    },
};
