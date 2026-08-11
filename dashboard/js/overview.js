/* overview.js - CQTwin overview tab: run picker, insights, charts, metric tables */

const Overview = {
    charts: {},
    _result: null,
    _bound: false,
    _runPage: 1,

    init(result) {
        this._result = result;
        this._bind();
        this._buildPicker({ preferResult: true });
        if (result) {
            const runName = result?.meta?.run_name || result?.summary?.run_name || "";
            if (runName && this._needsFullMetricsPayload(result)) this._switchRun(runName);
            else this._render(result);
        } else {
            const sel = document.getElementById("sel-run-picker");
            if (sel?.value) this._switchRun(sel.value);
        }
        document.getElementById("btn-pdf").onclick = () => this._exportPDF();
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
        const el = document.getElementById("overview-run-search");
        return String(el?.value || "").trim().toLowerCase();
    },

    _allRunsSorted() {
        return [...App.summaryData]
            .map(d => App.normalizeSummaryEntry(d))
            .sort((a, b) => App.runLabel(a).localeCompare(App.runLabel(b)));
    },

    _bind() {
        if (this._bound) return;
        this._bound = true;

        const sel = document.getElementById("sel-run-picker");
        sel.addEventListener("change", () => this._switchRun(sel.value));

        const onResetPage = () => {
            this._runPage = 1;
            this._buildPicker();
        };
        document.getElementById("overview-run-search").addEventListener("input", onResetPage);
        document.getElementById("overview-run-page-size").addEventListener("change", onResetPage);
        document.getElementById("overview-run-page").addEventListener("change", () => this._buildPicker());
    },

    _buildPicker({ preferResult = false } = {}) {
        const sel = document.getElementById("sel-run-picker");
        const pageSel = document.getElementById("overview-run-page");
        const pageSizeSel = document.getElementById("overview-run-page-size");
        const countEl = document.getElementById("overview-run-count");
        const prev = sel.value;

        const allRows = this._allRunsSorted();
        const q = this._runSearchQuery();
        const filteredRows = q
            ? allRows.filter(d => App.runFullLabel(d).toLowerCase().includes(q))
            : allRows;

        const pageSize = this._parsePositiveInt(pageSizeSel?.value, 50);
        const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
        let requestedPage = this._parsePositiveInt(pageSel?.value || this._runPage, 1);

        const preferred = this._result?.meta?.run_name
            || this._result?.summary?.run_name
            || prev;
        if (preferResult && preferred) {
            const prefIdx = filteredRows.findIndex(d => App.runKey(d) === preferred);
            if (prefIdx >= 0) {
                requestedPage = Math.floor(prefIdx / pageSize) + 1;
            }
        }

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
        sel.innerHTML = pageRows.map(d => {
            const key = App.runKey(d);
            const label = App.runFullLabel(d);
            return `<option value="${this._esc(key)}">${this._esc(label)}</option>`;
        }).join("");

        let chosen = "";
        if (pageRows.length) {
            const keep = pageRows.some(d => App.runKey(d) === preferred);
            chosen = keep ? preferred : App.runKey(pageRows[0]);
            sel.value = chosen;
            sel.disabled = false;
        } else {
            sel.innerHTML = '<option value="">No runs match current filter</option>';
            sel.value = "";
            sel.disabled = true;
        }

        if (countEl) {
            const shownFrom = pageRows.length ? start + 1 : 0;
            const shownTo = start + pageRows.length;
            countEl.textContent =
                `Showing ${shownFrom}-${shownTo} of ${filteredRows.length}` +
                (q ? ` filtered (${allRows.length} total)` : "");
        }

        if (chosen && chosen !== prev) this._switchRun(chosen);
    },

    async _switchRun(name) {
        const cached = this._findCachedResult(name);
        if (cached) {
            if (!this._needsFullMetricsPayload(cached)) {
                this._result = cached;
                this._render(cached);
                return;
            }
        }

        try {
            const result = await App.fetchRun(name, { lite: true });
            this._result = result;
            this._render(result);
        } catch {
            // Ignore transient load errors
        }
    },

    _findCachedResult(name) {
        if (!App.currentResult) return null;
        const r = App.currentResult;
        const key = r?.meta?.run_name || r?.summary?.run_name;
        return key === name ? r : null;
    },

    _totalJobs(result) {
        return Number(result?.summary?.total_jobs || 0);
    },

    _scatterJobs(result) {
        return Array.isArray(result?.scatter?.wait) ? result.scatter.wait.length : 0;
    },

    _isSampledScatter(result) {
        const totalJobs = this._totalJobs(result);
        const scatterJobs = this._scatterJobs(result);
        return totalJobs > 0 && scatterJobs > 0 && scatterJobs < totalJobs;
    },

    _needsFullMetricsPayload(result) {
        if (!this._isSampledScatter(result)) return false;
        const hasWaitByRuntime = Array.isArray(result?.wait_by_runtime?.labels) && result.wait_by_runtime.labels.length > 0;
        const hasWaitBySize = Array.isArray(result?.wait_by_job_size?.labels) && result.wait_by_job_size.labels.length > 0;
        const hasRuntimeViolin = (
            Array.isArray(result?.wait_violin_by_runtime?.groups) && result.wait_violin_by_runtime.groups.length > 0
        ) || (
            Array.isArray(result?.wait_violin?.points) && result.wait_violin.points.length > 0
        );
        const hasJobHeatmap = Array.isArray(result?.jobsize_wait_heatmap?.counts) && result.jobsize_wait_heatmap.counts.length > 0;
        const hasJobSizeDist = Array.isArray(result?.job_size_distribution?.counts) && result.job_size_distribution.counts.length > 0;
        return !(hasWaitByRuntime && hasWaitBySize && hasRuntimeViolin && hasJobHeatmap && hasJobSizeDist);
    },

    _render(result) {
        const allowScatterFallback = !this._isSampledScatter(result);
        const runtimeViolin = result?.wait_violin_by_runtime
            || result?.wait_violin
            || (allowScatterFallback
                ? (this._inferRuntimeViolinFromScatter(result?.scatter) || this._inferViolinFromScatter(result?.scatter))
                : null);
        const jobHeatmap = result?.jobsize_wait_heatmap
            || (allowScatterFallback ? this._inferHeatmapFromScatter(result?.scatter) : null);
        const totalJobs = this._totalJobs(result);
        const waitByRuntime = result?.wait_by_runtime
            || (allowScatterFallback ? this._inferWaitByRuntimeFromScatter(result?.scatter, result?.runtime_distribution, totalJobs) : null);
        const waitBySize = result?.wait_by_job_size
            || (allowScatterFallback ? this._inferWaitByJobSizeFromScatter(result?.scatter, totalJobs) : null);
        const jobSizeDist = result?.job_size_distribution
            || (allowScatterFallback ? this._inferJobSizeDistFromScatter(result?.scatter) : null);

        this._safeRender("config bar", () => this._showConfigBar(result.params, result.meta));
        this._safeRender("advisory", () => this._renderAdvisory(result));
        this._safeRender("insights", () => this._renderInsights(result.insights, result.summary));
        this._safeRender("summary cards", () => this._renderCards(result.summary));
        this._safeRender("wait by runtime", () => this._renderWaitByRuntime(waitByRuntime));
        this._safeRender("wait by size", () => this._renderWaitByJobSize(waitBySize));
        this._safeRender("runtime dist", () => this._renderRuntimeDist(result.runtime_distribution));
        this._safeRender("job size dist", () => this._renderJobSizeDist(jobSizeDist));
        this._safeRender("utilization", () => this._renderUtilization(result.timeseries));
        this._safeRender("wait violin", () => this._renderWaitViolin(runtimeViolin));
        this._safeRender("jobsize heatmap", () => this._renderJobSizeWaitHeatmap(jobHeatmap));
        this._safeRender("top wait", () => this._renderTopWait(result.top_wait_jobs));
        this._safeRender("metrics table", () => this._renderTable(result.summary));
    },

    _safeRender(name, fn) {
        try {
            fn();
        } catch (err) {
            console.error(`[overview] render failed: ${name}`, err);
        }
    },

    // Online-advisory runs (run_type=online_advisory) get an extra panel: the
    // projected-avg-wait-per-policy chart + a summary table. Data comes from the
    // dedicated /api/online/advisory endpoint (deterministic downsampling); the
    // panel is hidden for ordinary offline runs.
    async _renderAdvisory(result) {
        const panel = document.getElementById("online-advisory-panel");
        if (!panel) return;
        const params = (result.meta && result.meta.params) || result.params || {};
        const runType = params.run_type || (result.meta && result.meta.run_type);
        const runName = (result.meta && result.meta.run_name)
            || (result.summary && result.summary.run_name) || "";
        if (runType !== "online_advisory") { panel.classList.add("hidden"); return; }
        panel.classList.remove("hidden");

        const csvLink = document.getElementById("advisory-csv-link");
        if (csvLink) csvLink.href = `/api/online/advisory.csv?run=${encodeURIComponent(runName)}`;

        let data = null;
        try {
            data = await fetch(`/api/online/advisory?run=${encodeURIComponent(runName)}`).then(r => r.json());
        } catch { data = null; }

        const summaryEl = document.getElementById("advisory-summary");
        if (!data || data.error || !data.series || !Object.keys(data.series).length) {
            if (summaryEl) summaryEl.innerHTML =
                `<p class="hint">Advisory data unavailable${data && data.error ? ": " + data.error : ""}.</p>`;
            return;
        }

        const committed = data.committed || params.committed_policy || "";
        const policies = data.policies || Object.keys(data.series);
        const s = result.summary || {};

        document.getElementById("online-advisory-cards").innerHTML = `
            <div class="card"><div class="label">Committed Policy</div><div class="value">${String(committed).toUpperCase()}</div></div>
            <div class="card"><div class="label">Advisory Pool</div><div class="value">${policies.length}</div></div>
            <div class="card"><div class="label">Cycles Evaluated</div><div class="value">${(data.cycles_evaluated || 0).toLocaleString()}</div></div>
            <div class="card"><div class="label">Advisory Rows</div><div class="value">${(data.rows || 0).toLocaleString()}</div></div>
            <div class="card"><div class="label">Committed Avg Wait</div><div class="value">${App.formatTime(s.avg_wait)}</div></div>
            <div class="card"><div class="label">Committed Wait p95</div><div class="value">${App.formatTime(s.wait_p95)}</div></div>
        `;

        const palette = ["#1f77b4", "#d95f02", "#2ca02c", "#9467bd", "#e7298a", "#66a61e", "#e6ab02", "#7570b3"];
        const colorFor = p => palette[Math.max(0, policies.indexOf(p)) % palette.length];
        const toHours = v => v / 3600;
        const datasets = policies.map(p => {
            const isC = p === committed;
            return {
                label: isC ? `${p} (committed)` : p,
                data: (data.series[p] || []).map(pt => ({ x: toHours(pt.t), y: toHours(pt.wait) })),
                borderColor: colorFor(p),
                backgroundColor: colorFor(p),
                borderWidth: isC ? 3 : 1.5,
                pointRadius: 0,
                tension: 0.2,
            };
        });

        const theme = App.chartTheme();
        const ctx = document.getElementById("chart-advisory");
        if (this.charts["advisory"]) this.charts["advisory"].destroy();
        this.charts["advisory"] = new Chart(ctx, {
            type: "line",
            data: { datasets },
            options: App.chartDefaults({
                aspectRatio: 2.0,
                scales: {
                    x: { type: "linear", title: { display: true, text: "Simulation time (hours)", color: theme.tick },
                         ticks: { color: theme.tick, font: { size: 10 } }, grid: { color: theme.grid } },
                    y: { beginAtZero: true, title: { display: true, text: "Projected avg wait (hours)", color: theme.tick },
                         ticks: { color: theme.tick, font: { size: 10 } }, grid: { color: theme.grid } },
                },
            }),
        });

        const sum = data.summary || {};
        const rows = policies.map(p => {
            const r = sum[p] || {};
            const isC = p === committed;
            return `<tr class="${isC ? "committed-row" : ""}">
                <td>${p}${isC ? ' <span class="online-badge">committed</span>' : ""}</td>
                <td>${((r.frac_lowest || 0) * 100).toFixed(1)}%</td>
                <td>${App.formatTime(r.mean_proj_wait || 0)}</td></tr>`;
        }).join("");
        if (summaryEl) summaryEl.innerHTML = `
            <table class="advisory-summary-table">
                <thead><tr><th>Policy</th><th>% cycles lowest</th><th>Mean proj. wait</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
            <p class="hint" style="margin-top:6px;">"% cycles lowest" = share of evaluated cycles where the
            policy projected the smallest average wait. The committed policy's line is a projection of the same
            policy that is dispatching — the self-consistent baseline the others are compared against.</p>`;
    },

    _buildViolinProfile(waits, bins = 40) {
        const clean = (waits || []).map(v => Number(v)).filter(v => Number.isFinite(v) && v >= 0);
        if (!clean.length) {
            return {
                job_count: 0,
                clip_wait: 0,
                max_wait: 0,
                tail_clipped_jobs: 0,
                quantiles: {},
                points: [],
            };
        }

        const sorted = [...clean].sort((a, b) => a - b);
        const pct = p => {
            if (!sorted.length) return 0;
            const k = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
            return sorted[k];
        };

        const clip = Math.max(1, pct(0.995) || sorted[sorted.length - 1] || 1);
        const raw = new Array(bins).fill(0);
        for (const w of clean) {
            const idx = Math.min(bins - 1, Math.floor((Math.min(w, clip) / clip) * bins));
            raw[idx] += 1;
        }

        const smooth = raw.map((_, i) => {
            const lo = Math.max(0, i - 1);
            const hi = Math.min(bins - 1, i + 1);
            let s = 0;
            for (let j = lo; j <= hi; j++) s += raw[j];
            return s / (hi - lo + 1);
        });
        const peak = Math.max(...smooth, 1);
        const points = smooth.map((v, i) => {
            const y0 = (i / bins) * clip;
            const y1 = ((i + 1) / bins) * clip;
            return {
                y0,
                y1,
                mid: (y0 + y1) * 0.5,
                density: v / peak,
                count: raw[i],
            };
        });

        return {
            job_count: clean.length,
            clip_wait: clip,
            max_wait: sorted[sorted.length - 1],
            tail_clipped_jobs: clean.filter(w => w > clip).length,
            quantiles: {
                q10: pct(0.10),
                q25: pct(0.25),
                q50: pct(0.50),
                q75: pct(0.75),
                q90: pct(0.90),
                q95: pct(0.95),
            },
            points,
        };
    },

    _inferViolinFromScatter(scatter) {
        const waits = Array.isArray(scatter?.wait) ? scatter.wait : [];
        return this._buildViolinProfile(waits, 40);
    },

    _inferRuntimeViolinFromScatter(scatter) {
        const waits = Array.isArray(scatter?.wait) ? scatter.wait.map(v => Number(v)) : [];
        const runs = Array.isArray(scatter?.run) ? scatter.run.map(v => Number(v)) : [];
        const n = Math.min(waits.length, runs.length);
        if (!n) return null;

        const cleanRuns = runs.filter(v => Number.isFinite(v) && v >= 0);
        if (!cleanRuns.length) return null;
        const minR = Math.min(...cleanRuns);
        const maxR = Math.max(...cleanRuns);
        const span = maxR - minR;
        const t1 = span > 0 ? (minR + span / 3) : minR;
        const t2 = span > 0 ? (minR + (2 * span / 3)) : minR;

        const small = [];
        const medium = [];
        const large = [];
        for (let i = 0; i < n; i++) {
            const w = waits[i];
            const r = runs[i];
            if (!Number.isFinite(w) || !Number.isFinite(r) || w < 0 || r < 0) continue;
            if (r < t1) small.push(w);
            else if (r < t2) medium.push(w);
            else large.push(w);
        }

        return {
            runtime_thresholds: [t1, t2],
            total_jobs: n,
            groups: [
                Object.assign({ key: "small", label: "Small Runtime", runtime_range: `<${App.formatTime(t1)}` }, this._buildViolinProfile(small, 40)),
                Object.assign({ key: "medium", label: "Medium Runtime", runtime_range: `${App.formatTime(t1)}-${App.formatTime(t2)}` }, this._buildViolinProfile(medium, 40)),
                Object.assign({ key: "large", label: "Large Runtime", runtime_range: `>${App.formatTime(t2)}` }, this._buildViolinProfile(large, 40)),
            ],
        };
    },

    _inferHeatmapFromScatter(scatter) {
        const reqProc = Array.isArray(scatter?.reqProc) ? scatter.reqProc.map(v => Number(v)) : [];
        const waits = Array.isArray(scatter?.wait) ? scatter.wait.map(v => Number(v)) : [];
        const n = Math.min(reqProc.length, waits.length);
        if (!n) return null;

        const procEdges = [1, 8, 32, 128, 512, 2048, 8192, 32768];
        const waitEdges = [0, 60, 300, 900, 1800, 3600, 14400, 43200, 86400, 259200, 604800, 2592000];
        const maxWait = Math.max(...waits.filter(v => Number.isFinite(v) && v >= 0), 0);
        if (maxWait > waitEdges[waitEdges.length - 1]) waitEdges.push(maxWait);

        const rows = procEdges.length - 1;
        const cols = waitEdges.length - 1;
        const counts = Array.from({ length: rows }, () => Array(cols).fill(0));

        const pIdx = p => {
            for (let i = 0; i < procEdges.length - 1; i++) {
                const lo = procEdges[i];
                const hi = procEdges[i + 1];
                if (i < procEdges.length - 2) {
                    if (p >= lo && p < hi) return i;
                } else if (p >= lo && p <= hi) return i;
            }
            return rows - 1;
        };
        const wIdx = w => {
            for (let i = 0; i < waitEdges.length - 1; i++) {
                const lo = waitEdges[i];
                const hi = waitEdges[i + 1];
                if (i < waitEdges.length - 2) {
                    if (w >= lo && w < hi) return i;
                } else if (w >= lo && w <= hi) return i;
            }
            return cols - 1;
        };

        for (let i = 0; i < n; i++) {
            const p = reqProc[i];
            const w = waits[i];
            if (!Number.isFinite(p) || !Number.isFinite(w) || p <= 0 || w < 0) continue;
            counts[pIdx(p)][wIdx(w)] += 1;
        }

        const maxCount = counts.reduce((m, row) => Math.max(m, ...row), 0);
        return {
            x_labels: waitEdges.slice(0, -1).map((lo, i) => `${App.formatTime(lo)}-${App.formatTime(waitEdges[i + 1])}`),
            y_labels: procEdges.slice(0, -1).map((lo, i) => `${lo}-${procEdges[i + 1]}`),
            counts,
            max_count: maxCount,
            total_jobs: n,
        };
    },

    _inferWaitDistFromScatter(scatter, totalJobs = 0, nBins = 12) {
        const waits = Array.isArray(scatter?.wait) ? scatter.wait.map(v => Number(v)) : [];
        const clean = waits.filter(v => Number.isFinite(v) && v >= 0);
        if (totalJobs > 0 && clean.length > 0 && clean.length < totalJobs) return null;
        if (!clean.length) return null;

        const zeroCount = clean.filter(v => v <= 0).length;
        const positive = clean.filter(v => v > 0);
        if (!positive.length) return { labels: ["0s"], counts: [clean.length], edges: [0, 1] };

        const minW = Math.max(1, Math.min(...positive));
        const maxW = Math.max(...positive);
        const posBins = Math.max(1, nBins - 1);
        const fmt = s => App.formatTime(s);

        if (maxW <= minW) {
            return {
                labels: ["0s", `${fmt(minW)}-${fmt(minW + 1)}`],
                counts: [zeroCount, positive.length],
                edges: [0, minW, minW + 1],
            };
        }

        const logMin = Math.log10(minW);
        const logMax = Math.log10(maxW);
        const edges = Array.from({ length: posBins + 1 }, (_, i) => 10 ** (logMin + (i * (logMax - logMin) / posBins)));
        const counts = new Array(posBins).fill(0);

        for (const w of positive) {
            let placed = false;
            for (let i = 0; i < posBins - 1; i++) {
                if (w < edges[i + 1]) {
                    counts[i] += 1;
                    placed = true;
                    break;
                }
            }
            if (!placed) counts[posBins - 1] += 1;
        }

        return {
            labels: ["0s", ...edges.slice(0, -1).map((lo, i) => `${fmt(lo)}-${fmt(edges[i + 1])}`)],
            counts: [zeroCount, ...counts],
            edges: [0, ...edges],
        };
    },

    _inferWaitByRuntimeFromScatter(scatter, runtimeDist, totalJobs = 0) {
        const waits = Array.isArray(scatter?.wait) ? scatter.wait.map(v => Number(v)) : [];
        const runs = Array.isArray(scatter?.run) ? scatter.run.map(v => Number(v)) : [];
        const n = Math.min(runs.length, waits.length);
        if (totalJobs > 0 && n > 0 && n < totalJobs) return null;
        if (!n) return null;

        const labels = Array.isArray(runtimeDist?.labels) ? runtimeDist.labels : [];
        const edges = Array.isArray(runtimeDist?.edges) ? runtimeDist.edges : [];
        if (!labels.length || edges.length !== labels.length + 1) return null;

        const sums = new Array(labels.length).fill(0);
        const counts = new Array(labels.length).fill(0);
        for (let i = 0; i < n; i++) {
            const run = runs[i];
            const wait = waits[i];
            if (!Number.isFinite(run) || !Number.isFinite(wait) || run < 0 || wait < 0) continue;

            let idx = labels.length - 1;
            for (let b = 0; b < labels.length - 1; b++) {
                if (run < edges[b + 1]) {
                    idx = b;
                    break;
                }
            }
            sums[idx] += wait;
            counts[idx] += 1;
        }

        return {
            labels,
            avg_wait: sums.map((s, i) => counts[i] ? +(s / counts[i]).toFixed(2) : 0),
            job_counts: counts,
        };
    },

    _inferWaitByJobSizeFromScatter(scatter, totalJobs = 0) {
        const reqProc = Array.isArray(scatter?.reqProc) ? scatter.reqProc.map(v => Number(v)) : [];
        const waits = Array.isArray(scatter?.wait) ? scatter.wait.map(v => Number(v)) : [];
        const n = Math.min(reqProc.length, waits.length);
        if (totalJobs > 0 && n > 0 && n < totalJobs) return null;
        if (!n) return null;

        const procEdges = [1, 8, 32, 128, 512, 2048, 8192, 32768];
        const bins = procEdges.slice(0, -1).map((lo, i) => ({
            lo,
            hi: procEdges[i + 1],
            label: `${lo}-${procEdges[i + 1]}`,
            waits: [],
        }));

        for (let i = 0; i < n; i++) {
            const p = reqProc[i];
            const w = waits[i];
            if (!Number.isFinite(p) || !Number.isFinite(w) || p <= 0 || w < 0) continue;
            for (let bi = 0; bi < bins.length; bi++) {
                const b = bins[bi];
                const inBucket = bi < bins.length - 1 ? (p >= b.lo && p < b.hi) : (p >= b.lo && p <= b.hi);
                if (inBucket) {
                    b.waits.push(w);
                    break;
                }
            }
        }

        const labels = [];
        const avg_wait_nonzero = [];
        const p95_wait_nonzero = [];
        const waited_jobs = [];
        const total_jobs = [];
        const waited_pct = [];

        const pct = (arr, p) => {
            if (!arr.length) return 0;
            const s = [...arr].sort((a, b) => a - b);
            const k = (s.length - 1) * (p / 100);
            const lo = Math.floor(k);
            const hi = Math.ceil(k);
            if (lo === hi) return s[lo];
            const f = k - lo;
            return s[lo] * (1 - f) + s[hi] * f;
        };

        for (const b of bins) {
            if (!b.waits.length) continue;
            const waited = b.waits.filter(v => v > 0);
            labels.push(b.label);
            avg_wait_nonzero.push(waited.length ? waited.reduce((a, x) => a + x, 0) / waited.length : 0);
            p95_wait_nonzero.push(waited.length ? pct(waited, 95) : 0);
            waited_jobs.push(waited.length);
            total_jobs.push(b.waits.length);
            waited_pct.push(b.waits.length ? (waited.length / b.waits.length) * 100 : 0);
        }

        return {
            labels,
            avg_wait_nonzero,
            p95_wait_nonzero,
            waited_jobs,
            total_jobs,
            waited_pct,
        };
    },

    _inferJobSizeDistFromScatter(scatter) {
        const reqProc = Array.isArray(scatter?.reqProc) ? scatter.reqProc.map(v => Number(v)) : [];
        const clean = reqProc.filter(v => Number.isFinite(v) && v > 0).map(v => Math.max(1, Math.floor(v)));
        if (!clean.length) return null;

        const maxReq = Math.max(...clean, 1);
        const edges = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
        while (maxReq > edges[edges.length - 1] && edges.length < 24) edges.push(edges[edges.length - 1] * 2);

        const counts = new Array(edges.length - 1).fill(0);
        for (const p of clean) {
            let idx = counts.length - 1;
            for (let i = 0; i < edges.length - 1; i++) {
                const lo = edges[i];
                const hi = edges[i + 1];
                if (i < edges.length - 2) {
                    if (p >= lo && p < hi) {
                        idx = i;
                        break;
                    }
                } else if (p >= lo && p <= hi) {
                    idx = i;
                    break;
                }
            }
            counts[idx] += 1;
        }

        const fmt = v => {
            if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
            if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
            return String(v);
        };
        const labels = edges.slice(0, -1).map((lo, i) => `${fmt(lo)}-${fmt(edges[i + 1])}`);
        return { labels, counts, edges, total_jobs: clean.length };
    },

    _showConfigBar(params, meta) {
        const bar = document.getElementById("run-config-bar");
        if (!params || !params.job_trace) {
            bar.classList.add("hidden");
            return;
        }

        const bf = ["None", "EASY", "Conservative"][params.backfill] ?? params.backfill;
        const runObj = {
            run_name: meta?.run_name || params?.output_name || "",
            system: meta?.system || "custom",
            variant: meta?.variant || "default_config",
            scenario: meta?.scenario || "",
        };
        const runFull = runObj.run_name ? `<span><b>Run:</b> ${App.runFullLabel(runObj)}</span>` : "";
        const output = params.output_name ? `<span><b>Output:</b> ${params.output_name}</span>` : "";

        bar.innerHTML = [
            `<span><b>File:</b> ${params.job_trace}</span>`,
            runFull,
            `<span><b>Algorithm:</b> ${params.algorithm}</span>`,
            `<span><b>Backfill:</b> ${bf}</span>`,
            `<span><b>Window:</b> ${params.win} (${params.win_para})</span>`,
            `<span><b>Jobs Read:</b> ${params.read_num}</span>`,
            `<span><b>Frac:</b> ${params.cluster_fraction}</span>`,
            output,
        ].filter(Boolean).join("");

        bar.classList.remove("hidden");
    },

    _renderInsights(insights, summary) {
        const box = document.getElementById("overview-insights");
        const list = [...(insights || [])];

        if (!list.length && summary) {
            list.push(`Average utilization was ${((summary.avg_utilization || 0) * 100).toFixed(1)}%.`);
            list.push(`p95 wait was ${App.formatTime(summary.wait_p95 || 0)}; median wait was ${App.formatTime(summary.median_wait || 0)}.`);
            list.push(`Throughput reached ${(summary.throughput_jobs_per_day || 0).toFixed(2)} jobs/day.`);
        }

        box.innerHTML = list.map(item => `<div class="insight">${item}</div>`).join("");
    },

    _renderCards(s) {
        const el = document.getElementById("overview-summary");
        if (!s) {
            el.innerHTML = "";
            return;
        }

        el.innerHTML = `
            <div class="card"><div class="label">Total Jobs</div><div class="value">${(s.total_jobs || 0).toLocaleString()}</div></div>
            <div class="card"><div class="label">Avg Wait</div><div class="value">${App.formatTime(s.avg_wait)}</div></div>
            <div class="card"><div class="label">Wait p95</div><div class="value">${App.formatTime(s.wait_p95)}</div></div>
            <div class="card"><div class="label">Avg Util</div><div class="value">${((s.avg_utilization || 0) * 100).toFixed(1)}%</div></div>
            <div class="card"><div class="label">Peak Queue Depth</div><div class="value">${(s.peak_queue_depth || 0).toLocaleString()}</div></div>
            <div class="card"><div class="label">Makespan</div><div class="value">${App.formatTime(s.makespan)}</div></div>
            <div class="card"><div class="label">Throughput</div><div class="value">${(s.throughput_jobs_per_day || 0).toFixed(1)}</div></div>
            <div class="card"><div class="label">Avg BSD</div><div class="value">${(s.avg_bounded_slowdown || 0).toFixed(2)}x</div></div>
        `;
    },

    _renderWaitBuckets(buckets) {
        const ctx = document.getElementById("chart-wait-buckets");
        if (!ctx) return;
        if (this.charts["wait-buckets"]) this.charts["wait-buckets"].destroy();
        if (!buckets) return;

        const [t1, t2] = buckets.thresholds || [0, 0];
        const labels = [
            `Short (<${App.formatTime(t1)})`,
            `Medium (${App.formatTime(t1)}-${App.formatTime(t2)})`,
            `Long (>${App.formatTime(t2)})`,
        ];

        const keys = ["short", "medium", "long"];
        const avgWait = keys.map(k => buckets[k]?.avg_wait || 0);

        this.charts["wait-buckets"] = new Chart(ctx, {
            type: "bar",
            data: {
                labels,
                datasets: [
                    {
                        label: "Avg Wait",
                        data: avgWait,
                        backgroundColor: ["#2dd4bf88", "#38bdf888", "#f59e0b88"],
                        borderColor: ["#2dd4bf", "#38bdf8", "#f59e0b"],
                        borderWidth: 1.3,
                    },
                ],
            },
            options: App.chartDefaults({
                aspectRatio: 2.0,
                scales: {
                    x: { ticks: { color: "#8fb2c8", font: { size: 10 } }, grid: { color: "#1e394f" } },
                    y: {
                        ticks: { color: "#8fb2c8", callback: v => App.formatTime(v) },
                        grid: { color: "#1e394f" },
                        title: { display: true, text: "Wait Time", color: "#8fb2c8" },
                        min: 0,
                    },
                },
            }),
        });
    },

    _renderWaitDist(dist) {
        const ctx = document.getElementById("chart-wait-dist");
        if (!ctx) return;
        if (this.charts["wait-dist"]) this.charts["wait-dist"].destroy();
        if (!dist?.counts?.length) return;

        const n = dist.counts.length;
        const colors = dist.counts.map((_, i) => {
            const t = i / Math.max(n - 1, 1);
            const r = Math.round(45 + t * 180);
            const g = Math.round(212 - t * 80);
            const b = Math.round(191 - t * 120);
            return `rgba(${r},${g},${b},0.62)`;
        });

        this.charts["wait-dist"] = new Chart(ctx, {
            type: "bar",
            data: {
                labels: dist.labels,
                datasets: [{
                    label: "Jobs",
                    data: dist.counts,
                    backgroundColor: colors,
                    borderColor: colors.map(c => c.replace("0.62", "1")),
                    borderWidth: 1,
                }],
            },
            options: App.chartDefaults({
                aspectRatio: 2.0,
                plugins: { legend: { display: false } },
                scales: {
                    x: {
                        ticks: { color: "#8fb2c8", font: { size: 9 }, maxRotation: 36 },
                        grid: { color: "#1e394f" },
                    },
                    y: {
                        ticks: { color: "#8fb2c8" },
                        grid: { color: "#1e394f" },
                        title: { display: true, text: "Jobs", color: "#8fb2c8" },
                    },
                },
            }),
        });
    },

    _renderWaitByJobSize(dist) {
        const ctx = document.getElementById("chart-wait-by-size");
        if (!ctx) return;
        if (this.charts["wait-dist"]) this.charts["wait-dist"].destroy();
        if (!dist?.labels?.length) return;

        const avg = (dist.avg_wait_nonzero || []).map(v => Number(v || 0));
        const p95 = (dist.p95_wait_nonzero || []).map(v => Number(v || 0));

        this.charts["wait-dist"] = new Chart(ctx, {
            data: {
                labels: dist.labels,
                datasets: [
                    {
                        type: "bar",
                        label: "Avg Wait (wait>0 jobs)",
                        data: avg,
                        backgroundColor: "#2dd4bf88",
                        borderColor: "#2dd4bf",
                        borderWidth: 1.2,
                    },
                    {
                        type: "line",
                        label: "p95 Wait (wait>0 jobs)",
                        data: p95,
                        borderColor: "#f97316",
                        backgroundColor: "#f9731633",
                        pointRadius: 2.2,
                        pointHoverRadius: 3,
                        borderWidth: 1.5,
                        tension: 0.22,
                        fill: false,
                    },
                ],
            },
            options: App.chartDefaults({
                aspectRatio: 2.0,
                scales: {
                    x: {
                        ticks: { color: "#8fb2c8", font: { size: 9 }, maxRotation: 24 },
                        grid: { color: "#1e394f" },
                        title: { display: true, text: "Requested Processors (Job Size Bins)", color: "#8fb2c8" },
                    },
                    y: {
                        ticks: { color: "#8fb2c8", callback: v => App.formatTime(v) },
                        grid: { color: "#1e394f" },
                        title: { display: true, text: "Wait Time", color: "#8fb2c8" },
                        min: 0,
                    },
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: (item) => {
                                const idx = item.dataIndex;
                                const dsLabel = item.dataset?.label || "value";
                                const val = Number(item.raw || 0);
                                const waited = Number(dist.waited_jobs?.[idx] || 0);
                                const total = Number(dist.total_jobs?.[idx] || 0);
                                const waitedPct = Number(dist.waited_pct?.[idx] || 0);
                                return `${dsLabel}: ${App.formatTime(val)} | waited jobs ${waited}/${total} (${waitedPct.toFixed(2)}%)`;
                            },
                        },
                    },
                },
            }),
        });
    },

    _renderWaitByRuntime(dist) {
        const ctx = document.getElementById("chart-wait-runtime");
        if (!ctx) return;
        if (this.charts["wait-runtime"]) this.charts["wait-runtime"].destroy();
        if (!dist?.labels?.length) return;

        const avg = (dist.avg_wait || []).map(v => Number(v || 0));
        this.charts["wait-runtime"] = new Chart(ctx, {
            type: "bar",
            data: {
                labels: dist.labels,
                datasets: [{
                    label: "Avg Wait",
                    data: avg,
                    backgroundColor: "#2dd4bf88",
                    borderColor: "#2dd4bf",
                    borderWidth: 1.2,
                }],
            },
            options: App.chartDefaults({
                aspectRatio: 2.0,
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: (item) => {
                                const idx = item.dataIndex;
                                const val = App.formatTime(Number(item.raw || 0));
                                const jobs = Number(dist.job_counts?.[idx] || 0).toLocaleString();
                                return `Avg Wait: ${val} | Jobs: ${jobs}`;
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        ticks: { color: "#8fb2c8", font: { size: 9 }, maxRotation: 36 },
                        grid: { color: "#1e394f" },
                        title: { display: true, text: "Runtime (same bins as Runtime Distribution)", color: "#8fb2c8" },
                    },
                    y: {
                        ticks: { color: "#8fb2c8", callback: v => App.formatTime(v) },
                        grid: { color: "#1e394f" },
                        title: { display: true, text: "Avg Wait Time", color: "#8fb2c8" },
                        min: 0,
                    },
                },
            }),
        });
    },

    _renderRuntimeDist(dist) {
        const ctx = document.getElementById("chart-bsd-dist");
        if (!ctx) return;
        if (this.charts["runtime-dist"]) this.charts["runtime-dist"].destroy();
        if (!dist?.counts?.length) return;

        const n = dist.counts.length;
        const colors = dist.counts.map((_, i) => {
            const t = i / Math.max(n - 1, 1);
            const r = Math.round(45 + t * 180);
            const g = Math.round(212 - t * 80);
            const b = Math.round(191 - t * 120);
            return `rgba(${r},${g},${b},0.62)`;
        });

        this.charts["runtime-dist"] = new Chart(ctx, {
            type: "bar",
            data: {
                labels: dist.labels,
                datasets: [{
                    label: "Jobs",
                    data: dist.counts,
                    backgroundColor: colors,
                    borderColor: colors.map(c => c.replace("0.62", "1")),
                    borderWidth: 1,
                }],
            },
            options: App.chartDefaults({
                aspectRatio: 2.0,
                plugins: { legend: { display: false } },
                scales: {
                    x: {
                        ticks: { color: "#8fb2c8", font: { size: 9 }, maxRotation: 36 },
                        grid: { color: "#1e394f" },
                    },
                    y: {
                        ticks: { color: "#8fb2c8" },
                        grid: { color: "#1e394f" },
                        title: { display: true, text: "Jobs", color: "#8fb2c8" },
                    },
                },
            }),
        });
    },

    _renderJobSizeDist(dist) {
        const ctx = document.getElementById("chart-jobsize-dist");
        if (!ctx) return;
        if (this.charts["jobsize-dist"]) this.charts["jobsize-dist"].destroy();
        if (!dist?.counts?.length) return;

        const n = dist.counts.length;
        const colors = dist.counts.map((_, i) => {
            const t = i / Math.max(n - 1, 1);
            const r = Math.round(56 + t * 140);
            const g = Math.round(189 - t * 48);
            const b = Math.round(248 - t * 98);
            return `rgba(${r},${g},${b},0.62)`;
        });

        this.charts["jobsize-dist"] = new Chart(ctx, {
            type: "bar",
            data: {
                labels: dist.labels,
                datasets: [{
                    label: "Jobs",
                    data: dist.counts,
                    backgroundColor: colors,
                    borderColor: colors.map(c => c.replace("0.62", "1")),
                    borderWidth: 1,
                }],
            },
            options: App.chartDefaults({
                aspectRatio: 2.0,
                plugins: { legend: { display: false } },
                scales: {
                    x: {
                        ticks: { color: "#8fb2c8", font: { size: 9 }, maxRotation: 36 },
                        grid: { color: "#1e394f" },
                        title: { display: true, text: "Requested Processors (bins)", color: "#8fb2c8" },
                    },
                    y: {
                        ticks: { color: "#8fb2c8" },
                        grid: { color: "#1e394f" },
                        title: { display: true, text: "Jobs", color: "#8fb2c8" },
                    },
                },
            }),
        });
    },

    _renderUtilization(ts) {
        const ctx = document.getElementById("chart-overview-uti");
        if (!ctx) return;
        if (this.charts["overview-uti"]) this.charts["overview-uti"].destroy();
        if (!ts?.time?.length) return;

        const labels = [];
        const uti = [];
        const qd = [];

        for (let i = 0; i < ts.time.length; i++) {
            labels.push(App.formatTime(ts.time[i]));
            uti.push(+((ts.utilization[i] || 0) * 100).toFixed(2));
            qd.push(ts.queue_depth?.[i] || 0);
        }

        this.charts["overview-uti"] = new Chart(ctx, {
            type: "line",
            data: {
                labels,
                datasets: [
                    {
                        label: "Utilization %",
                        data: uti,
                        borderColor: "#2dd4bf",
                        backgroundColor: "#2dd4bf33",
                        fill: true,
                        pointRadius: 0,
                        borderWidth: 1.4,
                        tension: 0.3,
                        yAxisID: "yU",
                    },
                    {
                        label: "Queue Depth",
                        data: qd,
                        borderColor: "#f59e0b",
                        backgroundColor: "transparent",
                        fill: false,
                        pointRadius: 0,
                        borderWidth: 1.3,
                        tension: 0.3,
                        yAxisID: "yQ",
                    },
                ],
            },
            options: App.chartDefaults({
                aspectRatio: 3,
                scales: {
                    x: {
                        ticks: { color: "#8fb2c8", font: { size: 9 }, maxTicksLimit: 12 },
                        grid: { color: "#1e394f" },
                    },
                    yU: {
                        position: "left",
                        min: 0,
                        max: 100,
                        ticks: { color: "#8fb2c8", callback: v => `${v}%` },
                        grid: { color: "#1e394f" },
                        title: { display: true, text: "Utilization", color: "#8fb2c8" },
                    },
                    yQ: {
                        position: "right",
                        ticks: { color: "#f7c175" },
                        grid: { drawOnChartArea: false },
                        title: { display: true, text: "Queue Depth", color: "#f7c175" },
                    },
                },
            }),
        });
        App.enableLineChartZoom(this.charts["overview-uti"], { xScaleId: "x", minWindow: 12, zoomFactor: 0.55 });
    },

    _renderWaitTimeline(tl) {
        const ctx = document.getElementById("chart-wait-timeline");
        if (!ctx) return;
        if (this.charts["wait-timeline"]) this.charts["wait-timeline"].destroy();
        if (!tl?.labels?.length) return;

        this.charts["wait-timeline"] = new Chart(ctx, {
            type: "line",
            data: {
                labels: tl.labels,
                datasets: [
                    {
                        label: "p50 wait",
                        data: tl.p50 || [],
                        borderColor: "#38bdf8",
                        backgroundColor: "transparent",
                        pointRadius: 0,
                        borderWidth: 1.2,
                        tension: 0.25,
                    },
                    {
                        label: "p90 wait",
                        data: tl.p90 || [],
                        borderColor: "#2dd4bf",
                        backgroundColor: "transparent",
                        pointRadius: 0,
                        borderWidth: 1.3,
                        tension: 0.25,
                    },
                    {
                        label: "p99 wait",
                        data: tl.p99 || [],
                        borderColor: "#f97316",
                        backgroundColor: "transparent",
                        pointRadius: 0,
                        borderWidth: 1.4,
                        tension: 0.25,
                    },
                ],
            },
            options: App.chartDefaults({
                aspectRatio: 2.0,
                scales: {
                    x: {
                        ticks: { color: "#8fb2c8", font: { size: 9 }, maxTicksLimit: 10 },
                        grid: { color: "#1e394f" },
                        title: { display: true, text: "Submit-Time Offset", color: "#8fb2c8" },
                    },
                    y: {
                        ticks: { color: "#8fb2c8", callback: v => App.formatTime(v) },
                        grid: { color: "#1e394f" },
                        title: { display: true, text: "Wait", color: "#8fb2c8" },
                    },
                },
            }),
        });
        App.enableLineChartZoom(this.charts["wait-timeline"], { xScaleId: "x", minWindow: 8, zoomFactor: 0.5 });
    },

    _renderUtilizationDist(dist) {
        const ctx = document.getElementById("chart-uti-dist");
        if (!ctx) return;
        if (this.charts["uti-dist"]) this.charts["uti-dist"].destroy();
        if (!dist?.labels?.length) return;

        this.charts["uti-dist"] = new Chart(ctx, {
            type: "bar",
            data: {
                labels: dist.labels,
                datasets: [{
                    label: "Samples",
                    data: dist.counts,
                    backgroundColor: "#2dd4bf88",
                    borderColor: "#2dd4bf",
                    borderWidth: 1,
                }],
            },
            options: App.chartDefaults({
                aspectRatio: 2.0,
                plugins: { legend: { display: false } },
                scales: {
                    x: {
                        ticks: { color: "#8fb2c8", font: { size: 9 }, maxRotation: 0 },
                        grid: { color: "#1e394f" },
                    },
                    y: {
                        ticks: { color: "#8fb2c8" },
                        grid: { color: "#1e394f" },
                        title: { display: true, text: "Time Samples", color: "#8fb2c8" },
                    },
                },
            }),
        });
    },

    _setupCanvas(id, minHeight = 280) {
        const canvas = document.getElementById(id);
        if (!canvas) return null;

        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(320, Math.floor(rect.width || canvas.clientWidth || 320));
        const h = Math.max(minHeight, Math.floor(rect.height || canvas.clientHeight || minHeight));

        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        if (typeof ctx.setTransform === "function") {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        } else if (typeof ctx.scale === "function") {
            ctx.scale(dpr, dpr);
        }
        ctx.clearRect(0, 0, w, h);
        return { ctx, w, h };
    },

    _heatColor(t) {
        const x = Math.max(0, Math.min(1, Number(t) || 0));
        const hue = 212 - x * 176;
        const light = 14 + x * 52;
        return `hsl(${hue} 84% ${light}%)`;
    },

    _renderWaitViolin(violin) {
        const noteEl = document.getElementById("wait-violin-note");
        const plot = this._setupCanvas("chart-wait-violin", 290);
        if (!plot) return;

        const { ctx, w, h } = plot;
        const groups = Array.isArray(violin?.groups)
            ? violin.groups.filter(g => Array.isArray(g?.points) && g.points.length)
            : (Array.isArray(violin?.points) && violin.points.length ? [Object.assign({ label: "All Jobs", key: "all" }, violin)] : []);
        if (!groups.length) {
            if (noteEl) noteEl.textContent = "No wait-time distribution data available for this run.";
            return;
        }

        const left = 66;
        const right = 18;
        const top = 14;
        const bottom = 60;
        const pw = w - left - right;
        const ph = h - top - bottom;
        if (pw <= 20 || ph <= 20) return;

        const groupScales = groups.map(g => {
            const points = Array.isArray(g?.points) ? g.points : [];
            const pointMax = points.reduce((m, p) => {
                const y1 = Number(p?.y1);
                const mid = Number(p?.mid);
                return Math.max(m, Number.isFinite(y1) ? y1 : 0, Number.isFinite(mid) ? mid : 0);
            }, 0);
            const dataMax = Math.max(
                Number(g?.clip_wait) || 0,
                Number(g?.max_wait) || 0,
                Number(g?.quantiles?.q99) || 0,
                pointMax,
            );
            return Math.max(1, dataMax * 1.05);
        });

        const palette = [
            ["rgba(56, 189, 248, 0.30)", "rgba(56, 189, 248, 0.72)", "rgba(171, 235, 255, 0.95)"],
            ["rgba(45, 212, 191, 0.30)", "rgba(45, 212, 191, 0.72)", "rgba(180, 255, 244, 0.95)"],
            ["rgba(245, 158, 11, 0.30)", "rgba(245, 158, 11, 0.72)", "rgba(255, 224, 160, 0.95)"],
        ];

        const slotW = pw / groups.length;
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(82, 124, 150, 0.24)";
        ctx.fillStyle = "#7ba2ba";
        ctx.font = "10px Space Grotesk";
        for (let gi = 0; gi < groups.length; gi++) {
            const maxYLocal = groupScales[gi];
            const slotLeft = left + slotW * gi;
            const slotRight = slotLeft + slotW;
            const toYLocal = v => top + ph * (1 - Math.max(0, Math.min(maxYLocal, v)) / maxYLocal);

            for (let i = 0; i <= 5; i++) {
                const y = toYLocal((maxYLocal * i) / 5);
                ctx.beginPath();
                ctx.moveTo(slotLeft + 6, y);
                ctx.lineTo(slotRight - 6, y);
                ctx.stroke();
            }

            if (gi > 0) {
                ctx.beginPath();
                ctx.moveTo(slotLeft, top);
                ctx.lineTo(slotLeft, top + ph);
                ctx.stroke();
            }

            ctx.fillText(App.formatTime(maxYLocal), slotLeft + 8, toYLocal(maxYLocal) + 8);
            ctx.fillText(App.formatTime(maxYLocal * 0.5), slotLeft + 8, toYLocal(maxYLocal * 0.5));
        }

        for (let gi = 0; gi < groups.length; gi++) {
            const g = groups[gi];
            const points = g.points || [];
            if (!points.length) continue;

            const centerX = left + slotW * (gi + 0.5);
            const maxHalf = Math.min(slotW * 0.36, 80);
            const colors = palette[gi % palette.length];
            const maxYLocal = groupScales[gi];
            const toYLocal = v => top + ph * (1 - Math.max(0, Math.min(maxYLocal, v)) / maxYLocal);

            ctx.beginPath();
            for (let i = 0; i < points.length; i++) {
                const p = points[i];
                const y = toYLocal(p.mid || 0);
                const x = centerX + maxHalf * (p.density || 0);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            for (let i = points.length - 1; i >= 0; i--) {
                const p = points[i];
                const y = toYLocal(p.mid || 0);
                const x = centerX - maxHalf * (p.density || 0);
                ctx.lineTo(x, y);
            }
            ctx.closePath();

            const grad = ctx.createLinearGradient(centerX - maxHalf, top, centerX + maxHalf, top);
            grad.addColorStop(0, colors[0]);
            grad.addColorStop(0.5, colors[1]);
            grad.addColorStop(1, colors[0]);
            ctx.fillStyle = grad;
            ctx.fill();
            ctx.strokeStyle = colors[2];
            ctx.lineWidth = 1.2;
            ctx.stroke();

            const q = g.quantiles || {};
            const qLine = (v, color, wMul = 0.78, dash = null) => {
                if (!Number.isFinite(v)) return;
                const y = toYLocal(v);
                const half = maxHalf * wMul;
                ctx.strokeStyle = color;
                ctx.lineWidth = 1.1;
                ctx.setLineDash(dash || []);
                ctx.beginPath();
                ctx.moveTo(centerX - half, y);
                ctx.lineTo(centerX + half, y);
                ctx.stroke();
                ctx.setLineDash([]);
            };

            qLine(q.q25, "rgba(223, 248, 255, 0.55)", 0.62);
            qLine(q.q50, "rgba(255, 255, 255, 0.96)", 0.9);
            qLine(q.q75, "rgba(223, 248, 255, 0.55)", 0.62);
            qLine(q.q90, "rgba(253, 186, 116, 0.95)", 0.42, [4, 3]);

            ctx.fillStyle = "#9dbfd4";
            ctx.font = "11px Space Grotesk";
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillText(g.label || `Group ${gi + 1}`, centerX, top + ph + 8);
        }

        const qLineGlobal = (v, color, dash = null) => {
            if (!Number.isFinite(v)) return;
            const y = top + ph;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.05;
            ctx.setLineDash(dash || []);
            ctx.beginPath();
            ctx.moveTo(left, y);
            ctx.lineTo(left + pw, y);
            ctx.stroke();
            ctx.setLineDash([]);
        };
        qLineGlobal(0, "rgba(130, 168, 192, 0.35)");

        if (noteEl) {
            const parts = groups.map(g => {
                const q = g.quantiles || {};
                return `${g.label || "Group"} p50:${App.formatTime(q.q50 || 0)} p90:${App.formatTime(q.q90 || 0)}`;
            });
            const t = Array.isArray(violin?.runtime_thresholds) ? violin.runtime_thresholds : [];
            const thresholdText = t.length >= 2
                ? ` | Buckets: Small <${App.formatTime(t[0])}, Medium ${App.formatTime(t[0])}-${App.formatTime(t[1])}, Large >${App.formatTime(t[1])}`
                : "";
            const scaleText = ` | Y-axis per bucket: ${groups.map((g, i) => `${g.label || `Group ${i + 1}`} 0-${App.formatTime(groupScales[i])}`).join(", ")}.`;
            const clipHints = groups
                .filter(g => String(g?.clip_source || "") === "p90_nonzero")
                .map(g => `${g.label || "Group"} zero-wait ${Number(g?.zero_wait_pct || 0).toFixed(1)}%`);
            const clipHintText = clipHints.length
                ? ` | Zero-heavy groups use non-zero tail clipping: ${clipHints.join(", ")}.`
                : "";
            noteEl.textContent = parts.join(" | ") + thresholdText + scaleText + clipHintText;
        }
    },

    _renderJobSizeWaitHeatmap(heatmap) {
        const noteEl = document.getElementById("jobsize-heatmap-note");
        const plot = this._setupCanvas("chart-jobsize-wait-heatmap", 290);
        if (!plot) return;

        const { ctx, w, h } = plot;
        if (!heatmap?.counts?.length || !heatmap?.x_labels?.length || !heatmap?.y_labels?.length) {
            if (noteEl) noteEl.textContent = "No heatmap data available for this run.";
            return;
        }

        const rows = heatmap.y_labels.length;
        const cols = heatmap.x_labels.length;
        const maxCount = Math.max(1, Number(heatmap.max_count) || 1);

        const left = 80;
        const right = 30;
        const top = 16;
        const bottom = 112;
        const pw = w - left - right;
        const ph = h - top - bottom;
        if (pw <= 30 || ph <= 30) return;

        const cw = pw / cols;
        const ch = ph / rows;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const count = heatmap.counts[r]?.[c] || 0;
                const intensity = count > 0 ? Math.sqrt(count / maxCount) : 0;
                const color = count > 0 ? this._heatColor(intensity) : "rgba(9, 24, 36, 0.9)";
                const x = left + c * cw;
                const y = top + r * ch;
                ctx.fillStyle = color;
                ctx.fillRect(x + 1, y + 1, Math.max(1, cw - 2), Math.max(1, ch - 2));

                if (count > 0 && cw >= 26 && ch >= 18) {
                    ctx.fillStyle = intensity > 0.58 ? "#f5fbff" : "#0d2435";
                    ctx.font = "11px IBM Plex Mono";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillText(String(count), x + cw * 0.5, y + ch * 0.52);
                }
            }
        }

        ctx.strokeStyle = "rgba(101, 138, 163, 0.24)";
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

        ctx.fillStyle = "#93b5ca";
        ctx.font = "11px Space Grotesk";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        for (let r = 0; r < rows; r++) {
            const y = top + (r + 0.5) * ch;
            ctx.fillText(heatmap.y_labels[r], left - 6, y);
        }

        const xStep = cols <= 12 ? 1 : Math.max(1, Math.ceil(cols / 10));
        ctx.fillStyle = "#93b5ca";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        for (let c = 0; c < cols; c++) {
            if (c % xStep !== 0 && c !== cols - 1) continue;
            const x = left + (c + 0.5) * cw;
            const y = top + ph + 20;
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(-0.66);
            ctx.fillText(heatmap.x_labels[c], 0, 0);
            ctx.restore();
        }

        const lgW = pw;
        const lgH = 8;
        const lgX = left;
        const lgY = h - 22;
        const lg = ctx.createLinearGradient(lgX, 0, lgX + lgW, 0);
        lg.addColorStop(0, this._heatColor(0));
        lg.addColorStop(0.5, this._heatColor(0.5));
        lg.addColorStop(1, this._heatColor(1));
        ctx.fillStyle = lg;
        ctx.fillRect(lgX, lgY, lgW, lgH);
        ctx.strokeStyle = "rgba(130, 168, 192, 0.35)";
        ctx.strokeRect(lgX, lgY, lgW, lgH);
        ctx.fillStyle = "#87a9bf";
        ctx.font = "10px Space Grotesk";
        ctx.textAlign = "left";
        ctx.fillText("low", lgX, lgY - 2);
        ctx.textAlign = "right";
        ctx.fillText("high", lgX + lgW, lgY - 2);

        ctx.fillStyle = "#8fb2c8";
        ctx.font = "11px Space Grotesk";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Wait Time Bucket", left + (pw * 0.5), top + ph + 44);
        ctx.save();
        ctx.translate(18, top + ph * 0.5);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText("Requested Procs", 0, 0);
        ctx.restore();

        if (noteEl) {
            noteEl.textContent =
                `Cell color = number of jobs in each (req-proc, wait-time) bucket. ` +
                `Max cell: ${maxCount} jobs. Total: ${(heatmap.total_jobs || 0).toLocaleString()} jobs.`;
        }
    },

    _renderTopWait(rows) {
        const tbody = document.querySelector("#top-wait-table tbody");
        if (!rows?.length) {
            tbody.innerHTML = "";
            return;
        }

        tbody.innerHTML = rows.map(r => `
            <tr>
                <td>${r.job_id}</td>
                <td>${App.formatTime(r.wait)}</td>
                <td>${App.formatTime(r.run)}</td>
                <td>${(r.reqProc || 0).toLocaleString()}</td>
                <td>${App.formatTime(r.reqTime)}</td>
            </tr>
        `).join("");
    },

    _renderTable(s) {
        const tbody = document.querySelector("#overview-table tbody");
        if (!tbody) return;

        tbody.innerHTML = METRIC_DEFS.map(def => {
            const val = s ? def.fmt(s[def.key]) : "-";
            return `<tr>
                <td>${def.label}</td>
                <td class="metric-val">${val}</td>
                <td class="metric-desc">${def.desc}</td>
            </tr>`;
        }).join("");
    },

    _exportPDF() {
        const body = document.body;
        const prevScrollY = window.scrollY || window.pageYOffset || 0;
        let restored = false;

        const restore = () => {
            if (restored) return;
            restored = true;
            body.classList.remove("print-overview-only");
            document.querySelectorAll("canvas").forEach(c => {
                c.style.background = "";
            });
            window.scrollTo(0, prevScrollY);
        };

        body.classList.add("print-overview-only");
        window.scrollTo(0, 0);
        document.querySelectorAll("canvas").forEach(c => {
            c.style.background = "#fff";
        });
        window.addEventListener("afterprint", restore, { once: true });
        window.print();
        setTimeout(restore, 1200);
    },
};
