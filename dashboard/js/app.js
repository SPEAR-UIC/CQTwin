/* app.js - CQTwin shared state, routing, formatting, and data helpers */

const METRIC_DEFS = [
    { key: "total_jobs",              label: "Total Jobs",                 fmt: v => (v || 0).toLocaleString(),               desc: "Number of jobs processed in this simulation run." },
    { key: "throughput_jobs_per_day", label: "Throughput",                 fmt: v => `${(v || 0).toFixed(2)} jobs/day`,       desc: "Completed jobs normalized per simulated day of makespan." },

    { key: "avg_wait",                label: "Avg Wait Time",              fmt: v => App.formatTime(v),                        desc: "Average queue wait before execution starts." },
    { key: "median_wait",             label: "Median Wait Time",           fmt: v => App.formatTime(v),                        desc: "50th percentile queue wait time." },
    { key: "wait_p90",                label: "Wait p90",                   fmt: v => App.formatTime(v),                        desc: "90th percentile wait time (tail latency)." },
    { key: "wait_p95",                label: "Wait p95",                   fmt: v => App.formatTime(v),                        desc: "95th percentile wait time." },
    { key: "wait_p99",                label: "Wait p99",                   fmt: v => App.formatTime(v),                        desc: "99th percentile wait time; extreme queue tail." },
    { key: "max_wait",                label: "Max Wait Time",              fmt: v => App.formatTime(v),                        desc: "Longest observed wait among all jobs." },
    { key: "wait_std",                label: "Wait Std Dev",               fmt: v => App.formatTime(v),                        desc: "Spread/variance of wait times." },
    { key: "wait_gini",               label: "Wait Gini",                  fmt: v => (v || 0).toFixed(3),                      desc: "Inequality of wait-time distribution (0=equal, 1=unequal)." },
    { key: "jobs_wait_under_1m_pct",  label: "Jobs Wait <= 1m",            fmt: v => `${(v || 0).toFixed(2)}%`,                desc: "Share of jobs launched within one minute." },
    { key: "jobs_wait_under_10m_pct", label: "Jobs Wait <= 10m",           fmt: v => `${(v || 0).toFixed(2)}%`,                desc: "Share of jobs launched within ten minutes." },

    { key: "avg_runtime",             label: "Avg Runtime",                fmt: v => App.formatTime(v),                        desc: "Average realized runtime of jobs." },
    { key: "runtime_p90",             label: "Runtime p90",                fmt: v => App.formatTime(v),                        desc: "90th percentile runtime." },
    { key: "runtime_p95",             label: "Runtime p95",                fmt: v => App.formatTime(v),                        desc: "95th percentile runtime." },
    { key: "avg_req_runtime",         label: "Avg Requested Runtime",      fmt: v => App.formatTime(v),                        desc: "Average requested time limit (from trace)." },
    { key: "avg_turnaround",          label: "Avg Turnaround",             fmt: v => App.formatTime(v),                        desc: "Average submit-to-complete time (wait + run)." },
    { key: "turnaround_p95",          label: "Turnaround p95",             fmt: v => App.formatTime(v),                        desc: "95th percentile turnaround." },

    { key: "avg_utilization",         label: "Avg Utilization",            fmt: v => `${((v || 0) * 100).toFixed(1)}%`,        desc: "Average active cluster share across time samples." },
    { key: "peak_utilization",        label: "Peak Utilization",           fmt: v => `${((v || 0) * 100).toFixed(1)}%`,        desc: "Maximum observed utilization sample." },
    { key: "utilization_std",         label: "Utilization Std Dev",        fmt: v => `${((v || 0) * 100).toFixed(1)}%`,        desc: "Volatility of utilization over time." },
    { key: "idle_fraction",           label: "Idle Fraction",              fmt: v => `${((v || 0) * 100).toFixed(1)}%`,        desc: "Fraction of cluster capacity idle on average." },

    { key: "avg_queue_depth",         label: "Avg Queue Depth",            fmt: v => (v || 0).toFixed(2),                      desc: "Average number of waiting jobs in queue." },
    { key: "queue_depth_p95",         label: "Queue Depth p95",            fmt: v => (v || 0).toFixed(2),                      desc: "95th percentile waiting-job count." },
    { key: "peak_queue_depth",        label: "Peak Queue Depth",           fmt: v => (v || 0).toLocaleString(),                desc: "Maximum waiting-job count observed." },
    { key: "avg_queue_size",          label: "Avg Queue Size (Procs)",     fmt: v => (v || 0).toFixed(2),                      desc: "Average processors requested by waiting queue." },
    { key: "peak_queue_size",         label: "Peak Queue Size (Procs)",    fmt: v => (v || 0).toLocaleString(),                desc: "Maximum queued processor demand." },

    { key: "makespan",                label: "Makespan",                   fmt: v => App.formatTime(v),                        desc: "Total simulated interval from first submit to last completion." },
    { key: "avg_slowdown",            label: "Avg Slowdown",               fmt: v => `${(v || 0).toFixed(2)}x`,                desc: "Turnaround/runtime with denominator floor 1s." },
    { key: "avg_bounded_slowdown",    label: "Avg Bounded Slowdown",       fmt: v => `${(v || 0).toFixed(2)}x`,                desc: "Slowdown with denominator floor 10s to limit tiny-job skew." },
    { key: "slowdown_p95",            label: "Slowdown p95",               fmt: v => `${(v || 0).toFixed(2)}x`,                desc: "95th percentile slowdown." },
];

