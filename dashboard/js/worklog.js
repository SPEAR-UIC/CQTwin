/* worklog.js - Worklog tab: run log table + SWF worklog analyzer */

const Worklog = {
    data: [],
    charts: {},
    _bound: false,
    _analysisFallbackFlags: [],
    _heatmapHoverStates: {},
    _lastAnalysisPayload: null,

    _safeMax(values, fallback = 0) {
        let best = Number(fallback || 0);
        if (!Array.isArray(values)) return best;
        for (let i = 0; i < values.length; i++) {
            const v = Number(values[i]);
            if (Number.isFinite(v) && v > best) best = v;
        }
        return best;
    },

    init(data) {
        this.data = data || [];
        this.populateFilter();
        this.renderRunLog();
        this.bind();
        this.loadWorklogFiles();
    },

    bind() {
        if (this._bound) return;
        this._bound = true;

        const filterSel = document.getElementById("worklog-filter");
        if (filterSel) {
            filterSel.addEventListener("change", () => this.renderRunLog());
        }

        const analyzeBtn = document.getElementById("btn-worklog-analyze");
        if (analyzeBtn) {
            analyzeBtn.addEventListener("click", () => this.analyzeSelected());
        }

        const uploadInput = document.getElementById("worklog-upload-input");
        if (uploadInput) {
            uploadInput.addEventListener("change", e => this.uploadWorklogSWF(e));
        }
    },

    setStatus(msg, isError = false) {
        const el = document.getElementById("worklog-status");
        if (!el) return;
        el.textContent = msg || "";
        el.style.color = isError ? "#fca5a5" : "#87a7bf";
    },

    setMeta(msg) {
        const el = document.getElementById("worklog-meta");
        if (!el) return;
        el.textContent = msg || "";
    },

    populateFilter() {
        const sel = document.getElementById("worklog-filter");
        if (!sel) return;
        const current = sel.value;

        const systems = [...new Set(this.data.map(d => d.system || "unknown"))].sort();
        sel.innerHTML = '<option value="all">All</option>' +
            systems.map(s => `<option value="${s}">${s}</option>`).join("");

        if (systems.includes(current)) sel.value = current;
    },

    _runLabel(d) {
        const system = d.system || "custom";
        const variant = d.variant || "custom";
        const scenario = (d.scenario || "").trim();
        const core = `${system} (${variant})`;
        return scenario ? `${core} | ${scenario}` : (d.run_name || core);
    },

    renderRunLog() {
        const filterEl = document.getElementById("worklog-filter");
        const filter = filterEl ? filterEl.value : "all";
        const rows = filter === "all"
            ? this.data
            : this.data.filter(d => (d.system || "unknown") === filter);

        const tbody = document.querySelector("#worklog-table tbody");
        if (!tbody) return;

        tbody.innerHTML = rows.map(d => `
            <tr>
                <td>${d.id ?? ""}</td>
                <td>${d.timestamp || ""}</td>
                <td>${this._runLabel(d)}</td>
                <td>${d.input_file || ""}</td>
                <td><code>${d.algorithm || ""}</code></td>
                <td>${d.backfill || ""}</td>
                <td>${d.win ?? ""}</td>
                <td>${(d.total_jobs || 0).toLocaleString()}</td>
                <td>${App.formatTime(d.avg_wait || 0)}</td>
                <td>${App.formatTime(d.wait_p95 || 0)}</td>
                <td>${((d.avg_utilization || 0) * 100).toFixed(1)}%</td>
                <td>${(d.peak_queue_depth || 0).toLocaleString()}</td>
                <td>${App.formatTime(d.makespan || 0)}</td>
            </tr>
        `).join("");
    },

    async loadWorklogFiles(preferred) {
        const sel = document.getElementById("worklog-swf-select");
        if (!sel) return;

        const previous = preferred || sel.value;
        try {
            const payload = await fetch("/api/worklogs/files").then(r => r.json());
            if (payload.error) throw new Error(payload.error);

            const files = payload.files || [];
            if (!files.length) {
                sel.innerHTML = '<option value="">No worklog SWF files found</option>';
                this.setStatus("Add SWF files in dashboard/data/worklogs or upload one.");
                this.clearAnalysis();
                return;
            }

            sel.innerHTML = files
                .map(f => `<option value="${f.name}">${f.name}</option>`)
                .join("");

            const names = files.map(f => f.name);
            sel.value = names.includes(previous) ? previous : names[0];
            this.setStatus(`Found ${files.length} worklog SWF file(s).`);
        } catch (err) {
            sel.innerHTML = '<option value="">Cannot load worklog files</option>';
            this.setStatus(`Cannot load worklog SWFs: ${err.message}`, true);
            this.clearAnalysis();
        }
    },

    async uploadWorklogSWF(event) {
        const input = event?.target;
        const file = input?.files?.[0];
        if (!file) return;

        this.setStatus("Uploading SWF to worklogs...");
        try {
            const resp = await fetch("/api/worklogs/upload", {
                method: "POST",
                headers: {
                    "Content-Length": file.size,
                    "X-Filename": file.name,
                },
                body: file,
            });
            const data = await resp.json();
            if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);

            this.setStatus(`Uploaded: ${data.filename}`);
            await this.loadWorklogFiles(data.filename);
            await this.analyzeSelected();
        } catch (err) {
            this.setStatus(`Upload failed: ${err.message}`, true);
        } finally {
            input.value = "";
        }
    },

    async analyzeSelected() {
        const sel = document.getElementById("worklog-swf-select");
        const file = sel?.value || "";
        if (!file) {
            this.setStatus("Choose a worklog SWF file first.", true);
            return;
        }

        this.setStatus(`Analyzing ${file} ...`);
        try {
            const url = `/api/worklogs/analyze?file=${encodeURIComponent(file)}`;
            const payloadRaw = await fetch(url).then(r => r.json());
            if (payloadRaw.error) throw new Error(payloadRaw.error);
            const payload = this.normalizeAnalysisPayload(payloadRaw);
            this._analysisFallbackFlags = payload._fallback_flags || [];
            this._lastAnalysisPayload = payload;

            this.renderSummary(payload);
            this.renderCharts(payload);
            this.renderTopUsers(payload.top_users || []);
            this.renderCongestionWindows(payload.congestion_windows || []);
            if (this._analysisFallbackFlags.length) {
                this.setStatus(
                    `Analysis complete for ${file}. Compatibility mode: ${this._analysisFallbackFlags.join(", ")} derived from available data.`
                );
            } else {
                this.setStatus(`Analysis complete for ${file}.`);
            }
        } catch (err) {
            this.setStatus(`Analysis failed: ${err.message}`, true);
            this.clearAnalysis();
        }
    },

    normalizeAnalysisPayload(payload) {
        const out = payload || {};
        const fallbackFlags = [];

        if (!out.wait_by_runtime_class?.labels?.length) {
            const derived = this._deriveRuntimeClassFromScatter(out.scatter || {});
            if (derived.labels.length) {
                out.wait_by_runtime_class = derived;
                fallbackFlags.push("runtime-class");
            }
        }

        if (!out.wait_heatmap?.x_labels?.length || !out.wait_heatmap?.y_labels?.length) {
            const derived = this._deriveWaitHeatmapFromScatter(out.scatter || {});
            if (derived.x_labels.length && derived.y_labels.length) {
                out.wait_heatmap = derived;
                fallbackFlags.push("heatmap");
            }
        }

        if (!out.proc_runtime_wait_heatmap?.x_labels?.length || !out.proc_runtime_wait_heatmap?.y_labels?.length) {
            const derived = this._deriveProcRuntimeWaitHeatmapFromScatter(out.scatter || {});
            if (derived.x_labels.length && derived.y_labels.length) {
                out.proc_runtime_wait_heatmap = derived;
                fallbackFlags.push("proc-runtime-heatmap");
            }
        }

        if (!out.pressure_timeline?.labels?.length) {
            const derived = this._derivePressureFromTimeline(
                out.submit_timeline || {},
                out.summary || {},
                out.header || {}
            );
            if (derived.labels.length) {
                out.pressure_timeline = derived;
                fallbackFlags.push("pressure");
            }
        }

        if (!Array.isArray(out.congestion_windows) || !out.congestion_windows.length) {
            const derived = this._deriveCongestionWindows(out.pressure_timeline || {});
            if (derived.length) {
                out.congestion_windows = derived;
                if (!fallbackFlags.includes("pressure")) fallbackFlags.push("congestion");
            }
        }

        out._fallback_flags = fallbackFlags;
        return out;
    },

    _deriveRuntimeClassFromScatter(scatter) {
        const runs = Array.isArray(scatter?.run) ? scatter.run : [];
        const waits = Array.isArray(scatter?.wait) ? scatter.wait : [];
        if (!runs.length || !waits.length) {
            return { labels: [], counts: [], avg_wait: [], p90_wait: [], p95_wait: [] };
        }

        const buckets = [
            { label: "Short (<4h)", lo: 0, hi: 4 * 3600 },
            { label: "Medium (4h-24h)", lo: 4 * 3600, hi: 24 * 3600 },
            { label: "Long (>24h)", lo: 24 * 3600, hi: Number.POSITIVE_INFINITY },
        ];

        const groups = buckets.map(() => []);
        for (let i = 0; i < runs.length; i++) {
            const run = Number(runs[i] || 0);
            const wait = Number(waits[i] || 0);
            for (let bi = 0; bi < buckets.length; bi++) {
                if (run >= buckets[bi].lo && run < buckets[bi].hi) {
                    groups[bi].push(wait);
                    break;
                }
            }
        }

        const labels = [];
        const counts = [];
        const avg_wait = [];
        const p90_wait = [];
        const p95_wait = [];
        for (let bi = 0; bi < buckets.length; bi++) {
            const arr = groups[bi].slice().sort((a, b) => a - b);
            labels.push(buckets[bi].label);
            counts.push(arr.length);
            avg_wait.push(this._mean(arr));
            p90_wait.push(this._percentileSorted(arr, 90));
            p95_wait.push(this._percentileSorted(arr, 95));
        }

        return { labels, counts, avg_wait, p90_wait, p95_wait };
    },

    _deriveWaitHeatmapFromScatter(scatter) {
        const reqProcs = Array.isArray(scatter?.req_procs) ? scatter.req_procs.map(v => Number(v || 0)) : [];
        const waits = Array.isArray(scatter?.wait) ? scatter.wait.map(v => Number(v || 0)) : [];
        if (!reqProcs.length || !waits.length) {
            return {
                x_labels: [],
                y_labels: [],
                counts: [],
                avg_wait: [],
                max_count: 0,
                max_avg_wait: 0,
                total_jobs: 0,
            };
        }

        const maxReq = this._safeMax(reqProcs, 0);
        const maxWait = this._safeMax(waits, 0);

        const reqEdges = [0, 1, 8, 32, 128, 512, 2048, 8192, 32768, 131072];
        while (maxReq > reqEdges[reqEdges.length - 1] && reqEdges.length < 14) {
            reqEdges.push(reqEdges[reqEdges.length - 1] * 2);
        }

        const waitEdges = [0, 60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400, 172800, 604800];
        while (maxWait > waitEdges[waitEdges.length - 1] && waitEdges.length < 18) {
            waitEdges.push(waitEdges[waitEdges.length - 1] * 2);
        }

        const rows = reqEdges.length - 1;
        const cols = waitEdges.length - 1;
        const counts = Array.from({ length: rows }, () => Array(cols).fill(0));
        const waitSum = Array.from({ length: rows }, () => Array(cols).fill(0));

        const bucketIndex = (edges, value) => {
            for (let i = edges.length - 2; i >= 0; i--) {
                if (value >= edges[i]) return i;
            }
            return 0;
        };

        for (let i = 0; i < reqProcs.length; i++) {
            const r = bucketIndex(reqEdges, reqProcs[i]);
            const c = bucketIndex(waitEdges, waits[i]);
            counts[r][c] += 1;
            waitSum[r][c] += waits[i];
        }

        let maxCount = 0;
        let maxAvgWait = 0;
        const avg_wait = counts.map((row, r) => row.map((ct, c) => {
            maxCount = Math.max(maxCount, ct);
            if (!ct) return 0;
            const avg = waitSum[r][c] / ct;
            maxAvgWait = Math.max(maxAvgWait, avg);
            return avg;
        }));

        return {
            x_labels: this._labelsFromEdges(waitEdges, true),
            y_labels: this._labelsFromEdges(reqEdges, false),
            counts,
            avg_wait,
            max_count: maxCount,
            max_avg_wait: maxAvgWait,
            total_jobs: reqProcs.length,
        };
    },

    _deriveProcRuntimeWaitHeatmapFromScatter(scatter) {
        const reqProcs = Array.isArray(scatter?.req_procs) ? scatter.req_procs.map(v => Number(v || 0)) : [];
        const runtimes = Array.isArray(scatter?.run) ? scatter.run.map(v => Number(v || 0)) : [];
        const waits = Array.isArray(scatter?.wait) ? scatter.wait.map(v => Number(v || 0)) : [];
        if (!reqProcs.length || !runtimes.length || !waits.length) {
            return {
                x_labels: [],
                y_labels: [],
                counts: [],
                avg_wait: [],
                max_count: 0,
                max_avg_wait: 0,
                total_jobs: 0,
            };
        }

        const maxReq = this._safeMax(reqProcs, 0);
        const maxRun = this._safeMax(runtimes, 0);
        const reqEdges = [0, 1, 8, 32, 128, 512, 2048, 8192, 32768, 131072];
        while (maxReq > reqEdges[reqEdges.length - 1] && reqEdges.length < 14) {
            reqEdges.push(reqEdges[reqEdges.length - 1] * 2);
        }

        const runEdges = [0, 60, 300, 900, 1800, 3600, 14400, 43200, 86400, 259200, 604800];
        while (maxRun > runEdges[runEdges.length - 1] && runEdges.length < 18) {
            runEdges.push(runEdges[runEdges.length - 1] * 2);
        }

        const rows = reqEdges.length - 1;
        const cols = runEdges.length - 1;
        const counts = Array.from({ length: rows }, () => Array(cols).fill(0));
        const waitSum = Array.from({ length: rows }, () => Array(cols).fill(0));

        const bucketIndex = (edges, value) => {
            for (let i = edges.length - 2; i >= 0; i--) {
                if (value >= edges[i]) return i;
            }
            return 0;
        };

        const total = Math.min(reqProcs.length, runtimes.length, waits.length);
        for (let i = 0; i < total; i++) {
            const r = bucketIndex(reqEdges, reqProcs[i]);
            const c = bucketIndex(runEdges, runtimes[i]);
            counts[r][c] += 1;
            waitSum[r][c] += waits[i];
        }

        let maxCount = 0;
        let maxAvgWait = 0;
        const avg_wait = counts.map((row, r) => row.map((ct, c) => {
            maxCount = Math.max(maxCount, ct);
            if (!ct) return 0;
            const avg = waitSum[r][c] / ct;
            maxAvgWait = Math.max(maxAvgWait, avg);
            return avg;
        }));

        return {
            x_labels: this._labelsFromEdges(runEdges, true),
            y_labels: this._labelsFromEdges(reqEdges, false),
            counts,
            avg_wait,
            max_count: maxCount,
            max_avg_wait: maxAvgWait,
            total_jobs: total,
        };
    },

    _derivePressureFromTimeline(timeline, summary, header) {
        const labels = Array.isArray(timeline?.labels) ? timeline.labels : [];
        if (!labels.length) {
            return {
                labels: [],
                time: [],
                queue_depth: [],
                running_depth: [],
                queue_procs: [],
                running_procs: [],
                queue_share: [],
                running_share: [],
                span_seconds: 0,
            };
        }

        const jobsPerDay = Array.isArray(timeline?.jobs_per_day) ? timeline.jobs_per_day : [];
        const avgWait = Array.isArray(timeline?.avg_wait) ? timeline.avg_wait : [];
        const avgRuntime = Array.isArray(timeline?.avg_runtime) ? timeline.avg_runtime : [];
        const time = Array.isArray(timeline?.time) ? timeline.time : labels.map((_, i) => i);

        const avgReqProcs = Number(summary?.avg_req_procs || 0);
        const maxProcs = Number(header?.max_procs || 0);

        const queue_depth = [];
        const running_depth = [];
        const queue_procs = [];
        const running_procs = [];
        const queue_share = [];
        const running_share = [];

        for (let i = 0; i < labels.length; i++) {
            const lambda = Math.max(0, Number(jobsPerDay[i] || 0) / 86400.0);
            const qd = lambda * Math.max(0, Number(avgWait[i] || 0));
            const rd = lambda * Math.max(0, Number(avgRuntime[i] || 0));
            const qp = qd * avgReqProcs;
            const rp = rd * avgReqProcs;
            queue_depth.push(qd);
            running_depth.push(rd);
            queue_procs.push(qp);
            running_procs.push(rp);
            if (maxProcs > 0) {
                queue_share.push(qp / maxProcs);
                running_share.push(rp / maxProcs);
            } else {
                queue_share.push(0);
                running_share.push(0);
            }
        }

        const span_seconds = time.length > 1
            ? Math.max(0, Number(time[time.length - 1]) - Number(time[0]))
            : 0;

        return {
            labels,
            time,
            queue_depth,
            running_depth,
            queue_procs,
            running_procs,
            queue_share,
            running_share,
            span_seconds,
        };
    },

    _deriveCongestionWindows(pressure) {
        const labels = Array.isArray(pressure?.labels) ? pressure.labels : [];
        const time = Array.isArray(pressure?.time) ? pressure.time : [];
        const qDepth = Array.isArray(pressure?.queue_depth) ? pressure.queue_depth : [];
        const qProcs = Array.isArray(pressure?.queue_procs) ? pressure.queue_procs : [];
        const runShare = Array.isArray(pressure?.running_share) ? pressure.running_share : [];
        if (!labels.length || !qProcs.length) return [];

        const idx = [...qProcs.keys()]
            .sort((a, b) => {
                const d = Number(qProcs[b] || 0) - Number(qProcs[a] || 0);
                if (d !== 0) return d;
                return Number(qDepth[b] || 0) - Number(qDepth[a] || 0);
            })
            .slice(0, 10);

        return idx.map((i, rank) => ({
            rank: rank + 1,
            time: labels[i] || App.formatTime(Number(time[i] || 0)),
            t_seconds: Number(time[i] || 0),
            queue_depth: Number(qDepth[i] || 0),
            queue_procs: Number(qProcs[i] || 0),
            running_share: Number(runShare[i] || 0),
        }));
    },

    _mean(values) {
        if (!values?.length) return 0;
        return values.reduce((s, v) => s + Number(v || 0), 0) / values.length;
    },

    _percentileSorted(values, p) {
        if (!values?.length) return 0;
        if (p <= 0) return Number(values[0] || 0);
        if (p >= 100) return Number(values[values.length - 1] || 0);
        const k = (values.length - 1) * (p / 100);
        const lo = Math.floor(k);
        const hi = Math.ceil(k);
        if (lo === hi) return Number(values[lo] || 0);
        const frac = k - lo;
        return Number(values[lo] || 0) * (1 - frac) + Number(values[hi] || 0) * frac;
    },

    _labelsFromEdges(edges, isTime) {
        const fmtTime = s => {
            const v = Math.max(0, Number(s || 0));
            if (v < 60) return `${Math.round(v)}s`;
            if (v < 3600) return `${(v / 60).toFixed(1)}m`;
            if (v < 86400) return `${(v / 3600).toFixed(1)}h`;
            return `${(v / 86400).toFixed(1)}d`;
        };
        const fmtCount = n => {
            const v = Math.max(0, Number(n || 0));
            if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
            if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
            return `${Math.round(v)}`;
        };

        const labels = [];
        for (let i = 0; i < edges.length - 1; i++) {
            const lo = isTime ? fmtTime(edges[i]) : fmtCount(edges[i]);
            if (i === edges.length - 2) {
                labels.push(`${lo}+`);
            } else {
                const hi = isTime ? fmtTime(edges[i + 1]) : fmtCount(edges[i + 1]);
                labels.push(`${lo}-${hi}`);
            }
        }
        return labels;
    },

    _shortHeatLabel(label) {
        if (!label) return "";
        let out = String(label)
            .replace(/\.0([mhd])/g, "$1")
            .replace(/\.0\+/g, "+");
        if (out.length > 14 && out.includes("-")) {
            const parts = out.split("-");
            if (parts.length >= 2) out = `${parts[0]}-${parts[parts.length - 1]}`;
        }
        return out;
    },

    renderSummary(payload) {
        const summary = payload?.summary || {};
        const header = payload?.header || {};
        const summaryEl = document.getElementById("worklog-summary");
        if (!summaryEl) return;

        const cards = [
            ["File", payload.file || "-"],
            ["Computer", header.computer || "-"],
            ["Total Jobs", (summary.total_jobs || 0).toLocaleString()],
            ["Unique Users", (summary.unique_users || 0).toLocaleString()],
            ["Avg Wait", App.formatTime(summary.avg_wait || 0)],
            ["Wait p95", App.formatTime(summary.wait_p95 || 0)],
            ["Wait p99", App.formatTime(summary.wait_p99 || 0)],
            ["Avg Runtime", App.formatTime(summary.avg_runtime || 0)],
            ["Avg Bounded Slowdown", `${(summary.avg_bounded_slowdown || 0).toFixed(2)}x`],
            ["Queue p95 (est)", App.formatNum(summary.queue_depth_p95_est || 0)],
            ["Queue Procs p95 (est)", App.formatNum(summary.queue_procs_p95_est || 0)],
            ["Jobs/Day", (summary.jobs_per_day || 0).toFixed(1)],
            ["Req < Runtime", `${(summary.under_requested_pct || 0).toFixed(2)}%`],
            ["Interarrival CV", (summary.interarrival_cv || 0).toFixed(2)],
            ["User Fairness (Jain)", (summary.user_wait_jain || 0).toFixed(3)],
        ];

        summaryEl.innerHTML = cards.map(([label, value]) => `
            <div class="card">
                <div class="label">${label}</div>
                <div class="value"${label === "File" ? ' style="font-size:1rem"' : ""}>${value}</div>
            </div>
        `).join("");

        const maxNodes = header.max_nodes ? `${header.max_nodes.toLocaleString()} nodes` : "n/a";
        const maxProcs = header.max_procs ? `${header.max_procs.toLocaleString()} procs` : "n/a";
        const span = App.formatTime(summary.submit_span || 0);
        const parsed = (summary.parsed_rows || 0).toLocaleString();
        const skipped = (summary.skipped_rows || 0).toLocaleString();
        const fallback = ((summary.fallback_req_time_rows || 0) + (summary.fallback_req_procs_rows || 0)).toLocaleString();
        let meta = `Cluster: ${maxNodes}, ${maxProcs} | Submit span: ${span} | Parsed rows: ${parsed} (skipped ${skipped}) | Fallback-derived fields: ${fallback} rows`;
        if (this._analysisFallbackFlags.length) {
            meta += ` | Compatibility mode: ${this._analysisFallbackFlags.join(", ")} derived in UI`;
        }
        this.setMeta(meta);
    },

    renderCharts(payload) {
        const submitTimeline = payload?.submit_timeline || {};
        const pressureTimeline = payload?.pressure_timeline || {};

        this.renderRuntimeDistChart(payload?.histograms?.runtime || {});
        this.renderProcDistChart(payload?.histograms?.req_procs || {});
        this.renderRuntimeClassWaitChart(payload?.wait_by_runtime_class || {});
        this.renderReqVsRunScatter(payload?.scatter || {});
        this.renderArrivalChart(submitTimeline);
        this.renderUtilizationMakespanChart(submitTimeline, pressureTimeline);
        this.renderPressureChart(submitTimeline, pressureTimeline);
        this.renderProcRuntimeWaitHeatmap(payload?.proc_runtime_wait_heatmap || {});
        this.renderWaitHeatmap(payload?.wait_heatmap || {});
    },

    renderArrivalChart(timeline) {
        const id = "chart-worklog-arrival";
        const ctx = document.getElementById(id);
        if (!ctx) return;
        this.destroyChart(id);

        const labels = timeline.labels || [];
        this.charts[id] = new Chart(ctx, {
            type: "bar",
            data: {
                labels,
                datasets: [
                    {
                        type: "bar",
                        label: "Jobs/Day",
                        data: timeline.jobs_per_day || [],
                        backgroundColor: "rgba(45, 212, 191, 0.35)",
                        borderColor: "#2dd4bf",
                        borderWidth: 1,
                        yAxisID: "y",
                    },
                    {
                        type: "line",
                        label: "Avg Wait",
                        data: timeline.avg_wait || [],
                        borderColor: "#f59e0b",
                        backgroundColor: "#f59e0b33",
                        fill: false,
                        pointRadius: 0,
                        borderWidth: 1.5,
                        tension: 0.2,
                        yAxisID: "y1",
                    },
                ],
            },
            options: {
                ...App.chartDefaults(),
                scales: {
                    x: {
                        ticks: { color: "#8fb2c8", maxTicksLimit: 12 },
                        grid: { color: "#1e394f" },
                    },
                    y: {
                        position: "left",
                        ticks: { color: "#8de9dc" },
                        grid: { color: "#1e394f" },
                        title: { display: true, text: "Jobs/Day", color: "#8de9dc" },
                    },
                    y1: {
                        position: "right",
                        ticks: { color: "#f8c67b", callback: v => App.formatTime(v) },
                        grid: { drawOnChartArea: false },
                        title: { display: true, text: "Avg Wait", color: "#f8c67b" },
                    },
                },
            },
        });
        App.enableLineChartZoom(this.charts[id], { xScaleId: "x", minWindow: 8, zoomFactor: 0.55 });
    },

    _resampleLinear(values, targetLen, fillValue = 0) {
        const src = Array.isArray(values) ? values.map(v => Number(v || 0)) : [];
        if (!targetLen || targetLen <= 0) return src;
        if (!src.length) return Array(targetLen).fill(fillValue);
        if (src.length === targetLen) return src;
        if (targetLen === 1) return [src[0]];
        if (src.length === 1) return Array(targetLen).fill(src[0]);

        const out = [];
        for (let i = 0; i < targetLen; i++) {
            const t = i / (targetLen - 1);
            const pos = t * (src.length - 1);
            const lo = Math.floor(pos);
            const hi = Math.min(src.length - 1, Math.ceil(pos));
            const frac = pos - lo;
            const val = src[lo] * (1 - frac) + src[hi] * frac;
            out.push(val);
        }
        return out;
    },

    renderUtilizationMakespanChart(submitTimeline, pressure) {
        const id = "chart-worklog-util-makespan";
        const ctx = document.getElementById(id);
        if (!ctx) return;
        this.destroyChart(id);

        const submitLabels = Array.isArray(submitTimeline?.labels) ? submitTimeline.labels : [];
        const pressureLabels = Array.isArray(pressure?.labels) ? pressure.labels : [];
        const labels = submitLabels.length ? submitLabels : pressureLabels;
        const utilRaw = Array.isArray(pressure?.running_share)
            ? pressure.running_share.map(v => Number(v || 0) * 100.0)
            : [];
        const utilPct = this._resampleLinear(utilRaw, labels.length, 0);
        this.charts[id] = new Chart(ctx, {
            type: "line",
            data: {
                labels,
                datasets: [
                    {
                        label: "Requested Load %",
                        data: utilPct,
                        borderColor: "#22d3ee",
                        backgroundColor: "rgba(34, 211, 238, 0.18)",
                        fill: true,
                        pointRadius: 0,
                        borderWidth: 1.8,
                        tension: 0.2,
                    },
                ],
            },
            options: {
                ...App.chartDefaults(),
                scales: {
                    x: {
                        ticks: { color: "#8fb2c8", maxTicksLimit: 12 },
                        grid: { color: "#1e394f" },
                    },
                    y: {
                        beginAtZero: true,
                        ticks: { color: "#89e7c4", callback: v => `${v}%` },
                        grid: { color: "#1e394f" },
                        title: { display: true, text: "Requested Load", color: "#89e7c4" },
                    },
                },
            },
        });
        App.enableLineChartZoom(this.charts[id], { xScaleId: "x", minWindow: 8, zoomFactor: 0.55 });
    },

    renderRuntimeDistChart(hist) {
        const id = "chart-worklog-runtime-dist";
        const ctx = document.getElementById(id);
        if (!ctx) return;
        this.destroyChart(id);

        this.charts[id] = new Chart(ctx, {
            type: "bar",
            data: {
                labels: hist.labels || [],
                datasets: [{
                    label: "Jobs",
                    data: hist.counts || [],
                    backgroundColor: "rgba(56, 189, 248, 0.35)",
                    borderColor: "#38bdf8",
                    borderWidth: 1,
                }],
            },
            options: {
                ...App.chartDefaults(),
                scales: {
                    x: {
                        ticks: { color: "#8fb2c8", maxRotation: 40, minRotation: 25, autoSkip: true },
                        grid: { color: "#1e394f" },
                    },
                    y: {
                        ticks: { color: "#8fb2c8" },
                        grid: { color: "#1e394f" },
                    },
                },
            },
        });
    },

    renderProcDistChart(hist) {
        const id = "chart-worklog-procs-dist";
        const ctx = document.getElementById(id);
        if (!ctx) return;
        this.destroyChart(id);

        this.charts[id] = new Chart(ctx, {
            type: "bar",
            data: {
                labels: hist.labels || [],
                datasets: [{
                    label: "Jobs",
                    data: hist.counts || [],
                    backgroundColor: "rgba(52, 211, 153, 0.35)",
                    borderColor: "#34d399",
                    borderWidth: 1,
                }],
            },
            options: {
                ...App.chartDefaults(),
                scales: {
                    x: {
                        ticks: { color: "#8fb2c8", maxRotation: 40, minRotation: 25, autoSkip: true },
                        grid: { color: "#1e394f" },
                    },
                    y: {
                        ticks: { color: "#8fb2c8" },
                        grid: { color: "#1e394f" },
                    },
                },
            },
        });
    },

    renderReqVsRunScatter(scatter) {
        const id = "chart-worklog-scatter";
        const ctx = document.getElementById(id);
        if (!ctx) return;
        this.destroyChart(id);

        const req = scatter.req_time || [];
        const run = scatter.run || [];
        const points = req.map((x, i) => ({ x, y: run[i] || 0 }));
        const maxX = this._safeMax(req, 1);
        const maxY = this._safeMax(run, 1);
        const maxAxis = Math.max(maxX, maxY);

        this.charts[id] = new Chart(ctx, {
            type: "scatter",
            data: {
                datasets: [
                    {
                        label: "Sampled Jobs",
                        data: points,
                        backgroundColor: "rgba(249, 115, 22, 0.40)",
                        borderColor: "#f97316",
                        pointRadius: 2,
                    },
                    {
                        label: "y = x (exact request)",
                        type: "line",
                        data: [{ x: 0, y: 0 }, { x: maxAxis, y: maxAxis }],
                        borderColor: "#93c5fd",
                        borderWidth: 1.2,
                        pointRadius: 0,
                        fill: false,
                    },
                ],
            },
            options: {
                ...App.chartDefaults(),
                scales: {
                    x: {
                        title: { display: true, text: "Requested Time (s)", color: "#9ebcd0" },
                        ticks: { color: "#8fb2c8" },
                        grid: { color: "#1e394f" },
                    },
                    y: {
                        title: { display: true, text: "Actual Runtime (s)", color: "#9ebcd0" },
                        ticks: { color: "#8fb2c8" },
                        grid: { color: "#1e394f" },
                    },
                },
            },
        });
    },

    renderPressureChart(submitTimeline, pressure) {
        const id = "chart-worklog-pressure";
        const ctx = document.getElementById(id);
        if (!ctx) return;
        this.destroyChart(id);

        const submitLabels = Array.isArray(submitTimeline?.labels) ? submitTimeline.labels : [];
        const pressureLabels = Array.isArray(pressure?.labels) ? pressure.labels : [];
        const labels = submitLabels.length ? submitLabels : pressureLabels;
        const qDepth = this._resampleLinear(pressure?.queue_depth || [], labels.length, 0);
        const qProcs = this._resampleLinear(pressure?.queue_procs || [], labels.length, 0);
        const runningShare = this._resampleLinear(
            Array.isArray(pressure?.running_share) ? pressure.running_share.map(v => Number(v || 0) * 100.0) : [],
            labels.length,
            0
        );

        this.charts[id] = new Chart(ctx, {
            type: "line",
            data: {
                labels,
                datasets: [
                    {
                        label: "Queue Depth",
                        data: qDepth,
                        borderColor: "#f59e0b",
                        backgroundColor: "rgba(245, 158, 11, 0.18)",
                        fill: false,
                        pointRadius: 0,
                        borderWidth: 1.6,
                        tension: 0.2,
                        yAxisID: "y",
                    },
                    {
                        label: "Queue Size (procs)",
                        data: qProcs,
                        borderColor: "#38bdf8",
                        backgroundColor: "rgba(56, 189, 248, 0.20)",
                        fill: false,
                        pointRadius: 0,
                        borderWidth: 1.4,
                        tension: 0.2,
                        yAxisID: "y1",
                    },
                    {
                        label: "Running Share",
                        data: runningShare,
                        borderColor: "#34d399",
                        backgroundColor: "rgba(52, 211, 153, 0.16)",
                        fill: false,
                        pointRadius: 0,
                        borderWidth: 1.2,
                        tension: 0.2,
                        yAxisID: "y2",
                    },
                ],
            },
            options: {
                ...App.chartDefaults(),
                scales: {
                    x: {
                        ticks: { color: "#8fb2c8", maxTicksLimit: 12 },
                        grid: { color: "#1e394f" },
                    },
                    y: {
                        position: "left",
                        ticks: { color: "#f8c67b" },
                        grid: { color: "#1e394f" },
                        title: { display: true, text: "Queue Depth", color: "#f8c67b" },
                    },
                    y1: {
                        position: "right",
                        ticks: { color: "#8dd5f2" },
                        grid: { drawOnChartArea: false },
                        title: { display: true, text: "Queue Procs", color: "#8dd5f2" },
                    },
                    y2: {
                        position: "right",
                        offset: true,
                        ticks: { color: "#89e7c4", callback: v => `${v}%` },
                        grid: { drawOnChartArea: false },
                        title: { display: true, text: "Running Share", color: "#89e7c4" },
                    },
                },
            },
        });
        App.enableLineChartZoom(this.charts[id], { xScaleId: "x", minWindow: 8, zoomFactor: 0.55 });
    },

    renderRuntimeClassWaitChart(profile) {
        const id = "chart-worklog-runtime-class-wait";
        const ctx = document.getElementById(id);
        if (!ctx) return;
        this.destroyChart(id);

        this.charts[id] = new Chart(ctx, {
            type: "bar",
            data: {
                labels: profile.labels || [],
                datasets: [
                    {
                        type: "bar",
                        label: "Job Count",
                        data: profile.counts || [],
                        backgroundColor: "rgba(45, 212, 191, 0.30)",
                        borderColor: "#2dd4bf",
                        borderWidth: 1,
                        yAxisID: "y",
                    },
                    {
                        type: "line",
                        label: "Avg Wait",
                        data: profile.avg_wait || [],
                        borderColor: "#f59e0b",
                        backgroundColor: "#f59e0b22",
                        fill: false,
                        pointRadius: 2,
                        borderWidth: 1.6,
                        tension: 0.2,
                        yAxisID: "y1",
                    },
                    {
                        type: "line",
                        label: "p95 Wait",
                        data: profile.p95_wait || [],
                        borderColor: "#fb7185",
                        backgroundColor: "#fb718522",
                        fill: false,
                        pointRadius: 2,
                        borderWidth: 1.4,
                        borderDash: [5, 4],
                        tension: 0.2,
                        yAxisID: "y1",
                    },
                ],
            },
            options: {
                ...App.chartDefaults(),
                scales: {
                    x: {
                        ticks: { color: "#8fb2c8" },
                        grid: { color: "#1e394f" },
                    },
                    y: {
                        position: "left",
                        ticks: { color: "#89e7c4" },
                        grid: { color: "#1e394f" },
                        title: { display: true, text: "Job Count", color: "#89e7c4" },
                    },
                    y1: {
                        position: "right",
                        ticks: { color: "#f9b56f", callback: v => App.formatTime(v) },
                        grid: { drawOnChartArea: false },
                        title: { display: true, text: "Wait Time", color: "#f9b56f" },
                    },
                },
            },
        });
    },

    _setupCanvas(id, fallbackHeight = 290) {
        const canvas = document.getElementById(id);
        if (!canvas) return null;
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth || canvas.width || 300;
        const h = canvas.clientHeight || fallbackHeight;
        canvas.width = Math.max(1, Math.floor(w * dpr));
        canvas.height = Math.max(1, Math.floor(h * dpr));
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        return { canvas, ctx, w, h };
    },

    _unbindHeatmapHover(key = null) {
        const states = this._heatmapHoverStates || {};
        const ids = key ? [String(key)] : Object.keys(states);
        for (const id of ids) {
            const st = states[id];
            if (st?.canvas && st?.onMove) {
                st.canvas.removeEventListener("mousemove", st.onMove);
                st.canvas.removeEventListener("mouseleave", st.onLeave);
            }
            if (st?.tipEl) st.tipEl.style.display = "none";
            delete states[id];
        }
        if (!key) this._heatmapHoverStates = {};
    },

    _ensureHeatmapTooltip(canvas, key) {
        const container = canvas?.closest(".chart-box");
        if (!container) return null;
        const tipKey = String(key || canvas?.id || "heatmap");
        let tip = container.querySelector(`.worklog-heatmap-tooltip[data-heatmap-tooltip="${tipKey}"]`);
        if (!tip) {
            tip = document.createElement("div");
            tip.className = "worklog-heatmap-tooltip";
            tip.dataset.heatmapTooltip = tipKey;
            tip.style.display = "none";
            container.appendChild(tip);
        }
        return tip;
    },

    _bindHeatmapHover(meta) {
        const id = String(meta?.id || meta?.canvas?.id || "heatmap");
        this._unbindHeatmapHover(id);
        const canvas = meta?.canvas;
        if (!canvas) return;

        const tip = this._ensureHeatmapTooltip(canvas, id);
        if (!tip) return;

        const onLeave = () => {
            tip.style.display = "none";
        };

        const onMove = evt => {
            const rect = canvas.getBoundingClientRect();
            const x = evt.clientX - rect.left;
            const y = evt.clientY - rect.top;

            const { left, top, pw, ph, cw, ch, rows, cols, heatmap, container, tooltipHtml } = meta;
            if (x < left || x > left + pw || y < top || y > top + ph) {
                tip.style.display = "none";
                return;
            }

            const c = Math.floor((x - left) / cw);
            const r = Math.floor((y - top) / ch);
            if (r < 0 || r >= rows || c < 0 || c >= cols) {
                tip.style.display = "none";
                return;
            }

            const count = Number(heatmap.counts?.[r]?.[c] || 0);
            if (count <= 0) {
                tip.style.display = "none";
                return;
            }

            const avgWait = Number(heatmap.avg_wait?.[r]?.[c] || 0);
            const total = Math.max(1, Number(heatmap.total_jobs || 0));
            const share = (count / total) * 100.0;
            const yLabel = String(heatmap.y_labels?.[r] || "-");
            const xLabel = String(heatmap.x_labels?.[c] || "-");

            tip.innerHTML = typeof tooltipHtml === "function"
                ? tooltipHtml({ r, c, count, avgWait, total, share, xLabel, yLabel })
                : (
                    `<div><b>Req Procs:</b> ${yLabel}</div>` +
                    `<div><b>Bucket:</b> ${xLabel}</div>` +
                    `<div><b>Jobs:</b> ${count.toLocaleString()} (${share.toFixed(2)}%)</div>` +
                    `<div><b>Avg Wait:</b> ${App.formatTime(avgWait)}</div>`
                );
            tip.style.display = "block";

            const cRect = container.getBoundingClientRect();
            const tw = tip.offsetWidth || 180;
            const th = tip.offsetHeight || 84;
            let tx = x + 14;
            let ty = y + 14;
            if (tx + tw > cRect.width - 8) tx = x - tw - 14;
            if (ty + th > cRect.height - 8) ty = y - th - 14;
            tip.style.left = `${Math.max(8, tx)}px`;
            tip.style.top = `${Math.max(8, ty)}px`;
        };

        canvas.addEventListener("mousemove", onMove);
        canvas.addEventListener("mouseleave", onLeave);
        this._heatmapHoverStates[id] = { canvas, onMove, onLeave, tipEl: tip };
    },

    _heatColorDensity(intensity) {
        const t = Math.max(0, Math.min(1, intensity));
        if (App.isExportLight()) {
            const hue = 208 - 184 * t;
            const sat = 60 + 26 * t;
            const light = 97 - 46 * Math.pow(t, 0.72);
            return `hsl(${hue.toFixed(1)}deg ${sat.toFixed(1)}% ${light.toFixed(1)}%)`;
        }
        const hue = 200 - 170 * t;
        const sat = 78 + 16 * t;
        const light = 14 + 46 * Math.sqrt(t);
        return `hsl(${hue.toFixed(1)}deg ${sat.toFixed(1)}% ${light.toFixed(1)}%)`;
    },

    _heatColorWait(intensity) {
        const t = Math.max(0, Math.min(1, intensity));
        if (App.isExportLight()) {
            const hue = 205 - 195 * t;
            const sat = 64 + 24 * t;
            const light = 97 - 48 * Math.pow(t, 0.74);
            return `hsl(${hue.toFixed(1)}deg ${sat.toFixed(1)}% ${light.toFixed(1)}%)`;
        }
        const hue = 192 - 182 * t;
        const sat = 72 + 18 * t;
        const light = 18 + 42 * Math.pow(t, 0.72);
        return `hsl(${hue.toFixed(1)}deg ${sat.toFixed(1)}% ${light.toFixed(1)}%)`;
    },

    _renderMatrixHeatmap(spec) {
        const noteEl = document.getElementById(spec.noteId);
        this._unbindHeatmapHover(spec.hoverId || spec.canvasId);
        const plot = this._setupCanvas(spec.canvasId, spec.height || 290);
        if (!plot) return;

        const { ctx, w, h } = plot;
        const heatmap = spec.heatmap || {};
        const theme = App.chartTheme();
        if (!heatmap?.counts?.length || !heatmap?.x_labels?.length || !heatmap?.y_labels?.length) {
            if (noteEl) noteEl.textContent = spec.emptyText || "No heatmap data available.";
            return;
        }

        const rows = heatmap.y_labels.length;
        const cols = heatmap.x_labels.length;
        const maxAvgWait = Math.max(1, Number(heatmap.max_avg_wait) || 1);
        const maxCount = Math.max(1, Number(heatmap.max_count) || 1);

        const left = 90;
        const right = 24;
        const top = 16;
        const bottom = 128;
        const pw = w - left - right;
        const ph = h - top - bottom;
        if (pw <= 30 || ph <= 30) return;

        const cw = pw / cols;
        const ch = ph / rows;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const count = heatmap.counts[r]?.[c] || 0;
                const avgWait = heatmap.avg_wait[r]?.[c] || 0;
                const baseIntensity = spec.colorMode === "avg_wait"
                    ? (count > 0 ? (avgWait / maxAvgWait) : 0)
                    : (count > 0 ? (count / maxCount) : 0);
                const intensity = Math.sqrt(Math.max(0, Math.min(1, baseIntensity)));
                const x = left + c * cw;
                const y = top + r * ch;
                ctx.fillStyle = count > 0
                    ? (spec.colorMode === "avg_wait" ? this._heatColorWait(intensity) : this._heatColorDensity(intensity))
                    : theme.canvasEmpty;
                ctx.fillRect(x + 1, y + 1, Math.max(1, cw - 2), Math.max(1, ch - 2));

                if (count > 0 && cw >= 32 && ch >= 19) {
                    ctx.fillStyle = intensity > (App.isExportLight() ? 0.72 : 0.58)
                        ? theme.canvasLabelLight
                        : theme.canvasLabelDark;
                    ctx.font = "11px IBM Plex Mono";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    const cellLabel = typeof spec.cellLabel === "function"
                        ? spec.cellLabel({ count, avgWait, r, c, xLabel: heatmap.x_labels[c], yLabel: heatmap.y_labels[r] })
                        : String(count);
                    ctx.fillText(String(cellLabel), x + cw * 0.5, y + ch * 0.54);
                }
            }
        }

        ctx.strokeStyle = theme.canvasBorder;
        ctx.lineWidth = 1;
        for (let r = 0; r <= rows; r++) {
            const y = top + r * ch;
            ctx.beginPath();
            ctx.moveTo(left, y);
            ctx.lineTo(left + pw, y);
            ctx.stroke();
        }
        for (let c = 0; c <= cols; c++) {
            const x = left + c * cw;
            ctx.beginPath();
            ctx.moveTo(x, top);
            ctx.lineTo(x, top + ph);
            ctx.stroke();
        }

        ctx.fillStyle = theme.canvasMuted;
        ctx.font = "11px Space Grotesk";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        for (let r = 0; r < rows; r++) {
            const y = top + (r + 0.5) * ch;
            ctx.fillText(heatmap.y_labels[r], left - 6, y);
        }

        const tickBudget = Math.max(4, Math.floor(pw / 82));
        const xStep = Math.max(1, Math.ceil(cols / tickBudget));
        ctx.fillStyle = theme.canvasMuted;
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        for (let c = 0; c < cols; c++) {
            if (c % xStep !== 0 && c !== cols - 1) continue;
            const x = left + (c + 0.5) * cw;
            const y = top + ph + 22;
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(-0.52);
            ctx.fillText(this._shortHeatLabel(heatmap.x_labels[c]), 0, 0);
            ctx.restore();
        }

        const lgW = pw;
        const lgH = 8;
        const lgX = left;
        const lgY = h - 24;
        const lg = ctx.createLinearGradient(lgX, 0, lgX + lgW, 0);
        const colorFn = spec.colorMode === "avg_wait"
            ? (v => this._heatColorWait(v))
            : (v => this._heatColorDensity(v));
        lg.addColorStop(0, colorFn(0));
        lg.addColorStop(0.5, colorFn(0.5));
        lg.addColorStop(1, colorFn(1));
        ctx.fillStyle = lg;
        ctx.fillRect(lgX, lgY, lgW, lgH);
        ctx.strokeStyle = theme.canvasBorder;
        ctx.strokeRect(lgX, lgY, lgW, lgH);
        ctx.fillStyle = theme.canvasText;
        ctx.font = "10px Space Grotesk";
        ctx.textAlign = "left";
        ctx.fillText(spec.legendMinLabel || "low", lgX, lgY - 2);
        ctx.textAlign = "right";
        ctx.fillText(spec.legendMaxLabel || "high", lgX + lgW, lgY - 2);

        ctx.fillStyle = theme.canvasText;
        ctx.font = "11px Space Grotesk";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(spec.xAxisLabel || "X Axis", left + (pw * 0.5), top + ph + 70);
        ctx.save();
        ctx.translate(18, top + ph * 0.5);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(spec.yAxisLabel || "Y Axis", 0, 0);
        ctx.restore();

        if (noteEl) {
            noteEl.textContent = typeof spec.noteText === "function"
                ? spec.noteText({ heatmap, maxCount, maxAvgWait })
                : (spec.noteText || "");
        }

        this._bindHeatmapHover({
            id: spec.hoverId || spec.canvasId,
            canvas: plot.canvas,
            container: plot.canvas.closest(".chart-box"),
            left,
            top,
            pw,
            ph,
            cw,
            ch,
            rows,
            cols,
            heatmap,
            tooltipHtml: spec.tooltipHtml,
        });
    },

    renderProcRuntimeWaitHeatmap(heatmap) {
        this._renderMatrixHeatmap({
            canvasId: "chart-worklog-proc-runtime-heatmap",
            noteId: "worklog-proc-runtime-heatmap-note",
            hoverId: "proc-runtime",
            heatmap,
            height: 310,
            emptyText: "No processor x runtime wait heatmap data available.",
            colorMode: "avg_wait",
            xAxisLabel: "Actual Runtime",
            yAxisLabel: "Requested Procs",
            legendMinLabel: "low avg wait",
            legendMaxLabel: "high avg wait",
            cellLabel: ({ count }) => count,
            noteText: ({ maxCount, maxAvgWait }) =>
                `Cell color = average wait for jobs in each (requested-procs, runtime) bucket. ` +
                `Cell text = jobs. Hover for the exact bucket stats. Max cell count: ${maxCount}. ` +
                `Max average wait: ${App.formatTime(maxAvgWait)}.`,
            tooltipHtml: ({ xLabel, yLabel, count, share, avgWait }) =>
                `<div><b>Requested Procs:</b> ${yLabel}</div>` +
                `<div><b>Actual Runtime:</b> ${xLabel}</div>` +
                `<div><b>Jobs:</b> ${count.toLocaleString()} (${share.toFixed(2)}%)</div>` +
                `<div><b>Avg Wait:</b> ${App.formatTime(avgWait)}</div>`,
        });
    },

    renderWaitHeatmap(heatmap) {
        this._renderMatrixHeatmap({
            canvasId: "chart-worklog-heatmap",
            noteId: "worklog-heatmap-note",
            hoverId: "wait-bucket",
            heatmap,
            height: 290,
            emptyText: "No wait heatmap data available.",
            colorMode: "count",
            xAxisLabel: "Wait Time Bucket",
            yAxisLabel: "Requested Procs",
            legendMinLabel: "low density",
            legendMaxLabel: "high density",
            cellLabel: ({ count }) => count,
            noteText: ({ maxCount, maxAvgWait }) =>
                `Cell color = job-count density by (requested-procs, wait-bucket). ` +
                `Cell text = jobs. Hover for average wait. Max cell count: ${maxCount}. ` +
                `Max average wait: ${App.formatTime(maxAvgWait)}.`,
            tooltipHtml: ({ xLabel, yLabel, count, share, avgWait }) =>
                `<div><b>Requested Procs:</b> ${yLabel}</div>` +
                `<div><b>Wait Bucket:</b> ${xLabel}</div>` +
                `<div><b>Jobs:</b> ${count.toLocaleString()} (${share.toFixed(2)}%)</div>` +
                `<div><b>Avg Wait:</b> ${App.formatTime(avgWait)}</div>`,
        });
    },

    renderTopUsers(rows) {
        const tbody = document.querySelector("#worklog-users-table tbody");
        if (!tbody) return;
        if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="6">No user statistics found.</td></tr>';
            return;
        }

        const hasMissingMaxWait = rows.some(r => r && r.max_wait === undefined);
        tbody.innerHTML = rows.map(r => `
            <tr>
                <td>${r.user}</td>
                <td>${(r.jobs || 0).toLocaleString()}</td>
                <td>${App.formatTime(r.avg_wait || 0)}</td>
                <td>${(r && r.max_wait !== undefined) ? App.formatTime(r.max_wait || 0) : "-"}</td>
                <td>${App.formatTime(r.avg_runtime || 0)}</td>
                <td>${App.formatNum(r.avg_req_procs || 0)}</td>
            </tr>
        `).join("");

        if (hasMissingMaxWait && !this._analysisFallbackFlags.includes("top-users-max-wait")) {
            this._analysisFallbackFlags.push("top-users-max-wait");
        }
    },

    renderCongestionWindows(rows) {
        const tbody = document.querySelector("#worklog-congestion-table tbody");
        if (!tbody) return;
        if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="5">No congestion windows found.</td></tr>';
            return;
        }

        tbody.innerHTML = rows.map(r => `
            <tr>
                <td>${r.rank ?? ""}</td>
                <td>${r.time || App.formatTime(r.t_seconds || 0)}</td>
                <td>${(r.queue_depth || 0).toLocaleString()}</td>
                <td>${App.formatNum(r.queue_procs || 0)}</td>
                <td>${((r.running_share || 0) * 100).toFixed(1)}%</td>
            </tr>
        `).join("");
    },

    destroyChart(id) {
        if (this.charts[id]) {
            this.charts[id].destroy();
            delete this.charts[id];
        }
    },

    clearAnalysis() {
        this._analysisFallbackFlags = [];
        this._lastAnalysisPayload = null;
        this._unbindHeatmapHover();
        const summary = document.getElementById("worklog-summary");
        if (summary) summary.innerHTML = "";
        this.setMeta("");
        this.renderTopUsers([]);
        this.renderCongestionWindows([]);
        const note = document.getElementById("worklog-heatmap-note");
        if (note) note.textContent = "";
        const note2 = document.getElementById("worklog-proc-runtime-heatmap-note");
        if (note2) note2.textContent = "";

        const heatCanvas = document.getElementById("chart-worklog-heatmap");
        if (heatCanvas) {
            const ctx = heatCanvas.getContext("2d");
            if (ctx) ctx.clearRect(0, 0, heatCanvas.width, heatCanvas.height);
        }
        const heatCanvas2 = document.getElementById("chart-worklog-proc-runtime-heatmap");
        if (heatCanvas2) {
            const ctx = heatCanvas2.getContext("2d");
            if (ctx) ctx.clearRect(0, 0, heatCanvas2.width, heatCanvas2.height);
        }

        this.destroyChart("chart-worklog-arrival");
        this.destroyChart("chart-worklog-util-makespan");
        this.destroyChart("chart-worklog-runtime-dist");
        this.destroyChart("chart-worklog-procs-dist");
        this.destroyChart("chart-worklog-scatter");
        this.destroyChart("chart-worklog-pressure");
        this.destroyChart("chart-worklog-runtime-class-wait");
    },

    rerenderCachedAnalysis() {
        const payload = this._lastAnalysisPayload;
        if (!payload) return;
        this.renderSummary(payload);
        this.renderCharts(payload);
        this.renderTopUsers(payload.top_users || []);
        this.renderCongestionWindows(payload.congestion_windows || []);
    },
};
