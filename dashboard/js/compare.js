/* compare.js - Compare tab: run picker, selected set, metric and overlay charts */

const _clipLabelPlugin = {
    id: "clipLabels",
    afterDatasetDraw(chart) {
        const { ctx, scales } = chart;
        if (!scales.y) return;
        const yMax = scales.y.max;

        chart.data.datasets.forEach((dataset, di) => {
            const meta = chart.getDatasetMeta(di);
            meta.data.forEach((bar, idx) => {
                const val = dataset.data[idx];
                if (val > yMax) {
                    ctx.save();
                    ctx.fillStyle = "#fb923c";
                    ctx.font = "bold 10px Space Grotesk";
                    ctx.textAlign = "center";
                    ctx.fillText(dataset._labels?.[idx] ?? String(val), bar.x, scales.y.top + 13);
                    ctx.restore();
                }
            });
        });
    },
};

const _CUSTOM_METRIC_STORAGE_KEY = "cqsimlive_compare_custom_metrics_v1";

const Compare = {
    charts: {},
    data: [],
    selectedKeys: [],
    customMetrics: [],
    _defaultMetricOptions: [],
    _latestContextByKey: new Map(),
    _bound: false,
    _draggingKey: "",
    _availablePage: 1,
    _selectedPage: 1,
    _updateSeq: 0,

    _windowMode: "percent",
    _windowStartPct: 0,
    _windowEndPct: 100,
    _windowMaxSec: 0,

    _overlayNormalizeX: false,
    _overlayAlign: "first_submit",
    _overlaySmoothing: 0.15,
    _overlayBand: false,

    _paretoXMetric: "avg_wait",
    _paretoYMetric: "avg_utilization",
    _paretoXGoal: "min",
    _paretoYGoal: "max",

    _safeMax(values, fallback = 0) {
        let best = Number(fallback || 0);
        if (!Array.isArray(values)) return best;
        for (let i = 0; i < values.length; i++) {
            const v = Number(values[i]);
            if (Number.isFinite(v) && v > best) best = v;
        }
        return best;
    },

    _safeMaxBy(values, selector, fallback = 0) {
        let best = Number(fallback || 0);
        if (!Array.isArray(values)) return best;
        for (let i = 0; i < values.length; i++) {
            const v = Number(selector(values[i], i));
            if (Number.isFinite(v) && v > best) best = v;
        }
        return best;
    },

    init(data) {
        // Online-advisory runs are deliberately excluded from the offline overlay:
        // mixing projected and realized waits in one chart invites misreading. They
        // open in their own view (the Overview advisory panel).
        const rawRows = (data || []).filter(d => (d && d.run_type || "offline") !== "online_advisory");
        this.data = rawRows.map(d => App.normalizeSummaryEntry(d));
        this._captureDefaultMetricOptions();
        this._loadCustomMetrics();

        const validKeys = new Set(this.data.map(d => App.runKey(d)));
        const sweepKeys = Array.isArray(App.lastSweepRunKeys)
            ? App.lastSweepRunKeys.filter(k => validKeys.has(k))
            : [];

        if (sweepKeys.length) {
            this.selectedKeys = sweepKeys.slice(0, 16);
            App.lastSweepRunKeys = [];
        } else {
            this.selectedKeys = this.selectedKeys.filter(k => validKeys.has(k));
            if (!this.selectedKeys.length) {
                this.selectedKeys = this.data.slice(0, Math.min(4, this.data.length)).map(d => App.runKey(d));
            }
        }

        this.populateSystems();
        this.populateRunPicker();
        this.renderSelectedRuns();
        this._refreshMetricSelect();
        this._refreshParetoMetricSelects();
        this.populateBaseline();
        this._syncAdvancedControlsToState();
        this._syncParetoControlsToState();
        this.bind();
        this.update();
    },

    _esc(s) {
        return String(s ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\"/g, "&quot;")
            .replace(/'/g, "&#39;");
    },

    _parsePositiveInt(value, fallback) {
        const n = parseInt(value, 10);
        return Number.isFinite(n) && n > 0 ? n : fallback;
    },

    _captureDefaultMetricOptions() {
        if (this._defaultMetricOptions.length) return;
        const sel = document.getElementById("compare-metric");
        if (!sel) return;
        this._defaultMetricOptions = Array.from(sel.options || []).map(opt => ({
            value: String(opt.value || ""),
            label: String(opt.textContent || opt.value || ""),
        }));
    },

    _allMetricOptions() {
        const opts = this._defaultMetricOptions.slice();
        for (const metric of this.customMetrics) {
            opts.push({
                value: `custom:${metric.id}`,
                label: String(metric.name || metric.id || "Custom Metric"),
            });
        }
        return opts;
    },

    _metricLabel(metricKey) {
        const target = String(metricKey || "");
        const match = this._allMetricOptions().find(opt => opt.value === target);
        return match?.label || target || "Metric";
    },

    _fillMetricSelect(sel, preferredValue, fallbackValue) {
        if (!sel) return;
        const options = this._allMetricOptions();
        const current = preferredValue || sel.value || fallbackValue || options[0]?.value || "avg_wait";
        sel.innerHTML = options
            .map(opt => `<option value="${this._esc(opt.value)}">${this._esc(opt.label)}</option>`)
            .join("");

        const allValues = options.map(opt => opt.value);
        sel.value = allValues.includes(current)
            ? current
            : (allValues.includes(fallbackValue) ? fallbackValue : (allValues[0] || "avg_wait"));
    },

    _allRunsSorted() {
        return this.data.slice().sort((a, b) => App.runLabel(a).localeCompare(App.runLabel(b)));
    },

    _getRunByKey(key) {
        return this.data.find(d => App.runKey(d) === key) || null;
    },

    _fullRunLabel(d) {
        return App.runFullLabel(d);
    },

    _policyLabel(d) {
        const raw = String(d?.algorithm || d?.alg || d?.variant || "").trim();
        if (!raw) return String(d?.system || "run");
        return raw.split("_")[0].toUpperCase();
    },

    _availableSearchQuery() {
        const el = document.getElementById("compare-run-search");
        return String(el?.value || "").trim().toLowerCase();
    },

    _selectedSearchQuery() {
        const el = document.getElementById("compare-selected-search");
        return String(el?.value || "").trim().toLowerCase();
    },

    populateSystems() {
        const sel = document.getElementById("compare-system-select");
        if (!sel) return;
        const prev = sel.value;

        const systems = [...new Set(this.data.map(d => d.system || "unknown"))].sort();
        sel.innerHTML = '<option value="all">All</option>' +
            systems.map(s => `<option value="${this._esc(s)}">${this._esc(s)}</option>`).join("");

        if (prev === "all" || systems.includes(prev)) {
            sel.value = prev || "all";
        } else {
            sel.value = "all";
        }
    },

    populateRunPicker() {
        const sel = document.getElementById("compare-run-picker");
        if (!sel) return;

        const addBtn = document.getElementById("btn-compare-add");
        const systemSel = document.getElementById("compare-system-select");
        const pageSel = document.getElementById("compare-run-page");
        const pageSizeSel = document.getElementById("compare-run-page-size");
        const countEl = document.getElementById("compare-run-count");

        const systemFilter = systemSel ? (systemSel.value || "all") : "all";
        const q = this._availableSearchQuery();
        const used = new Set(this.selectedKeys);
        const seen = new Set();
        const options = [];
        const prev = sel.value;

        for (const d of this._allRunsSorted()) {
            if (systemFilter !== "all" && (d.system || "unknown") !== systemFilter) continue;
            const key = App.runKey(d);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            const label = this._fullRunLabel(d);
            if (q && !label.toLowerCase().includes(q)) continue;
            options.push({ key, label });
        }

        const pageSize = this._parsePositiveInt(pageSizeSel?.value, 50);
        const pageCount = Math.max(1, Math.ceil(options.length / pageSize));
        const requestedPage = this._parsePositiveInt(pageSel?.value || this._availablePage, 1);
        const page = Math.min(pageCount, Math.max(1, requestedPage));
        this._availablePage = page;

        if (pageSel) {
            pageSel.innerHTML = Array.from({ length: pageCount }, (_, i) => {
                const p = i + 1;
                return `<option value="${p}">${p}/${pageCount}</option>`;
            }).join("");
            pageSel.value = String(page);
            pageSel.disabled = options.length === 0;
        }

        const start = (page - 1) * pageSize;
        const pageOptions = options.slice(start, start + pageSize);

        sel.innerHTML = pageOptions.map(o => {
            const isUsed = used.has(o.key);
            return `<option value="${this._esc(o.key)}" ${isUsed ? "disabled" : ""}>${this._esc(o.label)}${isUsed ? " (Added)" : ""}</option>`;
        }).join("");

        const available = pageOptions.filter(o => !used.has(o.key));
        addBtn.disabled = !available.length;
        sel.disabled = !pageOptions.length;

        if (pageOptions.some(o => o.key === prev && !used.has(o.key))) {
            sel.value = prev;
        } else if (available.length) {
            sel.value = available[0].key;
        } else if (pageOptions.length) {
            sel.value = pageOptions[0].key;
        } else {
            sel.innerHTML = '<option value="">No runs match current filter</option>';
            sel.value = "";
        }

        if (countEl) {
            const shownFrom = pageOptions.length ? start + 1 : 0;
            const shownTo = start + pageOptions.length;
            countEl.textContent =
                `Showing ${shownFrom}-${shownTo} of ${options.length}` +
                (q ? " filtered" : "");
        }
    },

    populateBaseline() {
        const sel = document.getElementById("compare-baseline");
        const prev = sel.value;
        const selectedRuns = this.getSelectedRuns();

        if (!selectedRuns.length) {
            sel.innerHTML = '<option value="">Select runs first</option>';
            sel.disabled = true;
            return;
        }

        sel.disabled = false;
        sel.innerHTML = selectedRuns.map(d => {
            const key = App.runKey(d);
            return `<option value="${this._esc(key)}">${this._esc(this._fullRunLabel(d))}</option>`;
        }).join("");

        if (prev && selectedRuns.some(d => App.runKey(d) === prev)) {
            sel.value = prev;
        } else {
            sel.value = App.runKey(selectedRuns[0]);
        }
    },

    renderSelectedRuns() {
        const box = document.getElementById("compare-selected");
        const pageSel = document.getElementById("compare-selected-page");
        const pageSizeSel = document.getElementById("compare-selected-page-size");
        const countEl = document.getElementById("compare-selected-count");
        const q = this._selectedSearchQuery();
        const selectedRuns = this.getSelectedRuns();

        if (!selectedRuns.length) {
            box.innerHTML = '<div class="compare-chip-empty">No runs selected. Pick one from the dropdown and click Add Run.</div>';
            if (pageSel) {
                pageSel.innerHTML = '<option value="1">1/1</option>';
                pageSel.value = "1";
                pageSel.disabled = true;
            }
            if (countEl) countEl.textContent = "";
            return;
        }

        const filteredRuns = q
            ? selectedRuns.filter(d => this._fullRunLabel(d).toLowerCase().includes(q))
            : selectedRuns;

        const pageSize = this._parsePositiveInt(pageSizeSel?.value, 16);
        const pageCount = Math.max(1, Math.ceil(filteredRuns.length / pageSize));
        const requestedPage = this._parsePositiveInt(pageSel?.value || this._selectedPage, 1);
        const page = Math.min(pageCount, Math.max(1, requestedPage));
        this._selectedPage = page;

        if (pageSel) {
            pageSel.innerHTML = Array.from({ length: pageCount }, (_, i) => {
                const p = i + 1;
                return `<option value="${p}">${p}/${pageCount}</option>`;
            }).join("");
            pageSel.value = String(page);
            pageSel.disabled = filteredRuns.length === 0;
        }

        const start = (page - 1) * pageSize;
        const pageRuns = filteredRuns.slice(start, start + pageSize);

        if (!pageRuns.length) {
            box.innerHTML = '<div class="compare-chip-empty">No selected runs match the current filter.</div>';
        } else {
            box.innerHTML = pageRuns.map(d => {
                const key = App.runKey(d);
                const label = this._fullRunLabel(d);
                return `
                    <div class="compare-chip" draggable="true" data-run-key="${this._esc(key)}" title="Drag to reorder">
                        <span>${this._esc(label)}</span>
                        <button type="button" data-remove-run="${this._esc(key)}" title="Remove run" draggable="false">x</button>
                    </div>
                `;
            }).join("");
        }

        if (countEl) {
            const shownFrom = pageRuns.length ? start + 1 : 0;
            const shownTo = start + pageRuns.length;
            countEl.textContent =
                `Showing ${shownFrom}-${shownTo} of ${filteredRuns.length}` +
                (q ? ` filtered (${selectedRuns.length} selected)` : " selected");
        }
    },

    _clearDragHints(exceptEl = null) {
        const box = document.getElementById("compare-selected");
        if (!box) return;
        box.querySelectorAll(".compare-chip.drop-before, .compare-chip.drop-after, .compare-chip.dragging").forEach(el => {
            if (exceptEl && el === exceptEl) return;
            el.classList.remove("drop-before", "drop-after", "dragging");
        });
    },

    addSelectedRun(runKey) {
        const key = String(runKey || "").trim();
        if (!key || this.selectedKeys.includes(key)) return;
        if (!this._getRunByKey(key)) return;
        this.selectedKeys.push(key);
        this._afterSelectionChanged();
    },

    removeSelectedRun(runKey) {
        const key = String(runKey || "").trim();
        if (!key) return;
        this.selectedKeys = this.selectedKeys.filter(k => k !== key);
        this._afterSelectionChanged();
    },

    clearSelectedRuns() {
        this.selectedKeys = [];
        this._afterSelectionChanged();
    },

    _reorderSelectedKeys(fromKey, toKey, placeAfter = false) {
        const from = String(fromKey || "").trim();
        const to = String(toKey || "").trim();
        if (!from || !to || from === to) return;

        const fromIdx = this.selectedKeys.indexOf(from);
        const toIdx = this.selectedKeys.indexOf(to);
        if (fromIdx < 0 || toIdx < 0) return;

        const [moved] = this.selectedKeys.splice(fromIdx, 1);
        let insertIdx;
        if (placeAfter) {
            insertIdx = fromIdx < toIdx ? toIdx : toIdx + 1;
        } else {
            insertIdx = fromIdx < toIdx ? toIdx - 1 : toIdx;
        }
        if (insertIdx < 0) insertIdx = 0;
        if (insertIdx > this.selectedKeys.length) insertIdx = this.selectedKeys.length;
        this.selectedKeys.splice(insertIdx, 0, moved);
        this._afterSelectionChanged();
    },

    _moveSelectedKeyToEnd(runKey) {
        const key = String(runKey || "").trim();
        if (!key) return;
        const idx = this.selectedKeys.indexOf(key);
        if (idx < 0 || idx === this.selectedKeys.length - 1) return;
        const [moved] = this.selectedKeys.splice(idx, 1);
        this.selectedKeys.push(moved);
        this._afterSelectionChanged();
    },

    _afterSelectionChanged() {
        this.populateSystems();
        this.populateRunPicker();
        this.populateBaseline();
        this.renderSelectedRuns();
        this.update();
    },

    getSelectedRuns() {
        return this.selectedKeys.map(k => this._getRunByKey(k)).filter(Boolean);
    },

    _syncAdvancedControlsToState() {
        const modeEl = document.getElementById("compare-window-mode");
        const startRange = document.getElementById("compare-window-start-range");
        const endRange = document.getElementById("compare-window-end-range");
        const startInput = document.getElementById("compare-window-start-input");
        const endInput = document.getElementById("compare-window-end-input");
        const hint = document.getElementById("compare-window-hint");

        if (modeEl) modeEl.value = this._windowMode;
        if (startRange) startRange.value = String(this._windowStartPct);
        if (endRange) endRange.value = String(this._windowEndPct);

        if (this._windowMode === "absolute") {
            const [absStart, absEnd] = this._windowBoundsAbsFromPct();
            if (startInput) {
                startInput.value = String(Math.round(absStart));
                startInput.min = "0";
                startInput.max = String(Math.max(0, Math.round(this._windowMaxSec || 0)));
                startInput.step = "1";
            }
            if (endInput) {
                endInput.value = String(Math.round(absEnd));
                endInput.min = "0";
                endInput.max = String(Math.max(0, Math.round(this._windowMaxSec || 0)));
                endInput.step = "1";
            }
        } else {
            if (startInput) {
                startInput.value = String(this._windowStartPct);
                startInput.min = "0";
                startInput.max = "100";
                startInput.step = "1";
            }
            if (endInput) {
                endInput.value = String(this._windowEndPct);
                endInput.min = "0";
                endInput.max = "100";
                endInput.step = "1";
            }
        }

        const smoothEl = document.getElementById("compare-overlay-smooth");
        const smoothValEl = document.getElementById("compare-overlay-smooth-val");
        const normalizeEl = document.getElementById("compare-overlay-normalize");
        const alignEl = document.getElementById("compare-overlay-align");
        const bandEl = document.getElementById("compare-overlay-band");

        if (normalizeEl) normalizeEl.checked = !!this._overlayNormalizeX;
        if (alignEl) alignEl.value = this._overlayAlign;
        if (bandEl) bandEl.checked = !!this._overlayBand;
        if (smoothEl) smoothEl.value = String(this._overlaySmoothing);
        if (smoothValEl) smoothValEl.textContent = Number(this._overlaySmoothing).toFixed(2);

        if (hint) {
            const modeLabel = this._windowMode === "absolute" ? "absolute seconds" : "percent of each run makespan";
            hint.textContent = `Window: ${this._windowStartPct}% -> ${this._windowEndPct}% (${modeLabel}). Reference max makespan: ${App.formatTime(this._windowMaxSec || 0)}.`;
        }
    },

    _syncParetoControlsToState() {
        const xSel = document.getElementById("compare-pareto-x");
        const ySel = document.getElementById("compare-pareto-y");
        const xGoalSel = document.getElementById("compare-pareto-x-goal");
        const yGoalSel = document.getElementById("compare-pareto-y-goal");

        if (xSel) xSel.value = this._paretoXMetric;
        if (ySel) ySel.value = this._paretoYMetric;
        if (xGoalSel) xGoalSel.value = this._paretoXGoal;
        if (yGoalSel) yGoalSel.value = this._paretoYGoal;
    },

    _setWindowPct(startPct, endPct) {
        let s = Math.max(0, Math.min(100, Math.round(Number(startPct) || 0)));
        let e = Math.max(0, Math.min(100, Math.round(Number(endPct) || 0)));
        if (s > e) {
            const t = s;
            s = e;
            e = t;
        }
        this._windowStartPct = s;
        this._windowEndPct = e;
    },

    _windowBoundsAbsFromPct() {
        const maxSec = Math.max(0, Number(this._windowMaxSec || 0));
        return [
            (this._windowStartPct / 100) * maxSec,
            (this._windowEndPct / 100) * maxSec,
        ];
    },

    _setWindowFromAbsoluteInputs(startAbs, endAbs) {
        const maxSec = Math.max(1, Number(this._windowMaxSec || 1));
        let s = Math.max(0, Math.min(maxSec, Number(startAbs) || 0));
        let e = Math.max(0, Math.min(maxSec, Number(endAbs) || 0));
        if (s > e) {
            const t = s;
            s = e;
            e = t;
        }
        this._setWindowPct((s / maxSec) * 100, (e / maxSec) * 100);
    },

    _windowActive() {
        return this._windowStartPct > 0 || this._windowEndPct < 100;
    },

    _windowBoundsForRun(runEndSec) {
        const end = Math.max(0, Number(runEndSec || 0));
        if (end <= 0) return [0, 0];

        if (this._windowMode === "absolute") {
            const [a0, a1] = this._windowBoundsAbsFromPct();
            const s = Math.max(0, Math.min(end, a0));
            const e = Math.max(0, Math.min(end, a1));
            return s <= e ? [s, e] : [e, s];
        }

        const s = (this._windowStartPct / 100) * end;
        const e = (this._windowEndPct / 100) * end;
        return s <= e ? [s, e] : [e, s];
    },

    _parseTimeLabelToSec(label) {
        const raw = String(label || "").trim();
        const m = raw.match(/^([0-9]*\.?[0-9]+)\s*([smhd])$/i);
        if (!m) return Number.NaN;
        const v = Number(m[1]);
        const u = m[2].toLowerCase();
        if (!Number.isFinite(v)) return Number.NaN;
        if (u === "s") return v;
        if (u === "m") return v * 60;
        if (u === "h") return v * 3600;
        if (u === "d") return v * 86400;
        return Number.NaN;
    },

    _weightedQuantile(values, weights, q) {
        const pairs = [];
        for (let i = 0; i < values.length; i++) {
            const v = Number(values[i]);
            const w = Math.max(0, Number(weights[i]));
            if (!Number.isFinite(v) || w <= 0) continue;
            pairs.push({ v, w });
        }
        if (!pairs.length) return 0;
        pairs.sort((a, b) => a.v - b.v);
        const total = pairs.reduce((s, p) => s + p.w, 0);
        const target = Math.max(0, Math.min(1, Number(q || 0))) * total;

        let acc = 0;
        for (const p of pairs) {
            acc += p.w;
            if (acc >= target) return p.v;
        }
        return pairs[pairs.length - 1].v;
    },

    _waitTimelineWindowMetrics(ts, startSec, endSec, runEndSec) {
        const wt = ts?.wait_timeline || {};
        const avgArr = Array.isArray(wt.avg) ? wt.avg.map(v => Number(v || 0)) : [];
        const p50Arr = Array.isArray(wt.p50) ? wt.p50.map(v => Number(v || 0)) : [];
        const p90Arr = Array.isArray(wt.p90) ? wt.p90.map(v => Number(v || 0)) : [];
        const p99Arr = Array.isArray(wt.p99) ? wt.p99.map(v => Number(v || 0)) : [];
        const cntArr = Array.isArray(wt.count) ? wt.count.map(v => Math.max(0, Number(v || 0))) : [];
        const labels = Array.isArray(wt.labels) ? wt.labels : [];

        const n = Math.max(avgArr.length, p50Arr.length, p90Arr.length, p99Arr.length, cntArr.length);
        if (!n) return null;

        const idxs = [];
        for (let i = 0; i < n; i++) {
            let tSec = Number.NaN;
            if (i < labels.length) tSec = this._parseTimeLabelToSec(labels[i]);
            if (!Number.isFinite(tSec)) {
                tSec = n > 1 ? ((i / (n - 1)) * runEndSec) : 0;
            }
            if (tSec >= startSec && tSec <= endSec) idxs.push(i);
        }
        if (!idxs.length) return null;

        const valsAvg = [];
        const valsP50 = [];
        const valsP90 = [];
        const valsP95 = [];
        const valsP99 = [];
        const ws = [];

        for (const i of idxs) {
            const avg = Number(avgArr[i] || 0);
            const p50 = Number(p50Arr[i] || avg);
            const p90 = Number(p90Arr[i] || p50 || avg);
            const p99 = Number(p99Arr[i] || p90 || p50 || avg);
            const p95 = p90 + (p99 - p90) * (5 / 9);
            const w = Math.max(1, Number(cntArr[i] || 0));

            valsAvg.push(avg);
            valsP50.push(p50);
            valsP90.push(p90);
            valsP95.push(p95);
            valsP99.push(p99);
            ws.push(w);
        }

        const wSum = ws.reduce((s, v) => s + v, 0) || 1;
        const weightedMean = (arr) => arr.reduce((s, v, i) => s + (v * ws[i]), 0) / wSum;

        return {
            avg_wait: weightedMean(valsAvg),
            median_wait: this._weightedQuantile(valsP50, ws, 0.50),
            wait_p90: this._weightedQuantile(valsP90, ws, 0.90),
            wait_p95: this._weightedQuantile(valsP95, ws, 0.95),
            wait_p99: this._weightedQuantile(valsP99, ws, 0.99),
            max_wait: this._safeMax(valsP99, 0),
        };
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
            out.push(src[lo] * (1 - frac) + src[hi] * frac);
        }
        return out;
    },

    _sampleAtProgress(values, progress, fillValue = 0) {
        const src = Array.isArray(values) ? values.map(v => Number(v || 0)) : [];
        if (!src.length) return fillValue;
        if (src.length === 1) return src[0];
        const p = Math.max(0, Math.min(1, Number(progress || 0)));
        const pos = p * (src.length - 1);
        const lo = Math.floor(pos);
        const hi = Math.min(src.length - 1, Math.ceil(pos));
        const frac = pos - lo;
        return src[lo] * (1 - frac) + src[hi] * frac;
    },

    _smoothSeries(data, strength) {
        const src = Array.isArray(data) ? data.slice() : [];
        const s = Math.max(0, Math.min(0.95, Number(strength || 0)));
        const radius = Math.floor(s * 8);
        if (radius <= 0 || !src.length) return src;

        const out = new Array(src.length).fill(null);
        for (let i = 0; i < src.length; i++) {
            if (src[i] == null) continue;
            let sum = 0;
            let cnt = 0;
            for (let j = Math.max(0, i - radius); j <= Math.min(src.length - 1, i + radius); j++) {
                const v = src[j];
                if (v == null || !Number.isFinite(Number(v))) continue;
                sum += Number(v);
                cnt += 1;
            }
            out[i] = cnt ? (sum / cnt) : src[i];
        }
        return out;
    },

    _shiftSeries(data, shift) {
        const src = Array.isArray(data) ? data.slice() : [];
        const n = src.length;
        const out = new Array(n).fill(null);
        const sh = Math.round(Number(shift || 0));
        if (!n || !sh) return src;
        for (let i = 0; i < n; i++) {
            const j = i - sh;
            if (j < 0 || j >= n) continue;
            out[i] = src[j];
        }
        return out;
    },

    _buildConfidenceBandDatasets(baseDatasets, color = "#93c5fd") {
        if (!Array.isArray(baseDatasets) || baseDatasets.length < 2) return [];
        const len = this._safeMaxBy(baseDatasets, d => (Array.isArray(d?.data) ? d.data.length : 0), 0);
        if (!len) return [];

        const lower = new Array(len).fill(null);
        const upper = new Array(len).fill(null);
        const mean = new Array(len).fill(null);

        for (let i = 0; i < len; i++) {
            const vals = [];
            for (const ds of baseDatasets) {
                const v = ds?.data?.[i];
                if (v == null || !Number.isFinite(Number(v))) continue;
                vals.push(Number(v));
            }
            if (!vals.length) continue;
            const m = vals.reduce((s, v) => s + v, 0) / vals.length;
            const variance = vals.reduce((s, v) => s + ((v - m) ** 2), 0) / vals.length;
            const sd = Math.sqrt(variance);
            mean[i] = m;
            lower[i] = m - sd;
            upper[i] = m + sd;
        }

        return [
            {
                label: "Confidence lower",
                data: lower,
                borderColor: "rgba(0,0,0,0)",
                backgroundColor: "rgba(0,0,0,0)",
                pointRadius: 0,
                borderWidth: 0,
                fill: false,
                tension: 0.18,
            },
            {
                label: "Confidence band (±1σ)",
                data: upper,
                borderColor: "rgba(0,0,0,0)",
                backgroundColor: "rgba(147, 197, 253, 0.18)",
                pointRadius: 0,
                borderWidth: 0,
                fill: "-1",
                tension: 0.18,
            },
            {
                label: "Mean",
                data: mean,
                borderColor: color,
                backgroundColor: "transparent",
                pointRadius: 0,
                borderWidth: 1.2,
                borderDash: [6, 4],
                fill: false,
                tension: 0.18,
            },
        ];
    },

    _numericSummary(row) {
        const out = {};
        for (const [k, v] of Object.entries(row || {})) {
            const n = Number(v);
            if (Number.isFinite(n)) out[k] = n;
        }
        return out;
    },

    _buildMetricContext(entry) {
        const run = entry.run;
        const ts = entry.ts || {};
        const runEnd = Math.max(0, Number(entry.runEnd || 0));
        const [wStart, wEnd] = this._windowBoundsForRun(runEnd);

        const vars = this._numericSummary(run);
        const windowMetrics = {};

        if (runEnd > 0) {
            windowMetrics.makespan = Math.max(0, wEnd - wStart);
        }

        const time = Array.isArray(ts.time) ? ts.time.map(v => Number(v || 0)) : [];
        const util = Array.isArray(ts.utilization) ? ts.utilization.map(v => Number(v || 0)) : [];
        const qDepth = Array.isArray(ts.queue_depth) ? ts.queue_depth.map(v => Number(v || 0)) : [];
        const qSize = Array.isArray(ts.queue_size) ? ts.queue_size.map(v => Number(v || 0)) : [];

        if (time.length && (util.length || qDepth.length || qSize.length)) {
            const idxs = [];
            for (let i = 0; i < time.length; i++) {
                const t = Number(time[i]);
                if (t >= wStart && t <= wEnd) idxs.push(i);
            }

            const pick = (arr) => idxs.map(i => Number(arr[i] || 0)).filter(v => Number.isFinite(v));
            const utilW = pick(util);
            const qDepthW = pick(qDepth);
            const qSizeW = pick(qSize);

            if (utilW.length) {
                windowMetrics.avg_utilization = utilW.reduce((s, v) => s + v, 0) / utilW.length;
                windowMetrics.peak_utilization = this._safeMax(utilW, 0);
            }
            if (qDepthW.length) {
                windowMetrics.avg_queue_depth = qDepthW.reduce((s, v) => s + v, 0) / qDepthW.length;
                windowMetrics.peak_queue_depth = this._safeMax(qDepthW, 0);
            }
            if (qSizeW.length) {
                windowMetrics.avg_queue_size = qSizeW.reduce((s, v) => s + v, 0) / qSizeW.length;
                windowMetrics.peak_queue_size = this._safeMax(qSizeW, 0);
            }
        }

        const waitWin = this._waitTimelineWindowMetrics(ts, wStart, wEnd, runEnd);
        if (waitWin) Object.assign(windowMetrics, waitWin);

        if (!Number.isFinite(windowMetrics.avg_wait)) windowMetrics.avg_wait = Number(run.avg_wait || 0);
        if (!Number.isFinite(windowMetrics.median_wait)) windowMetrics.median_wait = Number(run.median_wait || 0);
        if (!Number.isFinite(windowMetrics.wait_p90)) windowMetrics.wait_p90 = Number(run.wait_p90 || 0);
        if (!Number.isFinite(windowMetrics.wait_p95)) windowMetrics.wait_p95 = Number(run.wait_p95 || 0);
        if (!Number.isFinite(windowMetrics.wait_p99)) windowMetrics.wait_p99 = Number(run.wait_p99 || 0);
        if (!Number.isFinite(windowMetrics.max_wait)) windowMetrics.max_wait = Number(run.max_wait || 0);

        Object.assign(vars, {
            window_start_sec: wStart,
            window_end_sec: wEnd,
            window_duration_sec: Math.max(0, wEnd - wStart),
            window_start_pct: this._windowStartPct,
            window_end_pct: this._windowEndPct,
            avg_utilization_pct: Number(vars.avg_utilization || 0) * 100,
            peak_utilization_pct: Number(vars.peak_utilization || 0) * 100,
            window_avg_utilization: Number(windowMetrics.avg_utilization || 0),
            window_peak_utilization: Number(windowMetrics.peak_utilization || 0),
            window_avg_utilization_pct: Number(windowMetrics.avg_utilization || 0) * 100,
            window_peak_utilization_pct: Number(windowMetrics.peak_utilization || 0) * 100,
            window_avg_wait: Number(windowMetrics.avg_wait || 0),
            window_wait_p90: Number(windowMetrics.wait_p90 || 0),
            window_wait_p95: Number(windowMetrics.wait_p95 || 0),
            window_wait_p99: Number(windowMetrics.wait_p99 || 0),
            window_median_wait: Number(windowMetrics.median_wait || 0),
            window_max_wait: Number(windowMetrics.max_wait || 0),
            window_avg_queue_depth: Number(windowMetrics.avg_queue_depth || 0),
            window_peak_queue_depth: Number(windowMetrics.peak_queue_depth || 0),
            window_avg_queue_size: Number(windowMetrics.avg_queue_size || 0),
            window_peak_queue_size: Number(windowMetrics.peak_queue_size || 0),
            window_makespan: Number(windowMetrics.makespan || 0),
        });

        return {
            key: entry.key,
            run,
            runEnd,
            windowStartSec: wStart,
            windowEndSec: wEnd,
            windowMetrics,
            vars,
        };
    },

    _customMetricByMetricKey(metricKey) {
        return this.customMetrics.find(m => (`custom:${m.id}`) === metricKey) || null;
    },

    _isCustomMetric(metricKey) {
        return String(metricKey || "").startsWith("custom:");
    },

    _isUtilMetric(metric) {
        return String(metric || "").includes("utilization");
    },

    _isTimeMetric(metric) {
        const m = String(metric || "");
        return m.includes("wait") || m.includes("runtime") || m.includes("turnaround") || m === "makespan";
    },

    _metricValue(metric, row, ctx) {
        const m = String(metric || "");

        if (this._isCustomMetric(m)) {
            const def = this._customMetricByMetricKey(m);
            return this._evaluateCustomMetric(def, ctx?.vars || {});
        }

        let raw;
        if (this._windowActive() && ctx?.windowMetrics && Object.prototype.hasOwnProperty.call(ctx.windowMetrics, m)) {
            raw = Number(ctx.windowMetrics[m] || 0);
        } else {
            raw = Number(row?.[m] || 0);
        }

        if (this._isUtilMetric(m)) return raw * 100;
        return raw;
    },

    _fmtVal(metric, v) {
        const m = String(metric || "");
        const x = Number(v || 0);
        if (this._isCustomMetric(m)) return Number.isFinite(x) ? x.toFixed(4) : "0.0000";
        if (this._isUtilMetric(m)) return `${x.toFixed(1)}%`;
        if (m.endsWith("_pct")) return `${x.toFixed(2)}%`;
        if (m.includes("slowdown")) return `${x.toFixed(2)}x`;
        if (this._isTimeMetric(m)) return App.formatTime(x);
        return Number.isFinite(x) ? x.toLocaleString() : "0";
    },

    _fmtDelta(metric, d) {
        const m = String(metric || "");
        const sign = d >= 0 ? "+" : "-";
        const x = Math.abs(Number(d || 0));
        if (this._isCustomMetric(m)) return `${sign}${x.toFixed(4)}`;
        if (this._isUtilMetric(m)) return `${sign}${x.toFixed(1)}%`;
        if (m.endsWith("_pct")) return `${sign}${x.toFixed(2)}%`;
        if (m.includes("slowdown")) return `${sign}${x.toFixed(2)}x`;
        if (this._isTimeMetric(m)) return `${sign}${App.formatTime(x)}`;
        return `${sign}${x.toFixed(2)}`;
    },

    _softCap(values) {
        const pos = values.filter(v => v > 0).sort((a, b) => a - b);
        if (pos.length < 2) return undefined;
        const p90 = pos[Math.floor(pos.length * 0.90)];
        const max = pos[pos.length - 1];
        return max > 3 * p90 && p90 > 0 ? p90 * 2 : undefined;
    },

    _paretoBetterOrEqual(a, b, goal) {
        return goal === "max" ? a >= b : a <= b;
    },

    _paretoStrictlyBetter(a, b, goal) {
        return goal === "max" ? a > b : a < b;
    },

    _paretoSortDir(goal) {
        return goal === "max" ? -1 : 1;
    },

    _paretoGoalLabel(goal) {
        return goal === "max" ? "maximize" : "minimize";
    },

    _computeParetoEntries(entries) {
        const xMetric = this._paretoXMetric;
        const yMetric = this._paretoYMetric;
        const points = [];
        let invalidCount = 0;

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const ctx = this._latestContextByKey.get(entry.key) || null;
            const x = this._metricValue(xMetric, entry.run, ctx);
            const y = this._metricValue(yMetric, entry.run, ctx);
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                invalidCount += 1;
                continue;
            }
            points.push({
                index: i,
                key: entry.key,
                run: entry.run,
                label: this._fullRunLabel(entry.run),
                x,
                y,
                status: "dominated",
            });
        }

        for (let i = 0; i < points.length; i++) {
            const current = points[i];
            let dominated = false;
            for (let j = 0; j < points.length; j++) {
                if (i === j) continue;
                const other = points[j];
                const atLeastAsGood =
                    this._paretoBetterOrEqual(other.x, current.x, this._paretoXGoal) &&
                    this._paretoBetterOrEqual(other.y, current.y, this._paretoYGoal);
                const strictlyBetter =
                    this._paretoStrictlyBetter(other.x, current.x, this._paretoXGoal) ||
                    this._paretoStrictlyBetter(other.y, current.y, this._paretoYGoal);
                if (atLeastAsGood && strictlyBetter) {
                    dominated = true;
                    break;
                }
            }
            current.status = dominated ? "dominated" : "frontier";
        }

        const frontier = points
            .filter(point => point.status === "frontier")
            .slice()
            .sort((a, b) => (a.x - b.x) || (a.y - b.y) || a.label.localeCompare(b.label));
        const xDir = this._paretoSortDir(this._paretoXGoal);
        const yDir = this._paretoSortDir(this._paretoYGoal);
        const tableRows = points
            .slice()
            .sort((a, b) => {
                if (a.status !== b.status) return a.status === "frontier" ? -1 : 1;
                if (a.x !== b.x) return (a.x - b.x) * xDir;
                if (a.y !== b.y) return (a.y - b.y) * yDir;
                return a.label.localeCompare(b.label);
            });

        return {
            xMetric,
            yMetric,
            points,
            frontier,
            dominated: points.filter(point => point.status === "dominated"),
            invalidCount,
            tableRows,
        };
    },

    _renderParetoTable(result) {
        const xHead = document.getElementById("compare-pareto-x-head");
        const yHead = document.getElementById("compare-pareto-y-head");
        const body = document.querySelector("#compare-pareto-table tbody");
        if (!body) return;

        const xLabel = this._metricLabel(result?.xMetric || this._paretoXMetric);
        const yLabel = this._metricLabel(result?.yMetric || this._paretoYMetric);
        if (xHead) xHead.textContent = `${xLabel} (${this._paretoGoalLabel(this._paretoXGoal)})`;
        if (yHead) yHead.textContent = `${yLabel} (${this._paretoGoalLabel(this._paretoYGoal)})`;

        if (!result || !result.tableRows.length) {
            body.innerHTML = '<tr><td colspan="5">No valid runs available for Pareto analysis.</td></tr>';
            return;
        }

        body.innerHTML = result.tableRows.map((point, idx) => `
            <tr class="is-${this._esc(point.status)}">
                <td>${idx + 1}</td>
                <td>${this._esc(point.label)}</td>
                <td class="status-${this._esc(point.status)}">${point.status === "frontier" ? "Frontier" : "Dominated"}</td>
                <td>${this._esc(this._fmtVal(result.xMetric, point.x))}</td>
                <td>${this._esc(this._fmtVal(result.yMetric, point.y))}</td>
            </tr>
        `).join("");
    },

    renderPareto(entries) {
        const ctx = document.getElementById("chart-compare-pareto");
        const note = document.getElementById("compare-pareto-note");
        this.clearChart("chart-compare-pareto");

        if (!ctx) return;
        if (note) note.textContent = "";

        if (!Array.isArray(entries) || entries.length < 2) {
            this._renderParetoTable(null);
            if (note) note.textContent = "Select at least two runs to compute a Pareto frontier.";
            return;
        }

        const result = this._computeParetoEntries(entries);
        this._renderParetoTable(result);

        if (result.points.length < 2) {
            if (note) {
                note.textContent = result.invalidCount
                    ? `${result.invalidCount} selected run(s) were excluded because the chosen metrics did not evaluate to finite values.`
                    : "Need at least two valid runs to compute a Pareto frontier.";
            }
            return;
        }

        const xMetric = result.xMetric;
        const yMetric = result.yMetric;
        const xLabel = this._metricLabel(xMetric);
        const yLabel = this._metricLabel(yMetric);
        const frontierPoints = result.frontier.map(point => ({ x: point.x, y: point.y, _point: point }));
        const dominatedPoints = result.dominated.map(point => ({ x: point.x, y: point.y, _point: point }));

        const datasets = [];
        if (dominatedPoints.length) {
            datasets.push({
                label: "Dominated runs",
                data: dominatedPoints,
                pointRadius: 4.5,
                pointHoverRadius: 6,
                pointBackgroundColor: "rgba(148, 163, 184, 0.68)",
                pointBorderColor: "#d7e5f0",
                pointBorderWidth: 1,
                showLine: false,
            });
        }
        if (frontierPoints.length) {
            datasets.push({
                label: "Pareto frontier",
                data: frontierPoints,
                pointRadius: 6,
                pointHoverRadius: 7,
                pointBackgroundColor: "#2dd4bf",
                pointBorderColor: "#e6fffb",
                pointBorderWidth: 1.2,
                showLine: false,
            });
        }
        if (frontierPoints.length >= 2) {
            datasets.push({
                type: "line",
                label: "Frontier curve",
                data: frontierPoints.map(point => ({ x: point.x, y: point.y })),
                pointRadius: 0,
                pointHoverRadius: 0,
                pointHitRadius: 0,
                borderColor: "#f59e0b",
                borderWidth: 1.7,
                tension: 0,
                fill: false,
                showLine: true,
            });
        }

        this.charts["chart-compare-pareto"] = new Chart(ctx, {
            type: "scatter",
            data: { datasets },
            options: {
                ...App.chartDefaults(),
                plugins: {
                    ...App.chartDefaults().plugins,
                    legend: {
                        display: true,
                        labels: { color: "#8fb2c8" },
                    },
                    tooltip: {
                        filter: item => Boolean(item?.raw?._point),
                        callbacks: {
                            title: items => items?.[0]?.raw?._point?.label || "Run",
                            label: item => {
                                const point = item?.raw?._point;
                                if (!point) return "";
                                const lines = [
                                    ` Status: ${point.status === "frontier" ? "Pareto frontier" : "Dominated"}`,
                                    ` ${xLabel}: ${this._fmtVal(xMetric, point.x)}`,
                                    ` ${yLabel}: ${this._fmtVal(yMetric, point.y)}`,
                                ];
                                return lines;
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        type: "linear",
                        title: { display: true, text: `${xLabel} (${this._paretoGoalLabel(this._paretoXGoal)})`, color: "#9ebcd0" },
                        ticks: { color: "#8fb2c8", callback: value => this._fmtVal(xMetric, Number(value || 0)) },
                        grid: { color: "#1e394f" },
                    },
                    y: {
                        type: "linear",
                        title: { display: true, text: `${yLabel} (${this._paretoGoalLabel(this._paretoYGoal)})`, color: "#9ebcd0" },
                        ticks: { color: "#8fb2c8", callback: value => this._fmtVal(yMetric, Number(value || 0)) },
                        grid: { color: "#1e394f" },
                    },
                },
            },
        });

        if (note) {
            const parts = [
                `Frontier runs: ${result.frontier.length} of ${result.points.length} valid selected runs.`,
                `Goals: ${this._paretoGoalLabel(this._paretoXGoal)} ${xLabel}, ${this._paretoGoalLabel(this._paretoYGoal)} ${yLabel}.`,
            ];
            if (result.invalidCount) {
                parts.push(`${result.invalidCount} run(s) excluded for missing metric values.`);
            }
            if (xMetric === yMetric) {
                parts.push("X and Y use the same metric, so the frontier collapses onto a diagonal.");
            }
            note.textContent = parts.join(" ");
        }
    },

    renderBar(entries, metric) {
        const ctx = document.getElementById("chart-compare");
        this.clearChart("chart-compare");
        if (!ctx || !entries.length) return;

        const baselineSel = document.getElementById("compare-baseline");
        const baselineKey = baselineSel?.value || "";
        const baselineEntry = entries.find(e => e.key === baselineKey) || entries[0];
        const baselineCtx = this._latestContextByKey.get(baselineEntry.key) || null;
        const baselineV = this._metricValue(metric, baselineEntry.run, baselineCtx);

        const labels = entries.map(e => this._fullRunLabel(e.run));
        const values = entries.map(e => this._metricValue(metric, e.run, this._latestContextByKey.get(e.key) || null));
        const colors = entries.map((_, i) => App.COLORS[i % App.COLORS.length]);

        const cap = this._softCap(values);
        const yAxis = {
            ticks: { color: "#8fb2c8" },
            grid: { color: "#1e394f" },
        };
        if (cap !== undefined) yAxis.max = cap;

        const dataset = {
            data: values,
            backgroundColor: colors.map(c => c + "bb"),
            borderColor: colors,
            borderWidth: 1,
            _labels: values.map(raw => `${this._fmtVal(metric, raw)} (${this._fmtDelta(metric, raw - baselineV)})`),
        };

        this.charts["chart-compare"] = new Chart(ctx, {
            type: "bar",
            data: { labels, datasets: [dataset] },
            plugins: [_clipLabelPlugin],
            options: {
                ...App.chartDefaults(),
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: item => {
                                const raw = values[item.dataIndex];
                                const delta = raw - baselineV;
                                return ` ${this._fmtVal(metric, raw)} | Delta ${this._fmtDelta(metric, delta)}`;
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        ticks: { color: "#8fb2c8", font: { size: 9 }, maxRotation: 32 },
                        grid: { color: "#1e394f" },
                    },
                    y: yAxis,
                },
            },
        });
    },

    _radarAxisDefs() {
        return [
            { key: "avg_wait", label: "Avg Wait", goal: "min", fmt: v => this._fmtVal("avg_wait", v) },
            { key: "wait_p95", label: "Wait p95", goal: "min", fmt: v => this._fmtVal("wait_p95", v) },
            { key: "wait_p99", label: "Wait p99", goal: "min", fmt: v => this._fmtVal("wait_p99", v) },
            {
                key: "wait_fairness",
                label: "Wait Fairness",
                goal: "max",
                get: (entry, ctx) => {
                    const raw = this._windowActive()
                        ? Number(ctx?.vars?.wait_gini ?? entry?.run?.wait_gini ?? 0)
                        : Number(entry?.run?.wait_gini ?? ctx?.vars?.wait_gini ?? 0);
                    return Number.isFinite(raw) ? Math.max(0, 1 - raw) : 0;
                },
                fmt: v => `${(Math.max(0, Number(v || 0)) * 100).toFixed(1)}%`,
            },
            { key: "avg_utilization", label: "Utilization", goal: "max", fmt: v => this._fmtVal("avg_utilization", v) },
            { key: "avg_bounded_slowdown", label: "Bounded Slowdown", goal: "min", fmt: v => this._fmtVal("avg_bounded_slowdown", v) },
        ];
    },

    _radarMetricValue(axis, entry) {
        const ctx = this._latestContextByKey.get(entry.key) || null;
        if (typeof axis.get === "function") {
            return Number(axis.get(entry, ctx) || 0);
        }
        return Number(this._metricValue(axis.key, entry.run, ctx) || 0);
    },

    renderRadar(entries) {
        const ctx = document.getElementById("chart-compare-radar");
        const note = document.getElementById("compare-radar-note");
        this.clearChart("chart-compare-radar");
        if (!ctx) return;

        if (!Array.isArray(entries) || !entries.length) {
            if (note) note.textContent = "Select at least one run to view the policy trade-off radar.";
            return;
        }

        const theme = App.chartTheme();
        const axes = this._radarAxisDefs();
        const labels = axes.map(axis => axis.label);
        const rawByAxis = axes.map(axis => entries.map(entry => this._radarMetricValue(axis, entry)));
        const datasets = entries.map((entry, idx) => {
            const color = App.COLORS[idx % App.COLORS.length];
            const rawValues = axes.map((axis, axisIdx) => Number(rawByAxis[axisIdx][idx] || 0));
            const data = axes.map((axis, axisIdx) => {
                const values = rawByAxis[axisIdx].filter(v => Number.isFinite(v));
                const raw = rawValues[axisIdx];
                if (!values.length) return 0;
                const min = Math.min(...values);
                const max = Math.max(...values);
                if (!Number.isFinite(raw)) return 0;
                if (Math.abs(max - min) < 1e-12) return 1;
                if (axis.goal === "max") return (raw - min) / (max - min);
                return (max - raw) / (max - min);
            });

            return {
                label: this._policyLabel(entry.run),
                data,
                rawValues,
                borderColor: color,
                backgroundColor: color + "22",
                pointBackgroundColor: color,
                pointBorderColor: color,
                pointRadius: 2.5,
                borderWidth: 2,
                fill: true,
            };
        });

        this.charts["chart-compare-radar"] = new Chart(ctx, {
            type: "radar",
            data: { labels, datasets },
            options: {
                ...App.chartDefaults(),
                plugins: {
                    ...App.chartDefaults().plugins,
                    legend: {
                        display: true,
                        labels: { color: theme.legendText },
                    },
                    tooltip: {
                        callbacks: {
                            title: items => items?.[0]?.dataset?.label || "Run",
                            label: item => {
                                const axis = axes[item.dataIndex];
                                const raw = Number(item.dataset?.rawValues?.[item.dataIndex] || 0);
                                const score = Number(item.raw || 0);
                                return `${axis.label}: ${axis.fmt(raw)} | Score ${(score * 100).toFixed(0)} / 100`;
                            },
                        },
                    },
                },
                scales: {
                    r: {
                        min: 0,
                        max: 1,
                        ticks: {
                            display: false,
                            backdropColor: "transparent",
                        },
                        grid: { color: theme.grid },
                        angleLines: { color: theme.grid },
                        pointLabels: {
                            color: theme.axisTitle,
                            font: { size: 11, family: "Space Grotesk" },
                        },
                    },
                },
            },
        });

        if (note) {
            const bestTail = entries
                .map(entry => ({
                    label: this._policyLabel(entry.run),
                    value: this._radarMetricValue({ key: "wait_p99" }, entry),
                }))
                .sort((a, b) => a.value - b.value)[0];
            const worstFair = entries
                .map(entry => ({
                    label: this._policyLabel(entry.run),
                    value: this._radarMetricValue({
                        get: (e, c) => {
                            const raw = Number(c?.vars?.wait_gini ?? e?.run?.wait_gini ?? 0);
                            return Number.isFinite(raw) ? Math.max(0, 1 - raw) : 0;
                        },
                    }, entry),
                }))
                .sort((a, b) => a.value - b.value)[0];

            note.textContent =
                `Higher is better on every axis. Scores are normalized across the currently selected runs. ` +
                `Wait Fairness = 1 - wait_gini. Best tail-latency run: ${bestTail?.label || "-"}; ` +
                `weakest fairness: ${worstFair?.label || "-"}.`;
        }
    },

    _cdfSeriesFromWaits(waits, targetPoints = 260) {
        const sorted = waits
            .map(v => Number(v || 0))
            .filter(v => Number.isFinite(v) && v >= 0)
            .sort((a, b) => a - b);
        if (!sorted.length) return [];
        const n = sorted.length;
        const points = Math.max(32, Math.min(targetPoints, n));
        const data = [];
        for (let i = 0; i < points; i++) {
            const idx = Math.min(n - 1, Math.round((i * (n - 1)) / Math.max(1, points - 1)));
            data.push({
                x: sorted[idx],
                y: (idx + 1) / n,
            });
        }
        return data;
    },

    async renderWaitCdf(entries) {
        const ctx = document.getElementById("chart-compare-wait-cdf");
        const note = document.getElementById("compare-wait-cdf-note");
        this.clearChart("chart-compare-wait-cdf");
        if (!ctx) return;

        if (!Array.isArray(entries) || !entries.length) {
            if (note) note.textContent = "Select at least one run to compare wait-time distributions.";
            return;
        }

        const theme = App.chartTheme();
        const scatters = await Promise.all(entries.map(entry => App.loadScatter(entry.key)));
        const datasets = [];
        let available = 0;
        let xMax = 0;
        let dataMax = 0;

        for (let i = 0; i < entries.length; i++) {
            const scatter = scatters[i] || {};
            const waits = Array.isArray(scatter?.wait) ? scatter.wait : [];
            const data = this._cdfSeriesFromWaits(waits);
            if (!data.length) continue;
            available += 1;
            const color = App.COLORS[i % App.COLORS.length];
            xMax = Math.max(xMax, Number(entries[i]?.run?.wait_p99 || 0));
            dataMax = Math.max(dataMax, Number(data[data.length - 1]?.x || 0));
            datasets.push({
                label: this._policyLabel(entries[i].run),
                data,
                borderColor: color,
                backgroundColor: color + "18",
                pointRadius: 0,
                borderWidth: 2,
                fill: false,
                tension: 0.06,
                samples: waits.length,
            });
        }

        if (!datasets.length) {
            if (note) note.textContent = "No per-job wait samples are available for the selected runs.";
            return;
        }

        this.charts["chart-compare-wait-cdf"] = new Chart(ctx, {
            type: "line",
            data: { datasets },
            options: {
                ...App.chartDefaults(),
                parsing: false,
                scales: {
                    x: {
                        type: "linear",
                        min: 0,
                        max: Number.isFinite(xMax) && xMax > 0 ? xMax : (dataMax > 0 ? dataMax : undefined),
                        ticks: {
                            color: theme.tick,
                            callback: value => App.formatTime(Number(value || 0)),
                            maxTicksLimit: 9,
                        },
                        grid: { color: theme.grid },
                        title: { display: true, text: "Wait Time", color: theme.axisTitle },
                    },
                    y: {
                        min: 0,
                        max: 1,
                        ticks: {
                            color: theme.tick,
                            callback: value => `${Math.round(Number(value || 0) * 100)}%`,
                        },
                        grid: { color: theme.grid },
                        title: { display: true, text: "Cumulative Share of Jobs", color: theme.axisTitle },
                    },
                },
                plugins: {
                    ...App.chartDefaults().plugins,
                    legend: {
                        display: true,
                        labels: { color: theme.legendText },
                    },
                    tooltip: {
                        callbacks: {
                            title: items => items?.[0]?.dataset?.label || "Run",
                            label: item => {
                                const wait = Number(item.raw?.x || 0);
                                const pct = Number(item.raw?.y || 0) * 100;
                                const samples = Number(item.dataset?.samples || 0);
                                return [
                                    ` Wait <= ${App.formatTime(wait)}: ${pct.toFixed(1)}%`,
                                    ` Samples: ${samples.toLocaleString()}`,
                                ];
                            },
                        },
                    },
                },
            },
        });

        if (note) {
            note.textContent =
                `Empirical CDF from per-job wait samples. Curves farther left indicate lower wait across the distribution. ` +
                `X-axis clipped at the selected-run p99 to keep the tail comparison readable. ${available} run(s) included.`;
        }
    },

    _buildOverlayBase(entry, targetLen, xTimes, valueSelector) {
        const run = entry.run;
        const ts = entry.ts || {};
        const runEnd = entry.runEnd;
        const raw = valueSelector(ts);
        const data = xTimes.map(t => {
            if (!runEnd || runEnd <= 0) return null;
            if (t > runEnd) return null;
            return this._sampleAtProgress(raw, t / runEnd, 0);
        });

        let out = data;
        if (this._overlayAlign === "peak_queue") {
            const qd = Array.isArray(ts.queue_depth) ? ts.queue_depth : [];
            const peak = this._safeMax(qd, Number.NEGATIVE_INFINITY);
            const peakIdx = qd.length ? qd.indexOf(peak) : -1;
            if (peakIdx >= 0 && qd.length > 1) {
                const peakRatio = peakIdx / (qd.length - 1);
                const peakPlotIdx = Math.round(peakRatio * (targetLen - 1));
                const targetPeak = Math.round((targetLen - 1) * 0.50);
                out = this._shiftSeries(out, targetPeak - peakPlotIdx);
            }
        }

        out = this._smoothSeries(out, this._overlaySmoothing);

        const [wStart, wEnd] = this._windowBoundsForRun(runEnd);
        if (this._windowMode === "absolute") {
            for (let i = 0; i < out.length; i++) {
                const t = xTimes[i];
                if (t < wStart || t > wEnd) out[i] = null;
            }
        } else {
            const pStart = this._windowStartPct;
            const pEnd = this._windowEndPct;
            for (let i = 0; i < out.length; i++) {
                const p = targetLen > 1 ? (i / (targetLen - 1)) * 100 : 0;
                if (p < pStart || p > pEnd) out[i] = null;
            }
        }

        return {
            label: this._fullRunLabel(run),
            data: out,
        };
    },

    async renderUtiOverlay(entries) {
        const ctx = document.getElementById("chart-compare-uti");
        this.clearChart("chart-compare-uti");
        if (!ctx || !entries.length) return;

        const modeNormalize = !!this._overlayNormalizeX;
        const targetLen = 120;
        const maxEnd = this._safeMaxBy(entries, e => Number(e?.runEnd || 0), 0);

        const labels = modeNormalize
            ? Array.from({ length: targetLen }, (_, i) => `${Math.round((i * 100) / (targetLen - 1))}%`)
            : Array.from({ length: targetLen }, (_, i) => App.formatTime((maxEnd * i) / (targetLen - 1)));

        const xTimes = modeNormalize
            ? Array.from({ length: targetLen }, (_, i) => {
                if (targetLen <= 1) return 0;
                return (i / (targetLen - 1));
            })
            : Array.from({ length: targetLen }, (_, i) => {
                if (targetLen <= 1) return 0;
                return (maxEnd * i) / (targetLen - 1);
            });

        const baseDatasets = entries.map((entry, i) => {
            const series = this._buildOverlayBase(
                entry,
                targetLen,
                modeNormalize
                    ? xTimes.map(p => p * entry.runEnd)
                    : xTimes,
                ts => Array.isArray(ts.utilization) ? ts.utilization.map(v => Number(v || 0) * 100) : []
            );

            const color = App.COLORS[i % App.COLORS.length];
            return {
                label: series.label,
                data: series.data,
                borderColor: color,
                backgroundColor: color + "11",
                fill: false,
                pointRadius: 0,
                borderWidth: 1.5,
                tension: 0.12,
            };
        });

        const datasets = baseDatasets.slice();
        if (this._overlayBand && baseDatasets.length >= 2) {
            datasets.push(...this._buildConfidenceBandDatasets(baseDatasets, "#a5c9ff"));
        }

        this.charts["chart-compare-uti"] = new Chart(ctx, {
            type: "line",
            data: { labels, datasets },
            options: {
                ...App.chartDefaults(),
                scales: {
                    x: {
                        ticks: { color: "#8fb2c8", font: { size: 9 }, maxTicksLimit: 11 },
                        grid: { color: "#1e394f" },
                        title: { display: true, text: modeNormalize ? "Makespan Progress" : "Submit-Time Offset", color: "#9ebcd0" },
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
        App.enableLineChartZoom(this.charts["chart-compare-uti"], { xScaleId: "x", minWindow: 12, zoomFactor: 0.55 });

        const note = document.getElementById("compare-overlay-note");
        if (note) {
            note.textContent = `Mode: ${modeNormalize ? "normalized" : "absolute"}; Align: ${this._overlayAlign}; Smoothing: ${this._overlaySmoothing.toFixed(2)}.`;
        }
    },

    async renderWaitMakespanOverlay(entries) {
        const ctx = document.getElementById("chart-compare-wait-makespan");
        const note = document.getElementById("compare-wait-makespan-note");
        this.clearChart("chart-compare-wait-makespan");

        if (!ctx || !entries.length) {
            if (note) note.textContent = "";
            return;
        }

        const modeNormalize = !!this._overlayNormalizeX;
        const targetLen = 120;
        const maxEnd = this._safeMaxBy(entries, e => Number(e?.runEnd || 0), 0);

        const labels = modeNormalize
            ? Array.from({ length: targetLen }, (_, i) => `${Math.round((i * 100) / (targetLen - 1))}%`)
            : Array.from({ length: targetLen }, (_, i) => App.formatTime((maxEnd * i) / (targetLen - 1)));

        const xTimes = modeNormalize
            ? Array.from({ length: targetLen }, (_, i) => {
                if (targetLen <= 1) return 0;
                return (i / (targetLen - 1));
            })
            : Array.from({ length: targetLen }, (_, i) => {
                if (targetLen <= 1) return 0;
                return (maxEnd * i) / (targetLen - 1);
            });

        const baseDatasets = [];
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const wt = entry.ts?.wait_timeline || {};
            const avgWait = Array.isArray(wt.avg) ? wt.avg : [];
            if (!avgWait.length) continue;

            const rawToTimeline = modeNormalize
                ? this._resampleLinear(avgWait, targetLen, 0)
                : xTimes.map(t => {
                    if (!entry.runEnd || entry.runEnd <= 0) return null;
                    if (t > entry.runEnd) return null;
                    return this._sampleAtProgress(avgWait, t / entry.runEnd, 0);
                });

            let data = rawToTimeline;
            if (this._overlayAlign === "peak_queue") {
                const qd = Array.isArray(entry.ts?.queue_depth) ? entry.ts.queue_depth : [];
                const peak = this._safeMax(qd, Number.NEGATIVE_INFINITY);
                const peakIdx = qd.length ? qd.indexOf(peak) : -1;
                if (peakIdx >= 0 && qd.length > 1) {
                    const peakRatio = peakIdx / (qd.length - 1);
                    const peakPlotIdx = Math.round(peakRatio * (targetLen - 1));
                    const targetPeak = Math.round((targetLen - 1) * 0.50);
                    data = this._shiftSeries(data, targetPeak - peakPlotIdx);
                }
            }

            data = this._smoothSeries(data, this._overlaySmoothing);

            if (modeNormalize) {
                for (let j = 0; j < data.length; j++) {
                    const p = targetLen > 1 ? (j / (targetLen - 1)) * 100 : 0;
                    if (p < this._windowStartPct || p > this._windowEndPct) data[j] = null;
                }
            } else {
                const [wStart, wEnd] = this._windowBoundsForRun(entry.runEnd);
                for (let j = 0; j < data.length; j++) {
                    const t = xTimes[j];
                    if (t < wStart || t > wEnd) data[j] = null;
                }
            }

            const color = App.COLORS[i % App.COLORS.length];
            baseDatasets.push({
                label: this._fullRunLabel(entry.run),
                data,
                borderColor: color,
                backgroundColor: color + "22",
                fill: false,
                pointRadius: 0,
                borderWidth: 1.6,
                tension: 0.2,
                spanGaps: false,
            });
        }

        if (!baseDatasets.length) {
            if (note) note.textContent = "No wait timeline data available for selected runs.";
            return;
        }

        const datasets = baseDatasets.slice();
        if (this._overlayBand && baseDatasets.length >= 2) {
            datasets.push(...this._buildConfidenceBandDatasets(baseDatasets, "#9dc2ff"));
        }

        this.charts["chart-compare-wait-makespan"] = new Chart(ctx, {
            type: "line",
            data: { labels, datasets },
            options: {
                ...App.chartDefaults(),
                scales: {
                    x: {
                        title: { display: true, text: modeNormalize ? "Makespan Progress" : "Submit-Time Offset", color: "#9ebcd0" },
                        ticks: { color: "#8fb2c8", maxTicksLimit: 11 },
                        grid: { color: "#1e394f" },
                    },
                    y: {
                        title: { display: true, text: "Avg Wait Time", color: "#9ebcd0" },
                        ticks: { color: "#8fb2c8", callback: v => App.formatTime(Number(v || 0)) },
                        grid: { color: "#1e394f" },
                    },
                },
                plugins: {
                    ...App.chartDefaults().plugins,
                    tooltip: {
                        callbacks: {
                            title: items => {
                                const idx = items?.[0]?.dataIndex ?? 0;
                                return `${modeNormalize ? "Progress" : "Time"} ${labels[idx] || "-"}`;
                            },
                            label: item => ` ${item.dataset.label}: ${App.formatTime(Number(item.raw || 0))}`,
                        },
                    },
                },
            },
        });
        App.enableLineChartZoom(this.charts["chart-compare-wait-makespan"], { xScaleId: "x", minWindow: 8, zoomFactor: 0.5 });

        if (note) {
            note.textContent = `Mode: ${modeNormalize ? "normalized" : "absolute"}; Align: ${this._overlayAlign}; Window: ${this._windowStartPct}% -> ${this._windowEndPct}%.`;
        }
    },

    clearChart(id) {
        if (this.charts[id]) {
            this.charts[id].destroy();
            delete this.charts[id];
        }
    },

    _safeExpr(expr) {
        const s = String(expr || "").trim();
        if (!s) return null;
        if (/[^0-9A-Za-z_+\-*/%()., <>!=?:&|]/.test(s)) return null;
        return s;
    },

    _evaluateCustomMetric(def, vars) {
        if (!def || !def.formula) return 0;
        const expr = this._safeExpr(def.formula);
        if (!expr) return 0;

        const env = {
            ...vars,
            min: Math.min,
            max: Math.max,
            abs: Math.abs,
            sqrt: Math.sqrt,
            pow: Math.pow,
            log: Math.log,
            exp: Math.exp,
            floor: Math.floor,
            ceil: Math.ceil,
            round: Math.round,
        };

        try {
            const keys = Object.keys(env);
            const vals = keys.map(k => env[k]);
            const fn = new Function(...keys, `\"use strict\"; return (${expr});`);
            const out = Number(fn(...vals));
            return Number.isFinite(out) ? out : 0;
        } catch {
            return 0;
        }
    },

    _normalizeCustomMetrics(list) {
        if (!Array.isArray(list)) return [];
        const out = [];
        const seen = new Set();
        for (const item of list) {
            const id = String(item?.id || "").trim() || `m_${Date.now()}_${out.length}`;
            const name = String(item?.name || "").trim();
            const formula = String(item?.formula || "").trim();
            if (!name || !formula || seen.has(id)) continue;
            out.push({ id, name, formula });
            seen.add(id);
        }
        return out;
    },

    _loadCustomMetrics() {
        try {
            const raw = localStorage.getItem(_CUSTOM_METRIC_STORAGE_KEY);
            if (!raw) {
                this.customMetrics = [];
                return;
            }
            this.customMetrics = this._normalizeCustomMetrics(JSON.parse(raw));
        } catch {
            this.customMetrics = [];
        }
    },

    _saveCustomMetrics() {
        try {
            localStorage.setItem(_CUSTOM_METRIC_STORAGE_KEY, JSON.stringify(this.customMetrics));
        } catch {
            // ignore storage failures
        }
    },

    _refreshMetricSelect(preferredValue = "") {
        const sel = document.getElementById("compare-metric");
        if (!sel) return;
        this._fillMetricSelect(sel, preferredValue, "avg_wait");
    },

    _refreshParetoMetricSelects(preferredX = "", preferredY = "") {
        const xSel = document.getElementById("compare-pareto-x");
        const ySel = document.getElementById("compare-pareto-y");
        this._fillMetricSelect(xSel, preferredX || this._paretoXMetric, "avg_wait");
        this._fillMetricSelect(ySel, preferredY || this._paretoYMetric, "avg_utilization");
        this._paretoXMetric = xSel?.value || "avg_wait";
        this._paretoYMetric = ySel?.value || "avg_utilization";
    },

    _setCustomStatus(msg) {
        const el = document.getElementById("compare-custom-status");
        if (el) el.textContent = String(msg || "");
    },

    _setSessionStatus(msg) {
        const el = document.getElementById("compare-session-status");
        if (el) el.textContent = String(msg || "");
    },

    _addCustomMetricFromInputs() {
        const nameEl = document.getElementById("compare-custom-name");
        const formulaEl = document.getElementById("compare-custom-formula");
        const name = String(nameEl?.value || "").trim();
        const formula = String(formulaEl?.value || "").trim();

        if (!name || !formula) {
            this._setCustomStatus("Name and formula are required.");
            return;
        }
        if (!this._safeExpr(formula)) {
            this._setCustomStatus("Formula contains unsupported characters.");
            return;
        }

        const sampleCtx = this._latestContextByKey.values().next().value?.vars || {};
        const test = this._evaluateCustomMetric({ formula }, sampleCtx);
        if (!Number.isFinite(test)) {
            this._setCustomStatus("Formula did not evaluate to a number.");
            return;
        }

        const id = `m_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        this.customMetrics.push({ id, name, formula });
        this.customMetrics = this._normalizeCustomMetrics(this.customMetrics);
        this._saveCustomMetrics();
        this._refreshMetricSelect(`custom:${id}`);
        this._refreshParetoMetricSelects();
        this._syncParetoControlsToState();

        if (nameEl) nameEl.value = "";
        if (formulaEl) formulaEl.value = "";
        this._setCustomStatus(`Added custom metric: ${name}.`);
        this.update();
    },

    _removeSelectedCustomMetric() {
        const sel = document.getElementById("compare-metric");
        const val = String(sel?.value || "");
        if (!this._isCustomMetric(val)) {
            this._setCustomStatus("Select a custom metric in the dropdown first.");
            return;
        }

        const def = this._customMetricByMetricKey(val);
        if (!def) return;
        this.customMetrics = this.customMetrics.filter(m => m.id !== def.id);
        this._saveCustomMetrics();
        this._refreshMetricSelect("avg_wait");
        this._refreshParetoMetricSelects();
        this._syncParetoControlsToState();
        this._setCustomStatus(`Removed custom metric: ${def.name}.`);
        this.update();
    },

    _collectSessionState() {
        const metric = document.getElementById("compare-metric")?.value || "avg_wait";
        const baseline = document.getElementById("compare-baseline")?.value || "";
        const notes = document.getElementById("compare-session-notes")?.value || "";
        const systemFilter = document.getElementById("compare-system-select")?.value || "all";

        return {
            schema: "cqsimlive.compare.session.v1",
            created_at: new Date().toISOString(),
            selected_keys: this.selectedKeys.slice(),
            baseline_key: baseline,
            metric,
            filters: {
                system: systemFilter,
                run_search: document.getElementById("compare-run-search")?.value || "",
                selected_search: document.getElementById("compare-selected-search")?.value || "",
            },
            analysis_window: {
                mode: this._windowMode,
                start_pct: this._windowStartPct,
                end_pct: this._windowEndPct,
                reference_max_sec: this._windowMaxSec,
            },
            overlay: {
                normalize_x: this._overlayNormalizeX,
                align: this._overlayAlign,
                smoothing: this._overlaySmoothing,
                confidence_band: this._overlayBand,
            },
            pareto: {
                x_metric: this._paretoXMetric,
                y_metric: this._paretoYMetric,
                x_goal: this._paretoXGoal,
                y_goal: this._paretoYGoal,
            },
            custom_metrics: this.customMetrics.slice(),
            notes,
        };
    },

    _downloadSessionJson(payload) {
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
        const name = `cqsimlive_session_${stamp}.json`;
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    },

    _exportSession() {
        const payload = this._collectSessionState();
        this._downloadSessionJson(payload);
        this._setSessionStatus(`Exported session with ${payload.selected_keys.length} selected runs.`);
    },

    async _importSessionFile(file) {
        if (!file) return;
        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            await this._applySessionState(parsed);
            this._setSessionStatus("Session imported.");
        } catch (err) {
            this._setSessionStatus(`Import failed: ${err?.message || err}`);
        }
    },

    async _applySessionState(session) {
        if (!session || typeof session !== "object") throw new Error("Invalid session file");

        this.customMetrics = this._normalizeCustomMetrics(session.custom_metrics || []);
        this._saveCustomMetrics();

        const valid = new Set(this.data.map(d => App.runKey(d)));
        this.selectedKeys = Array.isArray(session.selected_keys)
            ? session.selected_keys.map(v => String(v || "")).filter(k => valid.has(k))
            : [];

        if (!this.selectedKeys.length) {
            this.selectedKeys = this.data.slice(0, Math.min(4, this.data.length)).map(d => App.runKey(d));
        }

        const mode = String(session?.analysis_window?.mode || "percent");
        this._windowMode = mode === "absolute" ? "absolute" : "percent";
        this._setWindowPct(
            Number(session?.analysis_window?.start_pct || 0),
            Number(session?.analysis_window?.end_pct || 100)
        );

        this._overlayNormalizeX = !!session?.overlay?.normalize_x;
        this._overlayAlign = String(session?.overlay?.align || "first_submit") === "peak_queue" ? "peak_queue" : "first_submit";
        this._overlaySmoothing = Math.max(0, Math.min(0.95, Number(session?.overlay?.smoothing || 0.15)));
        this._overlayBand = !!session?.overlay?.confidence_band;
        this._paretoXMetric = String(session?.pareto?.x_metric || "avg_wait");
        this._paretoYMetric = String(session?.pareto?.y_metric || "avg_utilization");
        this._paretoXGoal = String(session?.pareto?.x_goal || "min") === "max" ? "max" : "min";
        this._paretoYGoal = String(session?.pareto?.y_goal || "max") === "min" ? "min" : "max";

        const notesEl = document.getElementById("compare-session-notes");
        if (notesEl) notesEl.value = String(session.notes || "");

        const runSearch = document.getElementById("compare-run-search");
        const selectedSearch = document.getElementById("compare-selected-search");
        const sysSel = document.getElementById("compare-system-select");
        if (runSearch) runSearch.value = String(session?.filters?.run_search || "");
        if (selectedSearch) selectedSearch.value = String(session?.filters?.selected_search || "");
        if (sysSel) {
            const targetSystem = String(session?.filters?.system || "all");
            const opts = Array.from(sysSel.options).map(o => o.value);
            sysSel.value = opts.includes(targetSystem) ? targetSystem : "all";
        }

        this.populateSystems();
        this.populateRunPicker();
        this._refreshMetricSelect(String(session.metric || "avg_wait"));
        this._refreshParetoMetricSelects(this._paretoXMetric, this._paretoYMetric);
        this.populateBaseline();
        this.renderSelectedRuns();

        const baselineSel = document.getElementById("compare-baseline");
        if (baselineSel) {
            const targetBaseline = String(session?.baseline_key || "");
            const opts = Array.from(baselineSel.options).map(o => o.value);
            if (opts.includes(targetBaseline)) baselineSel.value = targetBaseline;
        }

        this._syncAdvancedControlsToState();
        this._syncParetoControlsToState();
        await this.update();
    },

    bind() {
        if (this._bound) return;
        this._bound = true;

        const picker = document.getElementById("compare-run-picker");
        const systemSel = document.getElementById("compare-system-select");

        document.getElementById("btn-compare-add").addEventListener("click", () => this.addSelectedRun(picker.value));
        document.getElementById("btn-compare-clear").addEventListener("click", () => this.clearSelectedRuns());

        document.getElementById("compare-metric").addEventListener("change", () => this.update());
        document.getElementById("compare-baseline").addEventListener("change", () => this.update());
        document.getElementById("compare-pareto-x")?.addEventListener("change", evt => {
            this._paretoXMetric = String(evt?.target?.value || "avg_wait");
            this.update();
        });
        document.getElementById("compare-pareto-y")?.addEventListener("change", evt => {
            this._paretoYMetric = String(evt?.target?.value || "avg_utilization");
            this.update();
        });
        document.getElementById("compare-pareto-x-goal")?.addEventListener("change", evt => {
            this._paretoXGoal = String(evt?.target?.value || "min") === "max" ? "max" : "min";
            this.update();
        });
        document.getElementById("compare-pareto-y-goal")?.addEventListener("change", evt => {
            this._paretoYGoal = String(evt?.target?.value || "max") === "min" ? "min" : "max";
            this.update();
        });

        if (systemSel) {
            systemSel.addEventListener("change", () => {
                this._availablePage = 1;
                this.populateRunPicker();
            });
        }
        document.getElementById("compare-run-search").addEventListener("input", () => {
            this._availablePage = 1;
            this.populateRunPicker();
        });
        document.getElementById("compare-run-page-size").addEventListener("change", () => {
            this._availablePage = 1;
            this.populateRunPicker();
        });
        document.getElementById("compare-run-page").addEventListener("change", () => this.populateRunPicker());

        document.getElementById("compare-selected-search").addEventListener("input", () => {
            this._selectedPage = 1;
            this.renderSelectedRuns();
        });
        document.getElementById("compare-selected-page-size").addEventListener("change", () => {
            this._selectedPage = 1;
            this.renderSelectedRuns();
        });
        document.getElementById("compare-selected-page").addEventListener("change", () => this.renderSelectedRuns());

        const selectedBox = document.getElementById("compare-selected");
        selectedBox.addEventListener("click", evt => {
            const btn = evt.target.closest("button[data-remove-run]");
            if (!btn) return;
            this.removeSelectedRun(btn.dataset.removeRun);
        });

        selectedBox.addEventListener("dragstart", evt => {
            const chip = evt.target.closest(".compare-chip[data-run-key]");
            if (!chip) return;
            this._draggingKey = chip.dataset.runKey || "";
            chip.classList.add("dragging");
            if (evt.dataTransfer) {
                evt.dataTransfer.effectAllowed = "move";
                evt.dataTransfer.setData("text/plain", this._draggingKey);
            }
        });

        selectedBox.addEventListener("dragover", evt => {
            if (!this._draggingKey) return;
            evt.preventDefault();
            const chip = evt.target.closest(".compare-chip[data-run-key]");
            this._clearDragHints();
            if (!chip) return;
            if ((chip.dataset.runKey || "") === this._draggingKey) return;
            const rect = chip.getBoundingClientRect();
            const placeAfter = evt.clientX > rect.left + rect.width / 2;
            chip.classList.add(placeAfter ? "drop-after" : "drop-before");
            if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
        });

        selectedBox.addEventListener("drop", evt => {
            if (!this._draggingKey) return;
            evt.preventDefault();
            const fromKey = (evt.dataTransfer && evt.dataTransfer.getData("text/plain")) || this._draggingKey;
            const chip = evt.target.closest(".compare-chip[data-run-key]");
            if (chip && (chip.dataset.runKey || "") !== fromKey) {
                this._reorderSelectedKeys(fromKey, chip.dataset.runKey, chip.classList.contains("drop-after"));
            } else if (!chip) {
                this._moveSelectedKeyToEnd(fromKey);
            }
            this._draggingKey = "";
            this._clearDragHints();
        });

        selectedBox.addEventListener("dragend", () => {
            this._draggingKey = "";
            this._clearDragHints();
        });

        const modeEl = document.getElementById("compare-window-mode");
        const startRange = document.getElementById("compare-window-start-range");
        const endRange = document.getElementById("compare-window-end-range");
        const startInput = document.getElementById("compare-window-start-input");
        const endInput = document.getElementById("compare-window-end-input");
        const resetBtn = document.getElementById("btn-compare-window-reset");

        modeEl?.addEventListener("change", () => {
            this._windowMode = modeEl.value === "absolute" ? "absolute" : "percent";
            this._syncAdvancedControlsToState();
            this.update();
        });

        startRange?.addEventListener("input", () => {
            this._setWindowPct(startRange.value, this._windowEndPct);
            this._syncAdvancedControlsToState();
            this.update();
        });

        endRange?.addEventListener("input", () => {
            this._setWindowPct(this._windowStartPct, endRange.value);
            this._syncAdvancedControlsToState();
            this.update();
        });

        startInput?.addEventListener("change", () => {
            if (this._windowMode === "absolute") {
                const other = Number(endInput?.value || 0);
                this._setWindowFromAbsoluteInputs(startInput.value, other);
            } else {
                this._setWindowPct(startInput.value, this._windowEndPct);
            }
            this._syncAdvancedControlsToState();
            this.update();
        });

        endInput?.addEventListener("change", () => {
            if (this._windowMode === "absolute") {
                const other = Number(startInput?.value || 0);
                this._setWindowFromAbsoluteInputs(other, endInput.value);
            } else {
                this._setWindowPct(this._windowStartPct, endInput.value);
            }
            this._syncAdvancedControlsToState();
            this.update();
        });

        resetBtn?.addEventListener("click", () => {
            this._setWindowPct(0, 100);
            this._syncAdvancedControlsToState();
            this.update();
        });

        const normalizeEl = document.getElementById("compare-overlay-normalize");
        const alignEl = document.getElementById("compare-overlay-align");
        const smoothEl = document.getElementById("compare-overlay-smooth");
        const bandEl = document.getElementById("compare-overlay-band");

        normalizeEl?.addEventListener("change", () => {
            this._overlayNormalizeX = !!normalizeEl.checked;
            this.update();
        });

        alignEl?.addEventListener("change", () => {
            this._overlayAlign = alignEl.value === "peak_queue" ? "peak_queue" : "first_submit";
            this.update();
        });

        smoothEl?.addEventListener("input", () => {
            this._overlaySmoothing = Math.max(0, Math.min(0.95, Number(smoothEl.value || 0)));
            this._syncAdvancedControlsToState();
            this.update();
        });

        bandEl?.addEventListener("change", () => {
            this._overlayBand = !!bandEl.checked;
            this.update();
        });

        document.getElementById("btn-compare-custom-add")?.addEventListener("click", () => this._addCustomMetricFromInputs());
        document.getElementById("btn-compare-custom-remove")?.addEventListener("click", () => this._removeSelectedCustomMetric());

        document.getElementById("btn-compare-session-export")?.addEventListener("click", () => this._exportSession());
        document.getElementById("compare-session-import")?.addEventListener("change", async evt => {
            const file = evt?.target?.files?.[0];
            await this._importSessionFile(file);
            evt.target.value = "";
        });
    },

    async update() {
        const seq = ++this._updateSeq;
        const selectedRuns = this.getSelectedRuns();
        const metric = document.getElementById("compare-metric")?.value || "avg_wait";

        if (!selectedRuns.length) {
            this.clearChart("chart-compare");
            this.clearChart("chart-compare-radar");
            this.clearChart("chart-compare-pareto");
            this.clearChart("chart-compare-wait-cdf");
            this.clearChart("chart-compare-uti");
            this.clearChart("chart-compare-wait-makespan");
            const note = document.getElementById("compare-wait-makespan-note");
            if (note) note.textContent = "";
            const radarNote = document.getElementById("compare-radar-note");
            if (radarNote) radarNote.textContent = "Select at least one run to view the policy trade-off radar.";
            const cdfNote = document.getElementById("compare-wait-cdf-note");
            if (cdfNote) cdfNote.textContent = "Select at least one run to compare wait-time distributions.";
            const note2 = document.getElementById("compare-overlay-note");
            if (note2) note2.textContent = "";
            const note3 = document.getElementById("compare-pareto-note");
            if (note3) note3.textContent = "Select at least two runs to compute a Pareto frontier.";
            this._renderParetoTable(null);
            return;
        }
        try {
            const loaded = await Promise.all(selectedRuns.map(run => App.loadTimeseries(App.runKey(run))));
            if (seq !== this._updateSeq) return;

            const entries = selectedRuns.map((run, i) => {
                const ts = loaded[i] || null;
                const t = Array.isArray(ts?.time) && ts.time.length ? Number(ts.time[ts.time.length - 1] || 0) : Number(run?.makespan || 0);
                return {
                    key: App.runKey(run),
                    run,
                    ts,
                    runEnd: Math.max(0, t),
                };
            });

            this._windowMaxSec = this._safeMaxBy(entries, e => Number(e?.runEnd || 0), 0);
            this._syncAdvancedControlsToState();

            this._latestContextByKey = new Map();
            for (const entry of entries) {
                this._latestContextByKey.set(entry.key, this._buildMetricContext(entry));
            }

            this.renderBar(entries, metric);
            this.renderRadar(entries);
            this.renderPareto(entries);
            await this.renderWaitCdf(entries);
            await this.renderUtiOverlay(entries);
            await this.renderWaitMakespanOverlay(entries);
        } catch (err) {
            if (seq !== this._updateSeq) return;
            console.error("Compare update failed:", err);
            const msg = `Compare update failed: ${err?.message || err}`;
            const note = document.getElementById("compare-overlay-note");
            const note2 = document.getElementById("compare-wait-makespan-note");
            const note3 = document.getElementById("compare-pareto-note");
            const note4 = document.getElementById("compare-radar-note");
            const note5 = document.getElementById("compare-wait-cdf-note");
            if (note) note.textContent = msg;
            if (note2) note2.textContent = msg;
            if (note3) note3.textContent = msg;
            if (note4) note4.textContent = msg;
            if (note5) note5.textContent = msg;
        }
    },
};