const App = {
    state: "SETUP", // SETUP | RUNNING | RESULTS
    summaryData: [],
    worklogData: [],
    timeseriesCache: {},
    currentResult: null,
    lastSweepRunKeys: [],
    themeMode: "dark",
    THEME_STORAGE_KEY: "cqtwin_theme_mode_v1",

    async init() {
        this.initTheme();
        this.setupTabs();
        await this.loadHistorical();
        Setup.init();
        Online.init();
        Worklog.init(this.worklogData);
        const route = this.readRoute();
        if (route.tab && route.tab !== "setup") {
            this.setState("RESULTS");
            this.activateTab(route.tab);
        } else {
            this.setState("SETUP");
        }
    },

    setState(newState) {
        this.state = newState;
        const wizard = document.getElementById("setup-wizard");
        const overlay = document.getElementById("progress-overlay");
        const nav = document.getElementById("tabs");
        const mainEl = document.querySelector("main");
        const newRunBtn = document.getElementById("btn-new-run");

        wizard.classList.toggle("hidden", newState !== "SETUP");
        overlay.classList.toggle("hidden", newState !== "RUNNING");
        nav.classList.toggle("hidden", newState === "SETUP" || newState === "RUNNING");
        mainEl.classList.toggle("hidden", newState === "SETUP" || newState === "RUNNING");
        newRunBtn.classList.toggle("hidden", newState !== "RESULTS");

        if (newState === "RESULTS") {
            document.querySelector('.tab[data-tab="overview"]').click();
            Overview.init(this.currentResult);
        }
    },

    setResultData(result) {
        this.currentResult = result;

        const fallback = this._deriveFromJobTrace(result?.params?.job_trace);
        const meta = Object.assign({}, fallback, result?.meta || {});
        const runName = meta.run_name || this.runName(meta.system || "custom", meta.variant || "custom");

        const summary = Object.assign({}, result.summary || {});
        summary.run_name = runName;
        summary.system = summary.system || meta.system || "custom";
        summary.variant = summary.variant || meta.variant || "custom";
        summary.scenario = summary.scenario || meta.scenario || "";

        this.summaryData = this.summaryData.filter(d => this.runKey(d) !== runName);
        this.summaryData.push(summary);

        if (result.timeseries) this.timeseriesCache[runName] = result.timeseries;
        if (result.scatter) this.timeseriesCache[runName + "_scatter"] = result.scatter;

        fetch("data/worklog.json")
            .then(r => (r.ok ? r.json() : []))
            .then(wl => {
                this.worklogData = wl || [];
                Worklog.init(this.worklogData);
            })
            .catch(() => {});
    },

    async loadHistorical({ fast = true } = {}) {
        const fetchHistorical = async useFast => {
            const qs = useFast ? "?fast=1" : "";
            return fetch(`/api/historical${qs}`).then(r => (r.ok ? r.json() : null));
        };

        try {
            let payload = await fetchHistorical(Boolean(fast));
            if (fast && payload && !payload.error) {
                const summaryCount = Array.isArray(payload.summary) ? payload.summary.length : 0;
                const worklogCount = Array.isArray(payload.worklog) ? payload.worklog.length : 0;
                const inconsistent = (summaryCount === 0) !== (worklogCount === 0);
                const bothEmpty = summaryCount === 0 && worklogCount === 0;
                if (inconsistent || bothEmpty) {
                    payload = await fetchHistorical(false);
                }
            }
            if (payload && !payload.error) {
                const hydrated = this._hydrateHistorical(payload.summary || [], payload.worklog || []);
                this.summaryData = hydrated.summary;
                this.worklogData = hydrated.worklog;
                return;
            }

            // Fallback for static hosting / older backend.
            const [summary, worklog] = await Promise.all([
                fetch("data/summary.json").then(r => (r.ok ? r.json() : [])),
                fetch("data/worklog.json").then(r => (r.ok ? r.json() : [])),
            ]);
            const hydrated = this._hydrateHistorical(summary || [], worklog || []);
            this.summaryData = hydrated.summary;
            this.worklogData = hydrated.worklog;
        } catch {
            this.summaryData = [];
            this.worklogData = [];
        }
    },

    _hydrateHistorical(summaryRows, worklogRows) {
        const worklog = Array.isArray(worklogRows) ? worklogRows : [];
        const summary = Array.isArray(summaryRows)
            ? summaryRows.map(d => this.normalizeSummaryEntry(d))
            : [];

        const byRun = new Map(summary.map(row => [this.runKey(row), row]));
        for (const fallback of this._summaryFromWorklog(worklog)) {
            const key = this.runKey(fallback);
            if (!byRun.has(key)) {
                byRun.set(key, fallback);
            }
        }

        return {
            summary: [...byRun.values()],
            worklog,
        };
    },

    _summaryFromWorklog(worklogRows) {
        if (!Array.isArray(worklogRows) || !worklogRows.length) return [];

        const latestByRun = new Map();
        for (const row of worklogRows) {
            if (!row || typeof row !== "object") continue;
            const runName = String(row.run_name || "").trim();
            if (!runName) continue;
            const prev = latestByRun.get(runName);
            if (!prev || String(row.timestamp || "") > String(prev.timestamp || "")) {
                latestByRun.set(runName, row);
            }
        }

        const out = [];
        for (const row of latestByRun.values()) {
            out.push(this.normalizeSummaryEntry({
                run_name: String(row.run_name || ""),
                timestamp: String(row.timestamp || ""),
                system: String(row.system || ""),
                variant: String(row.variant || "default_config"),
                trace_variant: String(row.trace_variant || "custom"),
                scenario: String(row.scenario || ""),
                algorithm: String(row.algorithm || ""),
                backfill: Number.isFinite(Number(row.backfill_id)) ? Number(row.backfill_id) : 2,
                win: Number.isFinite(Number(row.win)) ? Number(row.win) : 5,
                read_num: Number.isFinite(Number(row.read_num)) ? Number(row.read_num) : -1,
                total_jobs: Number(row.total_jobs || 0) || 0,
                avg_wait: Number(row.avg_wait || 0) || 0,
                wait_p95: Number(row.wait_p95 || 0) || 0,
                avg_utilization: Number(row.avg_utilization || 0) || 0,
                peak_queue_depth: Number(row.peak_queue_depth || 0) || 0,
                makespan: Number(row.makespan || 0) || 0,
            }));
        }
        return out;
    },

    async fetchRun(name, { lite = true, includeScatter = false } = {}) {
        if (!name) return null;
        const params = new URLSearchParams();
        if (!lite) params.set("lite", "0");
        if (includeScatter) params.set("include_scatter", "1");
        const qs = params.toString();
        const url = `/api/load/${encodeURIComponent(name)}${qs ? `?${qs}` : ""}`;
        const payload = await fetch(url, { cache: "no-store" }).then(r => r.json());
        if (payload?.error) throw new Error(payload.error);
        return payload;
    },

    setupTabs() {
        document.querySelectorAll(".tab").forEach(btn => {
            btn.addEventListener("click", () => {
                document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
                document.querySelectorAll(".tab-content").forEach(s => s.classList.remove("active"));
                btn.classList.add("active");
                document.getElementById("tab-" + btn.dataset.tab).classList.add("active");

                const tab = btn.dataset.tab;
                this.writeRoute({ tab, keepFork: tab === "snapshot" });
                // Online works without an offline result loaded, so it refreshes
                // regardless of state; the rest need summaryData (RESULTS only).
                if (tab === "online") Online.onShow();
                if (this.state === "RESULTS") {
                    if (tab === "system") System.init(this.summaryData);
                    if (tab === "snapshot") SnapShot.init(this.summaryData);
                    if (tab === "makespan") MakespanLab.init(this.summaryData);
                    if (tab === "compare") Compare.init(this.summaryData);
                }
            });
        });

        document.getElementById("btn-new-run").addEventListener("click", () => {
            this.writeRoute({ tab: "", keepFork: false });
            this.setState("SETUP");
        });
    },

    readRoute() {
        try {
            const params = new URLSearchParams(window.location.search);
            let tab = params.get("tab") || "";
            if (tab === "operator") tab = "snapshot";  // back-compat: renamed tab
            return {
                tab,
                fork: params.get("fork") || "",
            };
        } catch {
            return { tab: "", fork: "" };
        }
    },

    writeRoute({ tab = "", keepFork = false } = {}) {
        try {
            const url = new URL(window.location.href);
            if (tab) url.searchParams.set("tab", tab);
            else url.searchParams.delete("tab");
            if (!keepFork) url.searchParams.delete("fork");
            window.history.replaceState({}, "", url.toString());
        } catch {}
    },

    activateTab(tab) {
        const key = String(tab || "").trim().toLowerCase();
        const btn = document.querySelector(`.tab[data-tab="${key}"]`);
        if (btn) btn.click();
    },

    // Enter the Online workspace from the setup wizard. Reveals the tab bar +
    // main area (like RESULTS) but does NOT require an offline result to exist —
    // the Online tab is self-contained. Offline tabs stay reachable if data is
    // loaded; empty otherwise, which is expected when you come straight here.
    enterOnline() {
        document.getElementById("setup-wizard").classList.add("hidden");
        document.getElementById("progress-overlay").classList.add("hidden");
        document.getElementById("tabs").classList.remove("hidden");
        document.querySelector("main").classList.remove("hidden");
        document.getElementById("btn-new-run").classList.remove("hidden");
        this.state = "RESULTS";
        this.activateTab("online");
    },

    initTheme() {
        let stored = "dark";
        try {
            stored = String(localStorage.getItem(this.THEME_STORAGE_KEY) || "dark").toLowerCase();
        } catch {
            stored = "dark";
        }

        this.setTheme(stored === "light" ? "light" : "dark", { persist: false, rerender: false });

        const btn = document.getElementById("btn-theme-toggle");
        if (btn && !btn.dataset.boundThemeToggle) {
            btn.dataset.boundThemeToggle = "1";
            btn.addEventListener("click", () => this.toggleTheme());
        }
        this._syncThemeToggle();
    },

    toggleTheme() {
        this.setTheme(this.themeMode === "light" ? "dark" : "light");
    },

    setTheme(mode, { persist = true, rerender = true } = {}) {
        const next = String(mode || "").toLowerCase() === "light" ? "light" : "dark";
        this.themeMode = next;

        const body = document.body;
        if (body) {
            body.classList.toggle("light-theme", next === "light");
            if (next !== "light") {
                body.classList.remove("export-light");
            }
        }

        if (persist) {
            try {
                localStorage.setItem(this.THEME_STORAGE_KEY, next);
            } catch {}
        }

        this._syncThemeToggle();
        if (rerender) this.rerenderForTheme();
    },

    _syncThemeToggle() {
        const btn = document.getElementById("btn-theme-toggle");
        if (!btn) return;
        const isLight = this.themeMode === "light";
        btn.setAttribute("aria-pressed", isLight ? "true" : "false");
        btn.setAttribute("title", isLight ? "Switch to dark mode" : "Switch to light mode");
    },

    rerenderForTheme() {
        const activeTab = document.querySelector(".tab.active")?.dataset?.tab || "";

        if (this.state === "RESULTS" && this.currentResult) {
            Overview.init(this.currentResult);
        }
        if (activeTab === "system") {
            System.init(this.summaryData);
        }
        if (activeTab === "snapshot") {
            SnapShot.init(this.summaryData);
        }
        if (activeTab === "makespan") {
            MakespanLab.init(this.summaryData);
        }
        if (activeTab === "compare") {
            Compare.init(this.summaryData);
        }
        if (activeTab === "worklog") {
            Worklog.init(this.worklogData);
            if (typeof Worklog.rerenderCachedAnalysis === "function") {
                Worklog.rerenderCachedAnalysis();
            }
        }
    },

    normalizeSummaryEntry(d) {
        const out = Object.assign({}, d || {});
        const fallback = this._deriveFromRunName(out.run_name || this.runName(out.system || "custom", out.variant || "custom"));
        out.run_name = out.run_name || fallback.run_name;
        out.system = out.system || fallback.system;
        out.variant = out.variant || fallback.variant;
        out.scenario = out.scenario || fallback.scenario || "";
        return out;
    },

    _deriveFromJobTrace(jobTrace) {
        const stem = (jobTrace || "custom").replace(/\.swf$/i, "");
        return this._deriveFromRunName(stem);
    },

    _deriveFromRunName(runName) {
        const name = (runName || "custom").trim();
        const parts = name.split("__");
        const base = parts[0] || "custom";
        const scenario = parts.slice(1).join("__").replace(/_/g, " ").trim();

        const low = base.toLowerCase();
        let system = base;
        const variant = "default_config";
        if (low.endsWith("_p90")) {
            system = base.slice(0, -4);
        } else if (low.endsWith("_p95")) {
            system = base.slice(0, -4);
        } else if (low.endsWith("_norm")) {
            system = base.slice(0, -5);
        }

        return { run_name: name, system, variant, scenario };
    },

    runKey(d) {
        if (!d) return "";
        return d.run_name || this.runName(d.system || "custom", d.variant || "custom");
    },

    runLabel(d) {
        if (!d) return "unknown";
        const rawVariant = String(d.variant || "default_config");
        const variant = (rawVariant === "unknown_config" || rawVariant === "default_config")
            ? "default config"
            : rawVariant;
        const main = `${d.system || "custom"} (${variant})`;
        const tail = (d.scenario || "").trim();
        return tail ? `${main} | ${tail}` : main;
    },

    runBaseLabel(d) {
        if (!d) return "unknown";
        const rawVariant = String(d.variant || "default_config");
        const variant = (rawVariant === "unknown_config" || rawVariant === "default_config")
            ? "default config"
            : rawVariant;
        return `${d.system || "custom"} (${variant})`;
    },

    runFullLabel(d) {
        const key = this.runKey(d);
        return `${this.runBaseLabel(d)} [${key}]`;
    },

    runName(system, variant) {
        const s = system || "custom";
        const v = variant || "default_config";
        return `${s}_${v}`;
    },

    async loadTimeseries(name) {
        if (!name) return null;
        if (this.timeseriesCache[name]) return this.timeseriesCache[name];
        try {
            const d = await fetch(`data/timeseries/${name}.json`).then(r => (r.ok ? r.json() : null));
            if (d) this.timeseriesCache[name] = d;
            return d;
        } catch {
            return null;
        }
    },

    async loadScatter(name) {
        const key = name + "_scatter";
        if (!name) return null;
        if (this.timeseriesCache[key]) return this.timeseriesCache[key];
        try {
            const d = await fetch(`data/timeseries/${name}_scatter.json`).then(r => (r.ok ? r.json() : null));
            if (d) this.timeseriesCache[key] = d;
            return d;
        } catch {
            return null;
        }
    },

    formatTime(seconds) {
        const s = Number(seconds);
        if (!Number.isFinite(s)) return "-";
        if (Math.abs(s) < 60) return `${s.toFixed(2)}s`;
        if (Math.abs(s) < 3600) return `${(s / 60).toFixed(2)}m`;
        if (Math.abs(s) < 86400) return `${(s / 3600).toFixed(2)}h`;
        return `${(s / 86400).toFixed(2)}d`;
    },

    formatNum(n) {
        const v = Number(n);
        if (!Number.isFinite(v)) return String(n);
        if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
        if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
        if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
        return v.toFixed(2);
    },

    isExportLight() {
        const cls = document?.body?.classList;
        return !!(cls?.contains("light-theme") || cls?.contains("export-light"));
    },

    chartTheme() {
        if (this.isExportLight()) {
            return {
                legendText: "#41586a",
                tick: "#5b7385",
                axisTitle: "#223645",
                grid: "rgba(53, 79, 98, 0.16)",
                tooltipTitle: "#152432",
                tooltipBody: "#344a5b",
                tooltipBg: "rgba(255, 255, 255, 0.98)",
                tooltipBorder: "#cfdbe5",
                tooltipText: "#223645",
                canvasText: "#1d3444",
                canvasMuted: "#5b7385",
                canvasBorder: "rgba(62, 89, 108, 0.22)",
                canvasEmpty: "#f4f8fb",
                canvasLabelLight: "#ffffff",
                canvasLabelDark: "#193040",
            };
        }

        return {
            legendText: "#a6c3d7",
            tick: "#8aaec4",
            axisTitle: "#9ebcd0",
            grid: "#1d374b",
            tooltipTitle: "#e9f8ff",
            tooltipBody: "#d9edf8",
            tooltipBg: "rgba(7, 20, 32, 0.92)",
            tooltipBorder: "#2b4f68",
            tooltipText: "#e9f8ff",
            canvasText: "#8fb2c8",
            canvasMuted: "#93b5ca",
            canvasBorder: "rgba(101, 138, 163, 0.24)",
            canvasEmpty: "rgba(9, 24, 36, 0.9)",
            canvasLabelLight: "#f5fbff",
            canvasLabelDark: "#0d2435",
        };
    },

    COLORS: [
        "#2dd4bf", "#f59e0b", "#38bdf8", "#fb7185", "#a3e635",
        "#f97316", "#22d3ee", "#34d399", "#facc15", "#818cf8",
        "#60a5fa", "#f472b6", "#4ade80", "#fdba74", "#14b8a6",
        "#93c5fd", "#fda4af", "#bef264",
    ],

    chartDefaults(extra = {}) {
        const theme = this.chartTheme();
        return Object.assign({
            responsive: true,
            maintainAspectRatio: true,
            aspectRatio: 2.3,
            animation: false,
            plugins: {
                legend: { labels: { color: theme.legendText, font: { size: 11, family: "Space Grotesk" } } },
                tooltip: {
                    titleColor: theme.tooltipTitle,
                    bodyColor: theme.tooltipBody,
                    backgroundColor: theme.tooltipBg,
                    borderColor: theme.tooltipBorder,
                    borderWidth: 1,
                },
            },
            scales: {
                x: { ticks: { color: theme.tick, font: { size: 10 } }, grid: { color: theme.grid } },
                y: { ticks: { color: theme.tick, font: { size: 10 } }, grid: { color: theme.grid } },
            },
        }, extra);
    },

    enableLineChartZoom(chart, opts = {}) {
        if (!chart || !chart.canvas) return;
        const canvas = chart.canvas;

        if (typeof canvas.__cqZoomCleanup === "function") {
            canvas.__cqZoomCleanup();
        }

        const xScaleId = opts.xScaleId || "x";
        const minWindow = Math.max(4, Number(opts.minWindow || 10));
        const zoomFactor = Math.max(0.1, Math.min(0.9, Number(opts.zoomFactor || 0.5)));

        const getScale = () => chart.scales?.[xScaleId] || chart.scales?.x || null;
        const getLabels = () => (Array.isArray(chart.data?.labels) ? chart.data.labels : []);

        const toIndex = (value, labels, fallback) => {
            if (Number.isFinite(value)) return Math.round(value);
            if (typeof value === "string") {
                const idx = labels.indexOf(value);
                if (idx >= 0) return idx;
            }
            return fallback;
        };

        const getVisibleRange = (scale, labels) => {
            const n = labels.length;
            let min = toIndex(scale?.min, labels, 0);
            let max = toIndex(scale?.max, labels, n - 1);
            min = Math.max(0, Math.min(n - 1, min));
            max = Math.max(0, Math.min(n - 1, max));
            if (max < min) [min, max] = [max, min];
            return { min, max };
        };

        const resetZoom = () => {
            const scale = getScale();
            if (!scale) return;
            scale.options.min = undefined;
            scale.options.max = undefined;
            chart.update("none");
        };

        const zoomAtEvent = evt => {
            const labels = getLabels();
            const n = labels.length;
            if (!n) return;

            const scale = getScale();
            if (!scale) return;

            const nearest = chart.getElementsAtEventForMode(
                evt,
                "nearest",
                { intersect: false },
                false
            );

            let centerIdx = Number.isFinite(nearest?.[0]?.index) ? nearest[0].index : null;
            if (!Number.isFinite(centerIdx)) {
                const raw = scale.getValueForPixel(evt.offsetX);
                centerIdx = toIndex(raw, labels, null);
            }
            if (!Number.isFinite(centerIdx)) return;
            centerIdx = Math.max(0, Math.min(n - 1, Math.round(centerIdx)));

            const { min: curMin, max: curMax } = getVisibleRange(scale, labels);
            const curSpan = curMax - curMin + 1;
            if (curSpan <= minWindow + 1) return;

            const targetSpan = Math.max(minWindow, Math.floor(curSpan * zoomFactor));
            let nextMin = centerIdx - Math.floor(targetSpan / 2);
            let nextMax = nextMin + targetSpan - 1;

            if (nextMin < 0) {
                nextMax -= nextMin;
                nextMin = 0;
            }
            if (nextMax > n - 1) {
                const shift = nextMax - (n - 1);
                nextMin = Math.max(0, nextMin - shift);
                nextMax = n - 1;
            }

            if (nextMax - nextMin + 1 >= curSpan) return;
            scale.options.min = nextMin;
            scale.options.max = nextMax;
            chart.update("none");
        };

        const onClick = evt => {
            if (evt.shiftKey) {
                resetZoom();
                return;
            }
            zoomAtEvent(evt);
        };
        const onDblClick = evt => {
            evt.preventDefault();
            resetZoom();
        };
        const onContextMenu = evt => {
            evt.preventDefault();
            resetZoom();
        };

        canvas.addEventListener("click", onClick);
        canvas.addEventListener("dblclick", onDblClick);
        canvas.addEventListener("contextmenu", onContextMenu);
        canvas.style.cursor = "zoom-in";
        canvas.title = "Click to zoom, Shift+click / double-click / right-click to reset";

        canvas.__cqZoomCleanup = () => {
            canvas.removeEventListener("click", onClick);
            canvas.removeEventListener("dblclick", onDblClick);
            canvas.removeEventListener("contextmenu", onContextMenu);
            delete canvas.__cqZoomCleanup;
        };
    },
};

document.addEventListener("DOMContentLoaded", () => App.init());
