/* system.js - Per-system tab with explicit run selection */

const System = {
    charts: {},
    data: [],
    _bound: false,
    _runPage: 1,

    init(data) {
        this.data = (data || []).map(d => App.normalizeSummaryEntry(d));
        this.populateSystems();
        this.bind();
        this.load();
    },

    _esc(s) {
        return String(s ?? "")
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

    _runSearchQuery() {
        const el = document.getElementById("system-run-search");
        return String(el?.value || "").trim().toLowerCase();
    },

    _allSystemRuns(system) {
        return this.data
            .filter(d => d.system === system)
            .sort((a, b) => App.runLabel(a).localeCompare(App.runLabel(b)));
    },

    populateSystems() {
        const sel = document.getElementById("system-select");
        const prev = sel.value;
        const systems = [...new Set(this.data.map(d => d.system))].filter(Boolean).sort();
        sel.innerHTML = systems.map(s => `<option value="${s}">${s}</option>`).join("");
        if (systems.length) {
            sel.value = systems.includes(prev) ? prev : systems[0];
        }

        this.populateRuns();
    },

    populateRuns() {
        const system = document.getElementById("system-select").value;
        const runSel = document.getElementById("system-run-select");
        const pageSel = document.getElementById("system-run-page");
        const pageSizeSel = document.getElementById("system-run-page-size");
        const countEl = document.getElementById("system-run-count");
        const prevRun = runSel.value;

        const allRows = this._allSystemRuns(system);
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
            runSel.value = "";
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

    bind() {
        if (this._bound) return;
        this._bound = true;

        const refreshRuns = ({ resetPage = false } = {}) => {
            const runSel = document.getElementById("system-run-select");
            const prev = runSel ? runSel.value : "";
            if (resetPage) this._runPage = 1;
            this.populateRuns();
            const next = runSel ? runSel.value : "";
            if (next !== prev) this.load();
        };

        document.getElementById("system-select").addEventListener("change", () => {
            refreshRuns({ resetPage: true });
        });

        document.getElementById("system-run-select").addEventListener("change", () => this.load());
        document.getElementById("system-run-search").addEventListener("input", () => {
            refreshRuns({ resetPage: true });
        });
        document.getElementById("system-run-page-size").addEventListener("change", () => {
            refreshRuns({ resetPage: true });
        });
        document.getElementById("system-run-page").addEventListener("change", () => {
            refreshRuns();
        });
    },

    async load() {
        const runKey = document.getElementById("system-run-select").value;
        const run = this.data.find(d => App.runKey(d) === runKey) || null;
        const info = document.getElementById("system-info");

        if (run) {
            info.innerHTML = `
                <div class="card"><div class="label">Run</div><div class="value" style="font-size:1rem">${App.runBaseLabel(run)}</div></div>
                <div class="card"><div class="label">Jobs</div><div class="value">${(run.total_jobs || 0).toLocaleString()}</div></div>
                <div class="card"><div class="label">Avg Wait</div><div class="value">${App.formatTime(run.avg_wait || 0)}</div></div>
                <div class="card"><div class="label">Wait p95</div><div class="value">${App.formatTime(run.wait_p95 || 0)}</div></div>
                <div class="card"><div class="label">Avg Util</div><div class="value">${((run.avg_utilization || 0) * 100).toFixed(1)}%</div></div>
                <div class="card"><div class="label">Peak Queue</div><div class="value">${(run.peak_queue_depth || 0).toLocaleString()}</div></div>
                <div class="card"><div class="label">Makespan</div><div class="value">${App.formatTime(run.makespan || 0)}</div></div>
            `;
        } else {
            info.innerHTML = '<p style="color:#94a3b8;">No data for this selection.</p>';
        }

        const ts = await App.loadTimeseries(runKey);
        if (ts) {
            if ((ts.time || []).length) {
                this.renderUtilization(ts);
                this.renderQueueDepth(ts);
            } else {
                this.clearChart("chart-uti-ts");
                this.clearChart("chart-qd-ts");
            }

            if (ts.wait_timeline?.avg?.length) {
                this.renderAvgWaitOverMakespan(ts);
            } else {
                this.clearChart("chart-scatter-run");
            }
        } else {
            this.clearChart("chart-uti-ts");
            this.clearChart("chart-qd-ts");
            this.clearChart("chart-scatter-run");
        }

        const scatter = await App.loadScatter(runKey);
        if (scatter) {
            this.renderScatterWait(scatter);
        } else {
            this.clearChart("chart-scatter-wait");
        }

        this.renderTable(run);
    },

    renderTable(run) {
        const tbody = document.querySelector("#system-table tbody");
        if (!tbody) return;
        if (!run) {
            tbody.innerHTML = "";
            return;
        }

        tbody.innerHTML = METRIC_DEFS.map(def => {
            const val = def.fmt(run[def.key]);
            return `<tr>
                <td>${def.label}</td>
                <td class="metric-val">${val}</td>
                <td class="metric-desc">${def.desc}</td>
            </tr>`;
        }).join("");
    },

    renderUtilization(ts) {
        const ctx = document.getElementById("chart-uti-ts");
        if (this.charts["chart-uti-ts"]) this.charts["chart-uti-ts"].destroy();

        const labels = (ts.time || []).map(t => App.formatTime(t));
        this.charts["chart-uti-ts"] = new Chart(ctx, {
            type: "line",
            data: {
                labels,
                datasets: [{
                    label: "Utilization",
                    data: (ts.utilization || []).map(v => v * 100),
                    borderColor: "#2dd4bf",
                    backgroundColor: "#2dd4bf2c",
                    fill: true,
                    pointRadius: 0,
                    borderWidth: 1.4,
                    tension: 0.18,
                }],
            },
            options: {
                ...App.chartDefaults(),
                scales: {
                    x: {
                        ticks: { color: "#8fb2c8", font: { size: 9 }, maxTicksLimit: 10 },
                        grid: { color: "#1e394f" },
                    },
                    y: {
                        min: 0,
                        max: 100,
                        ticks: { color: "#8fb2c8", callback: v => `${v}%` },
                        grid: { color: "#1e394f" },
                    },
                },
            },
        });
        App.enableLineChartZoom(this.charts["chart-uti-ts"], { xScaleId: "x", minWindow: 20, zoomFactor: 0.55 });
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

    renderQueueDepth(ts) {
        const ctx = document.getElementById("chart-qd-ts");
        if (this.charts["chart-qd-ts"]) this.charts["chart-qd-ts"].destroy();

        const labels = (ts.time || []).map(t => App.formatTime(t));
        const datasets = [
            {
                label: "Queue Depth",
                data: ts.queue_depth || [],
                borderColor: "#f59e0b",
                backgroundColor: "#f59e0b2a",
                fill: true,
                pointRadius: 0,
                borderWidth: 1.4,
                tension: 0.18,
                yAxisID: "y",
            },
        ];

        if (ts.queue_size?.length) {
            datasets.push({
                label: "Queue Size (procs)",
                data: ts.queue_size,
                borderColor: "#38bdf8",
                backgroundColor: "transparent",
                fill: false,
                pointRadius: 0,
                borderWidth: 1.3,
                tension: 0.18,
                yAxisID: "y1",
            });
        }

        this.charts["chart-qd-ts"] = new Chart(ctx, {
            type: "line",
            data: { labels, datasets },
            options: {
                ...App.chartDefaults(),
                scales: {
                    x: {
                        ticks: { color: "#8fb2c8", font: { size: 9 }, maxTicksLimit: 10 },
                        grid: { color: "#1e394f" },
                    },
                    y: {
                        position: "left",
                        ticks: { color: "#f7c175" },
                        grid: { color: "#1e394f" },
                        title: { display: true, text: "Jobs", color: "#f7c175" },
                    },
                    y1: {
                        position: "right",
                        ticks: { color: "#99d9ff" },
                        grid: { drawOnChartArea: false },
                        title: { display: true, text: "Procs", color: "#99d9ff" },
                    },
                },
            },
        });
        App.enableLineChartZoom(this.charts["chart-qd-ts"], { xScaleId: "x", minWindow: 20, zoomFactor: 0.55 });
    },

    renderScatterWait(scatter) {
        const ctx = document.getElementById("chart-scatter-wait");
        if (this.charts["chart-scatter-wait"]) this.charts["chart-scatter-wait"].destroy();

        const points = (scatter.reqProc || []).map((p, i) => ({ x: p, y: scatter.wait?.[i] || 0 }));
        this.charts["chart-scatter-wait"] = new Chart(ctx, {
            type: "scatter",
            data: {
                datasets: [{
                    label: "Wait vs Procs",
                    data: points,
                    backgroundColor: "#2dd4bf66",
                    borderColor: "#2dd4bf",
                    pointRadius: 2,
                }],
            },
            options: {
                ...App.chartDefaults(),
                scales: {
                    x: {
                        title: { display: true, text: "Requested Processors", color: "#9ebcd0" },
                        ticks: { color: "#8fb2c8" },
                        grid: { color: "#1e394f" },
                    },
                    y: {
                        title: { display: true, text: "Wait Time (s)", color: "#9ebcd0" },
                        ticks: { color: "#8fb2c8" },
                        grid: { color: "#1e394f" },
                    },
                },
            },
        });
    },

    renderAvgWaitOverMakespan(ts) {
        const ctx = document.getElementById("chart-scatter-run");
        if (this.charts["chart-scatter-run"]) this.charts["chart-scatter-run"].destroy();
        if (!ctx) return;

        const waitTimeline = ts?.wait_timeline || {};
        const utilLabels = (ts?.time || []).map(t => App.formatTime(t));
        const timelineLabels = Array.isArray(waitTimeline?.labels) ? waitTimeline.labels : [];
        const labels = utilLabels.length ? utilLabels : timelineLabels;
        const avgWaitRaw = Array.isArray(waitTimeline?.avg) ? waitTimeline.avg : [];
        const avgWait = labels.length
            ? this._resampleLinear(avgWaitRaw, labels.length, 0)
            : avgWaitRaw;
        const finalLabels = labels.length ? labels : avgWait.map((_, i) => `${i + 1}`);
        this.charts["chart-scatter-run"] = new Chart(ctx, {
            type: "line",
            data: {
                datasets: [{
                    label: "Avg Wait",
                    data: avgWait,
                    borderColor: "#f97316",
                    backgroundColor: "#f9731626",
                    pointRadius: 0,
                    borderWidth: 1.6,
                    tension: 0.22,
                    fill: true,
                }],
                labels: finalLabels,
            },
            options: {
                ...App.chartDefaults(),
                scales: {
                    x: {
                        title: { display: true, text: "Submit-Time Offset", color: "#9ebcd0" },
                        ticks: { color: "#8fb2c8" },
                        grid: { color: "#1e394f" },
                    },
                    y: {
                        title: { display: true, text: "Avg Wait Time", color: "#9ebcd0" },
                        ticks: { color: "#8fb2c8", callback: v => App.formatTime(v) },
                        grid: { color: "#1e394f" },
                    },
                },
                plugins: {
                    ...App.chartDefaults().plugins,
                    tooltip: {
                        callbacks: {
                            title: items => {
                                const idx = items?.[0]?.dataIndex ?? 0;
                                return `Time ${finalLabels[idx] || "-"}`;
                            },
                            label: item => ` Avg Wait: ${App.formatTime(item.raw || 0)}`,
                        },
                    },
                },
            },
        });
        App.enableLineChartZoom(this.charts["chart-scatter-run"], { xScaleId: "x", minWindow: 8, zoomFactor: 0.5 });
    },

    clearChart(id) {
        if (this.charts[id]) {
            this.charts[id].destroy();
            delete this.charts[id];
        }
    },
};
