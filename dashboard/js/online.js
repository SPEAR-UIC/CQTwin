// online.js — the dedicated Online Advisory workspace (its own tab).
//
// Owns the full lifecycle in one place: configure -> launch -> in-context
// progress -> interactive results, plus a picker to revisit past online runs.
// The committed schedule is produced by `cqtwin online-run` (byte-identical to
// an offline run of that policy); the per-cycle advisory projections come from
// /api/online/advisory. This module reuses the same launch/status/cancel
// endpoints the offline flow uses, but renders progress inline (no modal) so
// the operator stays in the workspace.

const Online = {
    POLL_MS: 1500,
    DEFAULT_POOL: ["fcfs", "sjf", "wfp3", "f1", "bsld"],
    MAX_POOL: 8,                         // server rejects pools larger than this
    // Okabe-Ito-ish categorical palette; assigned by fixed policy order, never cycled.
    palette: ["#1f77b4", "#d95f02", "#2ca02c", "#9467bd", "#e7298a",
              "#66a61e", "#e6ab02", "#7570b3", "#a6761d", "#666666"],

    // --- run/render state ---
    chart: null,
    data: null,          // /api/online/advisory payload for the loaded run
    summary: null,       // committed run summary (avg_wait, wait_p95, ...)
    committed: "",
    policies: [],
    runName: "",
    runId: null,
    abort: false,
    _pastLoaded: false,
    _startedAt: 0,

    // --- interactive view state ---
    deltaMode: false,    // plot (policy - committed) instead of absolute
    units: "h",          // "h" hours | "s" seconds
    isolated: null,      // a single policy to isolate on the chart, or null
    sortKey: "frac_lowest",
    sortDir: -1,         // -1 desc, 1 asc

    init() {
        this._wirePoolActions();
        this._wireConfig();
        this._wireProgress();
        this._wireSession();
        this._wireResultsControls();
        this._wirePastRuns();
        this._updatePoolCount();
    },

    // Called by the tab-switch handler each time the Online tab is shown.
    onShow() {
        if (!this._pastLoaded) this.loadPastRuns();
    },

    // ---------------------------------------------------------------- config

    // Populate the trace picker from Setup's single /api/files fetch, and enable
    // the launch button once at least one trace is available.
    populateTraces(files, swfFiles) {
        const sel = document.getElementById("sel-online-job-trace");
        if (!sel) return;
        const list = (swfFiles && swfFiles.length) ? swfFiles : (files || []);
        const prev = sel.value;
        sel.innerHTML = list.length
            ? list.map(f => `<option value="${f}">${f}</option>`).join("")
            : `<option value="">No .swf files found</option>`;
        const opts = [...sel.options].map(o => o.value);
        sel.value = opts.includes(prev) ? prev : (list[0] || "");
        const btn = document.getElementById("btn-run-online");
        if (btn) btn.disabled = list.length === 0;
    },

    _wirePoolActions() {
        const actions = document.getElementById("online-pool-actions");
        if (actions) {
            actions.querySelectorAll("a[data-pool]").forEach(link => {
                link.addEventListener("click", e => {
                    e.preventDefault();
                    const mode = link.dataset.pool;
                    this._pool().forEach(cb => {
                        cb.checked = mode === "all" ? true
                                   : mode === "none" ? false
                                   : this.DEFAULT_POOL.includes(cb.value);
                    });
                    this._updatePoolCount();
                });
            });
        }
        this._pool().forEach(cb => cb.addEventListener("change", () => this._updatePoolCount()));
    },

    _wireConfig() {
        const btn = document.getElementById("btn-run-online");
        if (btn) btn.addEventListener("click", () => this.launch());
        const toggle = document.getElementById("btn-online-config-toggle");
        if (toggle) toggle.addEventListener("click", () => {
            const body = document.getElementById("online-config-body");
            const collapsed = body.classList.toggle("hidden");
            toggle.textContent = collapsed ? "Expand" : "Collapse";
        });
        const cancel = document.getElementById("btn-online-cancel");
        if (cancel) cancel.addEventListener("click", () => this.cancel());
    },

    _pool() {
        return [...document.querySelectorAll("#online-pool input[type=checkbox]")];
    },

    _updatePoolCount() {
        const el = document.getElementById("online-pool-count");
        if (!el) return;
        const n = this._pool().filter(c => c.checked).length;
        const over = n > this.MAX_POOL;
        el.textContent = `${n} selected${over ? ` — max ${this.MAX_POOL}` : ""}`;
        el.classList.toggle("over", over);
    },

    _collectParams() {
        const pool = this._pool().filter(c => c.checked).map(c => c.value);
        return {
            job_trace: document.getElementById("sel-online-job-trace").value,
            node_struc: "",
            read_num: -1,
            committed_policy: document.getElementById("sel-online-committed").value,
            advisory_pool: pool,
            backfill: parseInt(document.getElementById("sel-online-backfill").value, 10),
            window_size: parseInt(document.getElementById("inp-online-window").value, 10) || 64,
            horizon_hours: parseFloat(document.getElementById("inp-online-horizon").value),
            interval: parseInt(document.getElementById("inp-online-interval").value, 10),
            run_label: document.getElementById("inp-online-label").value.trim(),
            interactive: !!document.getElementById("inp-online-interactive")?.checked,
            output_mode: "new",
        };
    },

    // Client mirror of the server checks so obvious mistakes surface instantly.
    _validate(p) {
        if (!p.job_trace) return "Select a job trace.";
        if (!p.advisory_pool.length) return "Advisory pool must contain at least one policy.";
        if (p.advisory_pool.length > this.MAX_POOL)
            return `Advisory pool is limited to ${this.MAX_POOL} policies (selected ${p.advisory_pool.length}).`;
        if (!p.committed_policy) return "Choose a committed policy.";
        if (!p.advisory_pool.includes(p.committed_policy))
            return `Committed policy "${p.committed_policy}" must be one of the advisory pool policies.`;
        if (!(p.horizon_hours > 0)) return "Horizon (hours) must be greater than 0.";
        if (!(p.interval >= 1)) return "Projection interval must be at least 1.";
        return null;
    },

    _showError(msg) {
        const el = document.getElementById("online-run-error");
        if (!el) return;
        if (msg) { el.textContent = msg; el.classList.remove("hidden"); }
        else { el.textContent = ""; el.classList.add("hidden"); }
    },

    // ---------------------------------------------------------------- launch

    async launch() {
        const params = this._collectParams();
        this._showError(null);
        const err = this._validate(params);
        if (err) { this._showError(err); return; }

        // Interactive step-through is a different lifecycle (a live socket
        // session, one decision at a time) — hand off to the session flow.
        if (params.interactive) { this._startSession(params); return; }

        this.abort = false;
        this.runId = null;
        this._startedAt = Date.now();
        this._progReset();
        document.getElementById("online-results").classList.add("hidden");
        document.getElementById("online-empty").classList.add("hidden");
        const btn = document.getElementById("btn-run-online");
        if (btn) btn.disabled = true;
        this._setProgress({
            pct: 0, stage: "Dispatching online advisory run", elapsed: 0,
            title: `${params.job_trace} · committed ${params.committed_policy} · pool [${params.advisory_pool.join(", ")}]`,
            log: ["Preparing online advisory request…"],
        });
        this._showProgress(true);

        let runId = null;
        try {
            const resp = await fetch("/api/online-run", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(params),
            });
            const data = await resp.json();
            if (!resp.ok || data.error) throw new Error(data.error || "Failed to launch online run");
            runId = data.run_id;
            this.runId = runId;
        } catch (e) {
            this._showProgress(false);
            if (btn) btn.disabled = false;
            this._showError("Launch failed: " + e.message);
            return;
        }

        const run = await this._poll(runId, r => {
            this._setProgress({
                pct: r.progress || (r.status === "running" ? 50 : 0),
                stage: r.stage || r.status,
                elapsed: Math.floor((Date.now() - this._startedAt) / 1000),
                title: `${params.job_trace} · committed ${params.committed_policy}`,
                log: r.log || [],
            });
        });
        this.runId = null;
        if (btn) btn.disabled = false;

        if (run.status === "cancelled") {
            this._showProgress(false);
            this._showError("Run cancelled.");
            return;
        }
        if (run.status !== "complete") {
            this._showProgress(false);
            this._showError("Online run failed: " + (run.error || run.status || "unknown error"));
            return;
        }

        // Fetch the full result (registers it app-wide so it shows in other
        // pickers/worklog too), then render the advisory view in this tab.
        try {
            const result = await fetch(`/api/results/${runId}`).then(r => r.json());
            if (result.error) throw new Error(result.error);
            App.setResultData(result);
            const runName = (result.meta && result.meta.run_name)
                || (result.summary && result.summary.run_name) || "";
            this._setProgress({ pct: 100, stage: "Complete", elapsed:
                Math.floor((Date.now() - this._startedAt) / 1000), log: ["Done."] });
            await this.renderResults(runName, result.summary || {});
            this._showProgress(false);
            this._pastLoaded = false;   // list is stale; refresh lazily next time
            this.loadPastRuns(runName);
        } catch (e) {
            this._showProgress(false);
            this._showError("Run finished but results failed to load: " + e.message);
        }
    },

    async cancel() {
        this.abort = true;
        if (this.runId) {
            try {
                await fetch("/api/cancel", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ run_id: this.runId }),
                });
            } catch { /* best effort */ }
        }
    },

    _sleep(ms) { return new Promise(r => setTimeout(r, ms)); },

    async _poll(runId, onTick) {
        while (true) {
            if (this.abort) return { status: "cancelled" };
            try {
                const all = await fetch("/api/status").then(r => r.json());
                const run = all[runId];
                if (run) {
                    if (onTick) onTick(run);
                    if (["complete", "error", "cancelled"].includes(run.status)) return run;
                }
            } catch { /* keep waiting through transient errors */ }
            await this._sleep(this.POLL_MS);
        }
    },

    // --------------------------------------------------------- inline progress

    _showProgress(on) {
        const el = document.getElementById("online-progress");
        if (el) el.classList.toggle("hidden", !on);
    },

    _setProgress({ pct = 0, stage = "", elapsed = 0, title = null, log = null } = {}) {
        const bar = document.getElementById("online-prog-bar");
        if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        const setTxt = (id, v) => { const e = document.getElementById(id); if (e && v != null) e.textContent = v; };
        setTxt("online-prog-pct", `${Math.round(pct)}%`);
        setTxt("online-prog-stage", stage);
        setTxt("online-prog-elapsed", `${elapsed}s`);
        if (title != null) setTxt("online-prog-title", title);
        if (log != null) {
            const el = document.getElementById("online-prog-log");
            if (el) {
                el.textContent = (log.length ? log.slice(-14).join("\n") : "No logs yet.");
                el.scrollTop = el.scrollHeight;
            }
            // Parse the engine's structured progress line into live readouts.
            const p = this._parseProgress(log);
            if (p) this._renderProgMetrics(p, elapsed, pct);
        }
    },

    _wireProgress() {
        const btn = document.getElementById("btn-online-prog-log");
        if (btn) btn.addEventListener("click", () => {
            const el = document.getElementById("online-prog-log");
            const hidden = el.classList.toggle("hidden");
            btn.innerHTML = hidden ? "Show log &#9662;" : "Hide log &#9652;";
        });
    },

    _progReset() {
        this._progSamples = [];   // [{ t: elapsedSec, pct }] for the sparkline
        const m = document.getElementById("online-prog-metrics");
        if (m) m.innerHTML = "";
        const eta = document.getElementById("online-prog-eta");
        if (eta) eta.textContent = "ETA —";
        this._drawSpark();
    },

    // Pull the freshest "progress: NN% | cycle X | sim_time T | jobs c/total"
    // line out of the log tail. All fields but the percent are best-effort.
    _parseProgress(logArr) {
        if (!Array.isArray(logArr)) return null;
        for (let i = logArr.length - 1; i >= 0; i--) {
            const line = String(logArr[i] || "");
            const pm = /progress:\s*(\d+)%/.exec(line);
            if (!pm) continue;
            const num = re => { const x = re.exec(line); return x ? Number(x[1]) : null; };
            return {
                pct: Number(pm[1]),
                cycle: num(/cycle\s+(\d+)/),
                sim: num(/sim_time\s+(\d+)/),
                jobsDone: num(/jobs\s+(\d+)\//),
                jobsTotal: num(/jobs\s+\d+\/(\d+)/),
            };
        }
        return null;
    },

    _short(sec) {
        sec = Math.max(0, Math.round(sec));
        if (sec < 60) return `${sec}s`;
        if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
        return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
    },

    _renderProgMetrics(p, elapsed, pctFallback) {
        const pct = p.pct != null ? p.pct : pctFallback;

        // Sample the pace for the sparkline (dedupe repeat elapsed ticks).
        const last = this._progSamples[this._progSamples.length - 1];
        if (!last || last.t !== elapsed) this._progSamples.push({ t: elapsed, pct });
        if (this._progSamples.length > 600) this._progSamples.shift();

        // ETA from percent + elapsed — simple, robust, and monotonic-ish.
        const etaEl = document.getElementById("online-prog-eta");
        if (etaEl) {
            if (pct >= 100) etaEl.textContent = "ETA 0s";
            else if (pct > 1 && elapsed > 0) etaEl.textContent = "ETA ~" + this._short(elapsed * (100 - pct) / pct);
            else etaEl.textContent = "ETA —";
        }

        const thr = (p.jobsDone && elapsed > 0) ? p.jobsDone / elapsed : null;      // jobs / wall-sec
        const simSpeed = (p.sim && elapsed > 0) ? p.sim / elapsed / 3600 : null;    // sim-hours / wall-sec

        const tiles = [];
        if (p.cycle != null) tiles.push(["Cycle", p.cycle.toLocaleString()]);
        if (p.sim != null) tiles.push(["Sim clock", App.formatTime(p.sim)]);
        if (p.jobsDone != null && p.jobsTotal != null)
            tiles.push(["Jobs done", `${p.jobsDone.toLocaleString()} / ${p.jobsTotal.toLocaleString()}`]);
        if (thr != null) tiles.push(["Throughput", `${thr < 10 ? thr.toFixed(1) : Math.round(thr)} jobs/s`]);
        if (simSpeed != null) tiles.push(["Sim speed", `${simSpeed.toFixed(1)} sim-h/s`]);

        const el = document.getElementById("online-prog-metrics");
        if (el) el.innerHTML = tiles.map(([k, v]) =>
            `<div class="prog-tile"><div class="prog-tile-v">${v}</div><div class="prog-tile-k">${k}</div></div>`).join("");

        this._drawSpark();
    },

    _drawSpark() {
        const cv = document.getElementById("online-prog-spark");
        if (!cv) return;
        const w = Math.max(2, cv.clientWidth || cv.width || 600);
        const h = cv.height || 46;
        if (cv.width !== w) cv.width = w;
        const ctx = cv.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, w, h);
        const s = this._progSamples || [];
        if (s.length < 2) return;

        const tMax = s[s.length - 1].t || 1;
        const X = t => (tMax > 0 ? (t / tMax) * (w - 4) + 2 : 2);
        const Y = pct => h - 3 - (Math.max(0, Math.min(100, pct)) / 100) * (h - 6);
        const accent = (getComputedStyle(document.documentElement)
            .getPropertyValue("--accent").trim()) || "#2dd4bf";

        ctx.beginPath();
        ctx.moveTo(X(s[0].t), h);
        s.forEach(pt => ctx.lineTo(X(pt.t), Y(pt.pct)));
        ctx.lineTo(X(s[s.length - 1].t), h);
        ctx.closePath();
        ctx.fillStyle = accent + "22";
        ctx.fill();

        ctx.beginPath();
        s.forEach((pt, i) => (i ? ctx.lineTo(X(pt.t), Y(pt.pct)) : ctx.moveTo(X(pt.t), Y(pt.pct))));
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.8;
        ctx.stroke();

        const head = s[s.length - 1];
        ctx.beginPath();
        ctx.arc(X(head.t), Y(head.pct), 2.6, 0, Math.PI * 2);
        ctx.fillStyle = accent;
        ctx.fill();
    },

    // --------------------------------------------------------------- past runs

    _wirePastRuns() {
        const sel = document.getElementById("sel-online-past");
        if (sel) sel.addEventListener("change", () => {
            const name = sel.value;
            if (name) this.loadRun(name);
        });
        const refresh = document.getElementById("btn-online-refresh-runs");
        if (refresh) refresh.addEventListener("click", () => { this._pastLoaded = false; this.loadPastRuns(); });
    },

    async loadPastRuns(selectName) {
        const sel = document.getElementById("sel-online-past");
        if (!sel) return;
        try {
            const data = await fetch("/api/online/runs").then(r => r.json());
            const runs = (data && data.runs) || [];
            this._pastLoaded = true;
            const keep = selectName || sel.value;
            sel.innerHTML = `<option value="">${runs.length ? "— select a past run —" : "— none found —"}</option>`
                + runs.map(r => {
                    const c = r.committed ? ` · ${r.committed}` : "";
                    return `<option value="${r.run_name}">${r.run_name}${c}</option>`;
                }).join("");
            if (keep && runs.some(r => r.run_name === keep)) sel.value = keep;
        } catch { /* leave the picker as-is on failure */ }
    },

    // Load a past run: pull its committed summary (for the cards) + advisory data.
    async loadRun(runName) {
        this._showError(null);
        let summary = {};
        try {
            const result = await App.fetchRun(runName, { lite: true });
            summary = (result && result.summary) || {};
        } catch { /* advisory still renders without committed cards */ }
        await this.renderResults(runName, summary);
    },

    // ----------------------------------------------------------------- results

    async renderResults(runName, summary) {
        this.runName = runName;
        this.summary = summary || {};
        this.isolated = null;

        let data = null;
        try {
            data = await fetch(`/api/online/advisory?run=${encodeURIComponent(runName)}`).then(r => r.json());
        } catch { data = null; }

        const empty = document.getElementById("online-empty");
        const results = document.getElementById("online-results");
        if (!data || data.error || !data.series || !Object.keys(data.series).length) {
            results.classList.add("hidden");
            empty.classList.remove("hidden");
            empty.textContent = "Advisory data unavailable"
                + (data && data.error ? `: ${data.error}` : ` for "${runName}".`);
            return;
        }

        this.data = data;
        this.committed = data.committed || this.summary.committed_policy || "";
        this.policies = data.policies || Object.keys(data.series);
        empty.classList.add("hidden");
        results.classList.remove("hidden");

        const csv = document.getElementById("online-csv-link");
        if (csv) csv.href = `/api/online/advisory.csv?run=${encodeURIComponent(runName)}`;

        this._renderReco();
        this._renderCards();
        this._renderChart();
        this._renderTable();
    },

    _colorFor(p) {
        const i = Math.max(0, this.policies.indexOf(p));
        return this.palette[i % this.palette.length];
    },

    _meanWait(p) {
        const s = (this.data.summary || {})[p] || {};
        return Number(s.mean_proj_wait || 0);
    },
    _winRate(p) {
        const s = (this.data.summary || {})[p] || {};
        return Number(s.frac_lowest || 0);
    },

    // Best alternative = lowest mean projected wait among non-committed policies.
    _bestAlt() {
        const alts = this.policies.filter(p => p !== this.committed);
        if (!alts.length) return null;
        return alts.reduce((a, b) => (this._meanWait(b) < this._meanWait(a) ? b : a));
    },

    _renderReco() {
        const el = document.getElementById("online-reco");
        if (!el) return;
        const C = String(this.committed || "").toUpperCase();
        const best = this._bestAlt();
        const cMean = this._meanWait(this.committed);
        if (!best) {
            el.className = "online-reco neutral";
            el.innerHTML = `<div class="reco-h">Single-policy pool</div>
                <div class="reco-b">Only the committed policy <b>${C}</b> was projected — add more pool
                policies to see head-to-head advice.</div>`;
            return;
        }
        const bMean = this._meanWait(best);
        const B = best.toUpperCase();
        const bWin = (this._winRate(best) * 100);
        const cWin = (this._winRate(this.committed) * 100);
        const beats = bMean < cMean && cMean > 0;
        const pct = cMean > 0 ? Math.abs(bMean - cMean) / cMean * 100 : 0;

        if (beats) {
            el.className = "online-reco good";
            el.innerHTML = `<div class="reco-h">&#9889; ${B} looks better than committed ${C}</div>
                <div class="reco-b">
                    <b>${B}</b> projected the lowest queue wait in <b>${bWin.toFixed(0)}%</b> of evaluated cycles,
                    with a mean projected wait of <b>${App.formatTime(bMean)}</b> vs committed <b>${C}</b>'s
                    <b>${App.formatTime(cMean)}</b> — about <b>${pct.toFixed(0)}% lower</b>.
                    <span class="reco-caveat">Advisory only: each projection assumes that policy alone ran the
                    live queue from a decision point forward; it is not a guarantee of end-to-end improvement.</span>
                </div>`;
        } else {
            el.className = "online-reco neutral";
            el.innerHTML = `<div class="reco-h">Committed ${C} held up</div>
                <div class="reco-b">
                    No pool policy consistently beat committed <b>${C}</b> on projected wait
                    (${C} was lowest in <b>${cWin.toFixed(0)}%</b> of cycles; closest alternative
                    <b>${B}</b> at mean <b>${App.formatTime(bMean)}</b> vs <b>${App.formatTime(cMean)}</b>).
                    <span class="reco-caveat">Projections are advisory snapshots from each decision point.</span>
                </div>`;
        }
    },

    _renderCards() {
        const s = this.summary || {};
        const best = this._bestAlt();
        const cards = [
            ["Committed Policy", String(this.committed || "—").toUpperCase()],
            ["Advisory Pool", `${this.policies.length}`],
            ["Cycles Evaluated", (this.data.cycles_evaluated || 0).toLocaleString()],
            ["Advisory Rows", (this.data.rows || 0).toLocaleString()],
            ["Committed Avg Wait", s.avg_wait != null ? App.formatTime(s.avg_wait) : "—"],
            ["Committed Wait p95", s.wait_p95 != null ? App.formatTime(s.wait_p95) : "—"],
            ["Best Alt (proj.)", best ? `${best.toUpperCase()} · ${App.formatTime(this._meanWait(best))}` : "—"],
        ];
        document.getElementById("online-cards").innerHTML = cards.map(
            ([label, value]) => `<div class="card"><div class="label">${label}</div><div class="value">${value}</div></div>`
        ).join("");
    },

    // ------------------------------------------------------------- chart

    _visiblePolicies() {
        if (!this.isolated) return this.policies;
        // Isolate a single policy but keep the committed baseline for reference.
        return this.policies.filter(p => p === this.isolated || p === this.committed);
    },

    _renderChart() {
        const div = 3600, unit = this.units === "s" ? 1 : div;
        const unitLabel = this.units === "s" ? "seconds" : "hours";
        const committedByT = new Map();
        (this.data.series[this.committed] || []).forEach(pt => committedByT.set(pt.t, pt.wait));

        const visible = new Set(this._visiblePolicies());
        const datasets = this.policies.filter(p => visible.has(p)).map(p => {
            const isC = p === this.committed;
            const pts = (this.data.series[p] || []).map(pt => {
                let y = pt.wait;
                if (this.deltaMode) {
                    const cw = committedByT.get(pt.t);
                    y = (cw == null) ? null : (pt.wait - cw);
                }
                return { x: pt.t / div, y: y == null ? null : y / unit };
            });
            return {
                label: isC ? `${p} (committed)` : p,
                data: pts,
                borderColor: this._colorFor(p),
                backgroundColor: this._colorFor(p),
                borderWidth: isC ? 3 : 1.5,
                pointRadius: 0,
                spanGaps: true,
                tension: 0.2,
            };
        });

        const theme = App.chartTheme();
        const yTitle = this.deltaMode
            ? `Δ projected wait vs committed (${unitLabel})`
            : `Projected avg wait (${unitLabel})`;
        const ctx = document.getElementById("chart-online-advisory");
        if (this.chart) this.chart.destroy();
        this.chart = new Chart(ctx, {
            type: "line",
            data: { datasets },
            options: App.chartDefaults({
                aspectRatio: 3.0,
                interaction: { mode: "index", intersect: false },
                plugins: {
                    tooltip: {
                        callbacks: {
                            title: items => `t = ${(items[0]?.parsed.x ?? 0).toFixed(2)} h`,
                            label: it => `${it.dataset.label}: ${it.parsed.y == null ? "—"
                                : it.parsed.y.toFixed(2) + " " + (this.units === "s" ? "s" : "h")}`,
                        },
                    },
                },
                scales: {
                    x: { type: "linear", title: { display: true, text: "Simulation time (hours)", color: theme.tick },
                         ticks: { color: theme.tick, font: { size: 10 } }, grid: { color: theme.grid } },
                    y: { beginAtZero: !this.deltaMode,
                         title: { display: true, text: yTitle, color: theme.tick },
                         ticks: { color: theme.tick, font: { size: 10 } }, grid: { color: theme.grid } },
                },
            }),
        });
    },

    _wireResultsControls() {
        const delta = document.getElementById("online-delta-toggle");
        if (delta) delta.addEventListener("change", () => { this.deltaMode = delta.checked; this._renderChart(); });
        const units = document.getElementById("online-units");
        if (units) units.addEventListener("change", () => { this.units = units.value; this._renderChart(); });
        const iso = document.getElementById("btn-online-isolate");
        if (iso) iso.addEventListener("click", () => { this.isolated = this.committed; this._renderChart(); });
        const all = document.getElementById("btn-online-showall");
        if (all) all.addEventListener("click", () => { this.isolated = null; this._renderChart(); });
    },

    // ------------------------------------------------------------- table

    _renderTable() {
        const el = document.getElementById("online-table");
        if (!el) return;
        const cols = [
            { key: "policy", label: "Policy", num: false },
            { key: "frac_lowest", label: "Win rate", num: true },
            { key: "mean_proj_wait", label: "Mean proj. wait", num: true },
            { key: "delta", label: "Δ vs committed", num: true },
        ];
        const cMean = this._meanWait(this.committed);
        const rows = this.policies.map(p => ({
            policy: p,
            frac_lowest: this._winRate(p),
            mean_proj_wait: this._meanWait(p),
            delta: this._meanWait(p) - cMean,
        }));
        rows.sort((a, b) => {
            const va = a[this.sortKey], vb = b[this.sortKey];
            if (typeof va === "string") return this.sortDir * va.localeCompare(vb);
            return this.sortDir * (va - vb);
        });

        const maxWin = Math.max(0.0001, ...rows.map(r => r.frac_lowest));
        const head = cols.map(c => {
            const active = c.key === this.sortKey ? (this.sortDir < 0 ? " ▼" : " ▲") : "";
            return `<th class="sortable${c.num ? " num" : ""}" data-key="${c.key}">${c.label}${active}</th>`;
        }).join("");
        const body = rows.map(r => {
            const isC = r.policy === this.committed;
            const iso = r.policy === this.isolated;
            const winPct = (r.frac_lowest * 100);
            const barW = (r.frac_lowest / maxWin * 100);
            const dSign = r.delta > 0 ? "worse" : (r.delta < 0 ? "better" : "");
            const dTxt = isC ? "—" : (r.delta > 0 ? "+" : "") + App.formatTime(r.delta);
            return `<tr class="online-row${isC ? " committed-row" : ""}${iso ? " isolated-row" : ""}" data-policy="${r.policy}">
                <td><span class="pol-swatch" style="background:${this._colorFor(r.policy)}"></span>${r.policy}${isC ? ' <span class="online-badge">committed</span>' : ""}</td>
                <td class="num"><div class="winbar-wrap"><div class="winbar" style="width:${barW.toFixed(0)}%"></div><span>${winPct.toFixed(1)}%</span></div></td>
                <td class="num">${App.formatTime(r.mean_proj_wait)}</td>
                <td class="num ${dSign}">${dTxt}</td>
            </tr>`;
        }).join("");

        el.innerHTML = `<table class="online-cmp-table">
            <thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;

        el.querySelectorAll("th.sortable").forEach(th => th.addEventListener("click", () => {
            const key = th.dataset.key;
            if (this.sortKey === key) this.sortDir *= -1;
            else { this.sortKey = key; this.sortDir = key === "policy" ? 1 : -1; }
            this._renderTable();
        }));
        el.querySelectorAll("tr.online-row").forEach(tr => tr.addEventListener("click", () => {
            const p = tr.dataset.policy;
            this.isolated = (this.isolated === p) ? null : p;
            this._renderChart();
            this._renderTable();
        }));
    },

    // ───────────────────────── Interactive step-through session ─────────────
    // A live `online-serve` socket session (server-managed) where the operator
    // views the state + advisory at each decision cycle and picks the action.

    _wireSession() {
        const stop = document.getElementById("btn-online-session-stop");
        if (stop) stop.addEventListener("click", () => this._stopSession());
        const go = document.getElementById("btn-online-go-advisory");
        if (go) go.addEventListener("click", () => this._goAdvisory());
        const finish = document.getElementById("btn-online-finish");
        if (finish) finish.addEventListener("click", () => this._advance("end"));
        const change = document.getElementById("btn-online-ff-change");
        if (change) change.addEventListener("click", () => this._advance("change"));
        document.querySelectorAll("#online-session-actions [data-adv]").forEach(b =>
            b.addEventListener("click", () => this._advance(parseInt(b.dataset.adv, 10))));
        // Policy buttons are generated per-session; delegate their clicks.
        const btns = document.getElementById("online-session-policy-btns");
        if (btns) btns.addEventListener("click", e => {
            const b = e.target.closest("button[data-action]");
            if (b) this._decide(parseInt(b.dataset.action, 10));
        });
    },

    _sessBusy(on) {
        this._sessBusyFlag = on;
        document.querySelectorAll("#online-session-actions button, #online-session-policy-btns button")
            .forEach(b => { b.disabled = on; });
    },

    _sessSub(txt) {
        const el = document.getElementById("online-session-sub");
        if (el) el.textContent = txt;
    },

    async _startSession(params) {
        this._showError(null);
        this._showProgress(false);
        document.getElementById("online-results").classList.add("hidden");
        document.getElementById("online-empty").classList.add("hidden");
        const panel = document.getElementById("online-session");
        panel.classList.remove("hidden");
        document.getElementById("online-session-summary").classList.add("hidden");
        this._sessSub("Starting engine…");
        this._sessBusy(true);

        let data;
        try {
            data = await fetch("/api/online/session/start", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify(params),
            }).then(r => r.json());
            if (data.error) throw new Error(data.error);
        } catch (e) {
            panel.classList.add("hidden");
            document.getElementById("online-empty").classList.remove("hidden");
            this._showError("Could not start interactive session: " + e.message);
            return;
        }
        this._sess = {
            id: data.session_id, pool: data.pool || [], committed: data.committed || "",
            obs: data.obs || {}, cycle: 0, history: [],
            // Fast-forward follows the last policy you chose; committed until then.
            lastAction: Math.max(0, (data.pool || []).indexOf(data.committed || "")),
        };
        this._renderPolicyButtons();
        this._renderDecision(data);
    },

    _renderPolicyButtons() {
        const el = document.getElementById("online-session-policy-btns");
        if (!el || !this._sess) return;
        el.innerHTML = this._sess.pool.map((p, i) => {
            const isC = p === this._sess.committed;
            return `<button class="btn-ghost sess-pol${isC ? " committed" : ""}" data-action="${i}"
                title="${isC ? "committed policy" : ""}">${p}${isC ? " ★" : ""}</button>`;
        }).join("");
    },

    _renderDecision(resp) {
        const s = this._sess;
        if (!s) return;
        s.obs = resp.obs || {};
        s.cycle = resp.cycle != null ? resp.cycle : s.cycle;

        if (resp.done || resp.status === "terminal") { this._renderSessionSummary(resp); return; }

        this._sessBusy(false);
        const obs = s.obs;
        this._sessSub(`cycle ${s.cycle.toLocaleString()} · t=${App.formatTime(obs.time || 0)} · ${resp.status || "decision"}`);
        this._renderSessStatus(obs);
        const best = this._renderSessAdvisory(obs);
        this._renderSessQueue(obs);

        const pick = document.getElementById("online-advisory-pick");
        const go = document.getElementById("btn-online-go-advisory");
        if (best) {
            if (go) { go.textContent = `Go with advisory → ${best.policy}`; go.disabled = false; }
            if (pick) pick.textContent = `lowest projected wait: ${best.policy} (${App.formatTime(best.proj_avg_wait)})`;
        } else {
            if (go) { go.textContent = "Go with advisory"; go.disabled = true; }
            if (pick) pick.textContent = "no projection this cycle";
        }
        const ff = document.getElementById("online-ff-policy");
        if (ff) {
            const a = (s.lastAction != null && s.lastAction >= 0 && s.lastAction < s.pool.length)
                ? s.lastAction : Math.max(0, s.pool.indexOf(s.committed));
            ff.textContent = s.pool[a] ? `with ${s.pool[a]}${s.pool[a] === s.committed ? " (committed)" : ""}` : "";
        }
        this._renderSessHistory();
    },

    _renderSessStatus(obs) {
        const sys = obs.system || {}, met = obs.metrics || {};
        const cards = [
            ["Sim clock", App.formatTime(obs.time || 0)],
            ["Utilization", `${((sys.util || 0) * 100).toFixed(0)}%`],
            ["Free procs", `${(sys.free_procs || 0).toLocaleString()} / ${(sys.total_procs || 0).toLocaleString()}`],
            ["Queue", `${sys.queue_len || 0}`],
            ["Running", `${sys.running_count || 0}`],
            ["Completed", `${(met.completed || 0).toLocaleString()}`],
            ["Avg wait so far", App.formatTime(met.avg_wait_so_far || 0)],
        ];
        const el = document.getElementById("online-session-status");
        if (el) el.innerHTML = cards.map(([k, v]) =>
            `<div class="card"><div class="label">${k}</div><div class="value">${v}</div></div>`).join("");
    },

    _renderSessAdvisory(obs) {
        const adv = (obs.advisory || []).slice();
        const el = document.getElementById("online-session-advisory");
        if (!adv.length) { if (el) el.innerHTML = `<p class="hint">No projection this cycle.</p>`; return null; }
        adv.sort((a, b) => a.proj_avg_wait - b.proj_avg_wait);
        const best = adv[0];
        const rows = adv.map(a => {
            const isC = a.policy === this._sess.committed;
            const isB = a === best;
            return `<tr class="${isB ? "best-row" : ""}${isC ? " committed-row" : ""}">
                <td><span class="pol-swatch" style="background:${this._colorFor(a.policy)}"></span>${a.policy}${isC ? ' <span class="online-badge">committed</span>' : ""}${isB ? ' <span class="best-badge">best</span>' : ""}</td>
                <td class="num">${App.formatTime(a.proj_avg_wait)}</td>
                <td class="num">${a.proj_jobs_started}</td></tr>`;
        }).join("");
        if (el) el.innerHTML = `<table class="online-cmp-table">
            <thead><tr><th>Policy</th><th class="num">Proj. avg wait</th><th class="num">Proj. jobs started</th></tr></thead>
            <tbody>${rows}</tbody></table>`;
        return best;
    },

    _renderSessQueue(obs) {
        const q = (obs.queue || []).slice(0, 12);
        const el = document.getElementById("online-session-queue");
        if (!el) return;
        if (!q.length) { el.innerHTML = `<p class="hint">Queue is empty at this cycle.</p>`; return; }
        const rows = q.map(j => `<tr>
            <td>${j.id}</td><td class="num">${(j.procs || 0).toLocaleString()}</td>
            <td class="num">${App.formatTime(j.walltime || 0)}</td>
            <td class="num">${App.formatTime(j.waited || 0)}</td></tr>`).join("");
        el.innerHTML = `<table class="online-cmp-table">
            <thead><tr><th>Job</th><th class="num">Procs</th><th class="num">Walltime</th><th class="num">Waited</th></tr></thead>
            <tbody>${rows}</tbody></table>`;
    },

    _renderSessHistory() {
        const el = document.getElementById("online-session-history");
        const cnt = document.getElementById("online-session-histcount");
        if (!el || !this._sess) return;
        const h = this._sess.history;
        if (cnt) cnt.textContent = h.length ? `(${h.length})` : "";
        if (!h.length) { el.innerHTML = `<p class="hint">No decisions yet — pick a policy or “Go with advisory”.</p>`; return; }
        const rows = h.slice(-20).reverse().map(e => `<tr>
            <td>${e.cycle}</td><td>${e.label}</td>
            <td class="num">${e.jobs != null ? e.jobs : "—"}</td>
            <td class="num">${App.formatTime(e.time || 0)}</td></tr>`).join("");
        el.innerHTML = `<table class="online-cmp-table">
            <thead><tr><th>Cycle</th><th>Chosen</th><th class="num">Jobs started</th><th class="num">Sim clock</th></tr></thead>
            <tbody>${rows}</tbody></table>`;
    },

    _goAdvisory() {
        const adv = (this._sess && this._sess.obs && this._sess.obs.advisory) || [];
        if (!adv.length) return;
        const best = adv.reduce((a, b) => (b.proj_avg_wait < a.proj_avg_wait ? b : a));
        this._decide(this._sess.pool.indexOf(best.policy), `${best.policy} (advisory)`);
    },

    async _decide(action, label) {
        const s = this._sess;
        if (!s || this._sessBusyFlag) return;
        if (action == null || action < 0) return;
        this._sessBusy(true);
        this._sessSub("Applying…");
        let resp;
        try {
            resp = await fetch("/api/online/session/step", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ session_id: s.id, action }),
            }).then(r => r.json());
            // Any error field means the step did not apply — surface it, even if
            // the server also set done:true (e.g. a reaped/closed session 404).
            if (resp.error) throw new Error(resp.error);
        } catch (e) {
            this._sessBusy(false);
            this._showError("Step failed: " + e.message);
            return;
        }
        // Commit the choice only after the step actually succeeded, so the
        // fast-forward policy and its label can never diverge from what ran.
        s.lastAction = action;
        s.history.push({
            cycle: s.cycle, label: label || s.pool[action] || `#${action}`,
            jobs: resp.info && resp.info.jobs_started, time: resp.obs && resp.obs.time,
        });
        this._renderDecision(resp);
    },

    async _advance(count) {
        const s = this._sess;
        if (!s || this._sessBusyFlag) return;
        // Fast-forward follows the last policy chosen (committed until you pick one).
        const action = (s.lastAction != null && s.lastAction >= 0 && s.lastAction < s.pool.length)
            ? s.lastAction : Math.max(0, s.pool.indexOf(s.committed));
        const pol = s.pool[action] || s.committed;
        this._sessBusy(true);
        this._sessSub(
            count === "end" ? `Finishing with ${pol}…` :
            count === "change" ? `Advancing with ${pol} to next queue change…` :
            `Advancing ${count} cycles with ${pol}…`);
        let resp;
        try {
            resp = await fetch("/api/online/session/advance", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ session_id: s.id, action, count }),
            }).then(r => r.json());
            // Surface any error (incl. reaped-session 404 / advance-loop 500 that
            // also carry done:true) instead of rendering a zeroed-out "complete".
            if (resp.error) throw new Error(resp.error);
        } catch (e) {
            this._sessBusy(false);
            this._showError("Advance failed: " + e.message);
            return;
        }
        const n = resp.advanced != null ? resp.advanced : count;
        // Label truthfully: only claim a queue change when the server actually
        // stopped for one (not when it hit the safety cap unchanged).
        let why = "";
        if (count === "change") {
            why = resp.stopped === "change" ? " to queue change"
                : resp.done ? "" : " (safety cap — queue unchanged)";
        }
        s.history.push({
            cycle: s.cycle, label: `fast-forward ${n} × ${pol}${why}`,
            jobs: null, time: resp.obs && resp.obs.time,
        });
        this._renderDecision(resp);
    },

    _renderSessionSummary(resp) {
        this._sessBusy(false);
        const sum = (resp.info && resp.info.summary) || {};
        const cycles = (this._sess && this._sess.cycle) || 0;
        this._sessSub(`done · ${cycles.toLocaleString()} cycles`);
        const el = document.getElementById("online-session-summary");
        if (el) {
            el.className = "online-reco good";
            el.innerHTML = `<div class="reco-h">✓ Interactive run complete</div>
                <div class="reco-b">
                    Drove the trace over <b>${cycles.toLocaleString()}</b> decision cycles. Final result:
                    avg wait <b>${App.formatTime(sum.avg_wait || 0)}</b>,
                    p90 <b>${App.formatTime(sum.p90_wait || 0)}</b>,
                    p99 <b>${App.formatTime(sum.p99_wait || 0)}</b>,
                    makespan <b>${App.formatTime(sum.makespan || 0)}</b>,
                    completed <b>${(sum.completed || 0).toLocaleString()}</b> jobs.
                    <span class="reco-caveat">Stop the session to configure another run.</span>
                </div>`;
            el.classList.remove("hidden");
        }
        this._renderSessHistory();
        this._sess = null;   // server closes the session on completion
    },

    async _stopSession() {
        const s = this._sess;
        this._sess = null;
        document.getElementById("online-session").classList.add("hidden");
        document.getElementById("online-empty").classList.remove("hidden");
        if (s) {
            try {
                await fetch("/api/online/session/close", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ session_id: s.id }),
                });
            } catch { /* best effort */ }
        }
    },
};
