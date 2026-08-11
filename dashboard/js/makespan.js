/* makespan.js - Makespan Lab: manual windowing of a selected run with live updates */

const MakespanLab = {
    charts: {},
    data: [],
    _bound: false,
    _runPage: 1,
    _loadSeq: 0,
    _prepared: null,
    _selectedStartSec: null,
    _selectedEndSec: null,
    _maxChartPoints: 2400,
    _applyQueued: false,

    init(data) {
        this.data = (data || []).map(d => App.normalizeSummaryEntry(d));
        this._bind();
        this._buildPicker();
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
        const el = document.getElementById("mk-run-search");
        return String(el?.value || "").trim().toLowerCase();
    },

    _allRunsSorted() {
        return [...this.data]
            .filter(Boolean)
            .sort((a, b) => App.runLabel(a).localeCompare(App.runLabel(b)));
    },

    _mode() {
        const el = document.getElementById("mk-mode");
        return el?.value === "seconds" ? "seconds" : "percent";
    },

    _setWindowControlsDisabled(disabled) {
        const ids = [
            "mk-mode",
            "mk-start-slider",
            "mk-start-input",
            "mk-end-slider",
            "mk-end-input",
            "mk-reset-window",
        ];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.disabled = !!disabled;
        });
    },

    _bind() {
        if (this._bound) return;
        this._bound = true;

        document.getElementById("mk-run-select")?.addEventListener("change", () => this._loadSelectedRun());
        document.getElementById("mk-run-search")?.addEventListener("input", () => {
            this._runPage = 1;
            this._buildPicker();
        });
        document.getElementById("mk-run-page-size")?.addEventListener("change", () => {
            this._runPage = 1;
            this._buildPicker();
        });
        document.getElementById("mk-run-page")?.addEventListener("change", () => this._buildPicker());

        document.getElementById("mk-mode")?.addEventListener("change", () => {
            this._syncWindowInputs({ keepCurrent: true });
            this._applyWindow();
        });
        document.getElementById("mk-start-slider")?.addEventListener("input", () => this._onSliderInput("start"));
        document.getElementById("mk-end-slider")?.addEventListener("input", () => this._onSliderInput("end"));
        document.getElementById("mk-start-input")?.addEventListener("input", () => this._onInputChange("start"));
        document.getElementById("mk-end-input")?.addEventListener("input", () => this._onInputChange("end"));
        document.getElementById("mk-start-input")?.addEventListener("change", () => this._onInputChange("start"));
        document.getElementById("mk-end-input")?.addEventListener("change", () => this._onInputChange("end"));
        document.getElementById("mk-reset-window")?.addEventListener("click", () => {
            if (!this._prepared) return;
            this._selectedStartSec = 0;
            this._selectedEndSec = this._prepared.maxSec;
            this._syncWindowInputs({ keepCurrent: true });
            this._applyWindow();
        });
    },

    _buildPicker() {
        const sel = document.getElementById("mk-run-select");
        const pageSel = document.getElementById("mk-run-page");
        const pageSizeSel = document.getElementById("mk-run-page-size");
        const countEl = document.getElementById("mk-run-count");
        if (!sel || !pageSel || !pageSizeSel) return;

        const prev = sel.value;
        const allRows = this._allRunsSorted();
        const q = this._runSearchQuery();
        const filteredRows = q
            ? allRows.filter(d => App.runFullLabel(d).toLowerCase().includes(q))
            : allRows;

        const pageSize = this._parsePositiveInt(pageSizeSel.value, 50);
        const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
        const requestedPage = this._parsePositiveInt(pageSel.value || this._runPage, 1);
        const page = Math.min(pageCount, Math.max(1, requestedPage));
        this._runPage = page;

        pageSel.innerHTML = Array.from({ length: pageCount }, (_, i) => {
            const p = i + 1;
            return `<option value="${p}">${p}/${pageCount}</option>`;
        }).join("");
        pageSel.value = String(page);
        pageSel.disabled = filteredRows.length === 0;

        const start = (page - 1) * pageSize;
        const pageRows = filteredRows.slice(start, start + pageSize);
        sel.innerHTML = pageRows.map(d => {
            const key = App.runKey(d);
            const label = App.runFullLabel(d);
            return `<option value="${this._esc(key)}">${this._esc(label)}</option>`;
        }).join("");

        if (pageRows.length) {
            const keep = pageRows.some(d => App.runKey(d) === prev);
            sel.value = keep ? prev : App.runKey(pageRows[0]);
            sel.disabled = false;
        } else {
            sel.innerHTML = '<option value="">No runs match current filter</option>';
            sel.value = "";
            sel.disabled = true;
            this._prepared = null;
            this._selectedStartSec = null;
            this._selectedEndSec = null;
            this._setWindowControlsDisabled(true);
            this._renderSummary(null);
            this._clearCharts();
        }

        if (countEl) {
            const shownFrom = pageRows.length ? start + 1 : 0;
            const shownTo = start + pageRows.length;
            countEl.textContent =
                `Showing ${shownFrom}-${shownTo} of ${filteredRows.length}` +
                (q ? ` filtered (${allRows.length} total)` : "");
        }

        if (sel.value && sel.value !== prev) {
            this._loadSelectedRun();
        } else if (!this._prepared && sel.value) {
            this._loadSelectedRun();
        }
    },

    async _loadSelectedRun() {
        const runKey = document.getElementById("mk-run-select")?.value || "";
        const run = this.data.find(d => App.runKey(d) === runKey) || null;
        const seq = ++this._loadSeq;

        if (!runKey) {
            this._prepared = null;
            this._selectedStartSec = null;
            this._selectedEndSec = null;
            this._setWindowControlsDisabled(true);
            this._renderSummary(null);
            this._clearCharts();
            return;
        }

        let ts = await App.loadTimeseries(runKey);
        if (!ts) {
            try {
                const payload = await App.fetchRun(runKey, { lite: true });
                ts = payload?.timeseries || null;
                if (ts) App.timeseriesCache[runKey] = ts;
            } catch {
                ts = null;
            }
        }

        if (seq !== this._loadSeq) return;

        if (!ts) {
            this._prepared = null;
            this._selectedStartSec = null;
            this._selectedEndSec = null;
            this._setWindowControlsDisabled(true);
            this._renderSummary(run, { noData: true });
            this._clearCharts();
            return;
        }

        this._prepared = this._prepareSeries(run, ts);
        this._selectedStartSec = 0;
        this._selectedEndSec = this._prepared.maxSec;
        this._syncWindowInputs({ keepCurrent: true });
        this._applyWindow();
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

    _prepareSeries(run, ts) {
        const utilRaw = Array.isArray(ts?.utilization) ? ts.utilization.map(v => Number(v || 0) * 100) : [];
        const qDepthRaw = Array.isArray(ts?.queue_depth) ? ts.queue_depth.map(v => Number(v || 0)) : [];
        const qSizeRaw = Array.isArray(ts?.queue_size) ? ts.queue_size.map(v => Number(v || 0)) : [];
        const waitRaw = Array.isArray(ts?.wait_timeline?.avg) ? ts.wait_timeline.avg.map(v => Number(v || 0)) : [];
        const tRaw = Array.isArray(ts?.time) ? ts.time.map(v => Number(v || 0)).filter(v => Number.isFinite(v) && v >= 0) : [];

        const maxLen = Math.max(tRaw.length, utilRaw.length, qDepthRaw.length, qSizeRaw.length, waitRaw.length, 1);
        const fallbackMax = Math.max(1, Number(run?.makespan || 0));

        let timeSec;
        if (tRaw.length >= 2) {
            timeSec = this._resampleLinear(tRaw, maxLen, 0);
            for (let i = 1; i < timeSec.length; i++) {
                if (timeSec[i] < timeSec[i - 1]) timeSec[i] = timeSec[i - 1];
            }
        } else {
            const end = fallbackMax;
            timeSec = Array.from({ length: maxLen }, (_, i) => (
                maxLen > 1 ? (end * i) / (maxLen - 1) : end
            ));
        }

        return {
            run,
            key: App.runKey(run),
            maxSec: Number(timeSec[timeSec.length - 1] || fallbackMax || 1),
            timeSec,
            utilPct: this._resampleLinear(utilRaw, maxLen, 0),
            queueDepth: this._resampleLinear(qDepthRaw, maxLen, 0),
            queueSize: this._resampleLinear(qSizeRaw, maxLen, 0),
            avgWait: this._resampleLinear(waitRaw, maxLen, 0),
        };
    },

    _clamp(v, lo, hi) {
        const n = Number(v);
        if (!Number.isFinite(n)) return lo;
        return Math.max(lo, Math.min(hi, n));
    },

    _mean(values) {
        const arr = (values || []).map(v => Number(v)).filter(v => Number.isFinite(v));
        if (!arr.length) return 0;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
    },

    _scheduleApplyWindow() {
        if (this._applyQueued) return;
        this._applyQueued = true;
        const runner = () => {
            this._applyQueued = false;
            this._applyWindow();
        };
        if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
            window.requestAnimationFrame(runner);
        } else {
            setTimeout(runner, 0);
        }
    },

    _lowerBound(arr, target, lo = 0) {
        let left = Math.max(0, lo | 0);
        let right = Math.max(left, arr.length);
        while (left < right) {
            const mid = (left + right) >> 1;
            if (Number(arr[mid] || 0) < target) left = mid + 1;
            else right = mid;
        }
        return left;
    },

    _downsampleAligned(payload, maxPoints = this._maxChartPoints) {
        const labels = Array.isArray(payload?.labels) ? payload.labels : [];
        const timeSec = Array.isArray(payload?.timeSec) ? payload.timeSec : [];
        const util = Array.isArray(payload?.util) ? payload.util : [];
        const qDepth = Array.isArray(payload?.qDepth) ? payload.qDepth : [];
        const qSize = Array.isArray(payload?.qSize) ? payload.qSize : [];
        const avgWait = Array.isArray(payload?.avgWait) ? payload.avgWait : [];

        const n = labels.length;
        if (!n || n <= maxPoints) {
            return { labels, timeSec, util, qDepth, qSize, avgWait };
        }

        const cap = Math.max(16, Number(maxPoints || this._maxChartPoints));
        const idx = [];
        let prev = -1;
        for (let i = 0; i < cap; i++) {
            let pos = Math.round((i * (n - 1)) / (cap - 1));
            if (pos <= prev) pos = Math.min(n - 1, prev + 1);
            idx.push(pos);
            prev = pos;
            if (pos >= n - 1) break;
        }
        if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);

        const pick = arr => idx.map(i => arr[i]);
        return {
            labels: pick(labels),
            timeSec: pick(timeSec),
            util: pick(util),
            qDepth: pick(qDepth),
            qSize: pick(qSize),
            avgWait: pick(avgWait),
        };
    },

    _max(values) {
        const arr = values || [];
        let has = false;
        let maxVal = 0;
        for (let i = 0; i < arr.length; i++) {
            const n = Number(arr[i]);
            if (!Number.isFinite(n)) continue;
            if (!has || n > maxVal) {
                maxVal = n;
                has = true;
            }
        }
        return has ? maxVal : 0;
    },

    _percentile(values, p) {
        const clean = (values || []).map(v => Number(v)).filter(v => Number.isFinite(v));
        const maxSortPoints = 60000;
        let arr = clean;
        if (clean.length > maxSortPoints) {
            const sampled = [];
            const step = clean.length / maxSortPoints;
            for (let i = 0; i < maxSortPoints; i++) {
                sampled.push(clean[Math.floor(i * step)]);
            }
            arr = sampled;
        }
        arr.sort((a, b) => a - b);
        if (!arr.length) return 0;
        const q = this._clamp(p, 0, 100) / 100;
        const idx = Math.min(arr.length - 1, Math.max(0, Math.floor((arr.length - 1) * q)));
        return arr[idx];
    },

    _syncWindowInputs({ keepCurrent = true } = {}) {
        const startSlider = document.getElementById("mk-start-slider");
        const startInput = document.getElementById("mk-start-input");
        const slider = document.getElementById("mk-end-slider");
        const input = document.getElementById("mk-end-input");
        if (!startSlider || !startInput || !slider || !input) return;

        if (!this._prepared) {
            this._setWindowControlsDisabled(true);
            const hint = document.getElementById("mk-window-hint");
            if (hint) hint.textContent = "Select a run to start adjusting makespan.";
            return;
        }

        this._setWindowControlsDisabled(false);
        const maxSec = Math.max(0, Number(this._prepared.maxSec || 0));
        const mode = this._mode();

        let startSec = keepCurrent && Number.isFinite(this._selectedStartSec)
            ? this._selectedStartSec
            : 0;
        let endSec = keepCurrent && Number.isFinite(this._selectedEndSec)
            ? this._selectedEndSec
            : maxSec;
        startSec = this._clamp(startSec, 0, maxSec);
        endSec = this._clamp(endSec, 0, maxSec);
        if (startSec > endSec) startSec = endSec;
        this._selectedStartSec = startSec;
        this._selectedEndSec = endSec;

        const startPct = maxSec > 0 ? (startSec / maxSec) * 100 : 0;
        const pct = maxSec > 0 ? (endSec / maxSec) * 100 : 100;
        startSlider.min = "0";
        startSlider.max = "100";
        startSlider.step = "0.1";
        startSlider.value = startPct.toFixed(2);
        slider.min = "0";
        slider.max = "100";
        slider.step = "0.1";
        slider.value = pct.toFixed(2);

        if (mode === "percent") {
            startInput.min = "0";
            startInput.max = "100";
            startInput.step = "0.1";
            startInput.value = startPct.toFixed(2);
            input.min = "0";
            input.max = "100";
            input.step = "0.1";
            input.value = pct.toFixed(2);
        } else {
            startInput.min = "0";
            startInput.max = String(Math.max(1, Math.ceil(maxSec)));
            input.min = "0";
            input.max = String(Math.max(1, Math.ceil(maxSec)));
            const step = maxSec > 0 ? Math.max(0.01, maxSec / 1000) : 0.01;
            const stepValue = step < 1 ? step.toFixed(2) : String(Math.round(step));
            startInput.step = stepValue;
            input.step = stepValue;
            startInput.value = startSec.toFixed(2);
            input.value = endSec.toFixed(2);
        }
        this._updateWindowHint();
    },

    _onSliderInput(bound) {
        if (!this._prepared) return;
        const startSlider = document.getElementById("mk-start-slider");
        const slider = document.getElementById("mk-end-slider");
        if (!startSlider || !slider) return;

        const maxSec = Math.max(0, Number(this._prepared.maxSec || 0));
        const startPct = this._clamp(parseFloat(startSlider.value), 0, 100);
        const endPct = this._clamp(parseFloat(slider.value), 0, 100);
        let startSec = maxSec * (startPct / 100);
        let endSec = maxSec * (endPct / 100);
        if (bound === "start" && startSec > endSec) {
            endSec = startSec;
        } else if (bound === "end" && endSec < startSec) {
            startSec = endSec;
        }
        this._selectedStartSec = startSec;
        this._selectedEndSec = endSec;
        this._syncWindowInputs({ keepCurrent: true });
        this._scheduleApplyWindow();
    },

    _onInputChange(bound) {
        if (!this._prepared) return;
        const startInput = document.getElementById("mk-start-input");
        const endInput = document.getElementById("mk-end-input");
        if (!startInput || !endInput) return;

        const maxSec = Math.max(0, Number(this._prepared.maxSec || 0));
        let startSec = this._clamp(this._selectedStartSec, 0, maxSec);
        let endSec = this._clamp(this._selectedEndSec, 0, maxSec);

        if (this._mode() === "percent") {
            const raw = parseFloat(bound === "start" ? startInput.value : endInput.value);
            if (!Number.isFinite(raw)) return;
            const pct = this._clamp(raw, 0, 100);
            const sec = maxSec * (pct / 100);
            if (bound === "start") startSec = sec;
            else endSec = sec;
        } else {
            const raw = parseFloat(bound === "start" ? startInput.value : endInput.value);
            if (!Number.isFinite(raw)) return;
            const sec = this._clamp(raw, 0, maxSec);
            if (bound === "start") startSec = sec;
            else endSec = sec;
        }

        if (startSec > endSec) {
            if (bound === "start") endSec = startSec;
            else startSec = endSec;
        }
        this._selectedStartSec = startSec;
        this._selectedEndSec = endSec;
        this._syncWindowInputs({ keepCurrent: true });
        this._scheduleApplyWindow();
    },

    _updateWindowHint() {
        const hint = document.getElementById("mk-window-hint");
        if (!hint || !this._prepared) return;
        const maxSec = Math.max(0, Number(this._prepared.maxSec || 0));
        const startSec = this._clamp(this._selectedStartSec, 0, maxSec);
        const endSec = this._clamp(this._selectedEndSec, 0, maxSec);
        const spanSec = Math.max(0, endSec - startSec);
        const pct = maxSec > 0 ? (spanSec / maxSec) * 100 : 100;
        hint.textContent = `Window: ${App.formatTime(startSec)} -> ${App.formatTime(endSec)} | Span: ${App.formatTime(spanSec)} (${pct.toFixed(2)}%) of ${App.formatTime(maxSec)}`;
    },

    _applyWindow() {
        if (!this._prepared) {
            this._renderSummary(null);
            this._clearCharts();
            return;
        }

        const n = this._prepared.timeSec.length;
        if (!n) {
            this._renderSummary(this._prepared.run, { noData: true });
            this._clearCharts();
            return;
        }

        const maxSec = Math.max(0, Number(this._prepared.maxSec || 0));
        const startSec = this._clamp(
            Number.isFinite(this._selectedStartSec) ? this._selectedStartSec : 0,
            0,
            maxSec
        );
        const endSec = this._clamp(
            Number.isFinite(this._selectedEndSec) ? this._selectedEndSec : maxSec,
            0,
            maxSec
        );
        let startBound = startSec;
        let endBound = endSec;
        if (startBound > endBound) {
            startBound = endBound;
        }
        this._selectedStartSec = startBound;
        this._selectedEndSec = endBound;
        let startIdx = this._lowerBound(this._prepared.timeSec, startBound, 0);
        if (startIdx >= n) startIdx = n - 1;
        let endIdx = this._lowerBound(this._prepared.timeSec, endBound, startIdx);
        if (endIdx >= n) endIdx = n - 1;
        if (endIdx < startIdx) endIdx = startIdx;

        const sliceTo = endIdx + 1;
        const timeSecFull = this._prepared.timeSec.slice(startIdx, sliceTo);
        const utilFull = this._prepared.utilPct.slice(startIdx, sliceTo);
        const qDepthFull = this._prepared.queueDepth.slice(startIdx, sliceTo);
        const qSizeFull = this._prepared.queueSize.slice(startIdx, sliceTo);
        const avgWaitFull = this._prepared.avgWait.slice(startIdx, sliceTo);

        const chartData = this._downsampleAligned({
            labels: timeSecFull.map(t => App.formatTime(t)),
            timeSec: timeSecFull,
            util: utilFull,
            qDepth: qDepthFull,
            qSize: qSizeFull,
            avgWait: avgWaitFull,
        });
        const selectedSpanSec = Math.max(0, endBound - startBound);

        this._renderSummary(this._prepared.run, {
            originalSec: maxSec,
            startSec: startBound,
            endSec: endBound,
            selectedSec: selectedSpanSec,
            util: utilFull,
            qDepth: qDepthFull,
            avgWait: avgWaitFull,
        });
        this._renderUtilization(chartData.labels, chartData.util);
        this._renderQueue(chartData.labels, chartData.qDepth, chartData.qSize);
        this._renderWait(chartData.labels, chartData.avgWait);
    },

    _renderSummary(run, stats = null) {
        const el = document.getElementById("mk-summary");
        if (!el) return;

        if (!run) {
            el.innerHTML = '<p style="color:#94a3b8;">No run selected.</p>';
            return;
        }

        if (stats?.noData) {
            el.innerHTML = `
                <div class="card"><div class="label">Run</div><div class="value" style="font-size:1rem">${this._esc(App.runBaseLabel(run))}</div></div>
                <div class="card"><div class="label">Status</div><div class="value" style="font-size:1rem">Timeseries unavailable</div></div>
            `;
            return;
        }

        const originalSec = Number(stats?.originalSec || 0);
        const startSec = Number(stats?.startSec || 0);
        const endSec = Number(stats?.endSec || 0);
        const selectedSec = Number(stats?.selectedSec || 0);
        const coverage = originalSec > 0 ? (selectedSec / originalSec) * 100 : 100;
        const avgUtil = this._mean(stats?.util || []);
        const avgQDepth = this._mean(stats?.qDepth || []);
        const peakQDepth = this._max(stats?.qDepth || []);
        const avgWait = this._mean(stats?.avgWait || []);
        const waitP90 = this._percentile(stats?.avgWait || [], 90);

        el.innerHTML = `
            <div class="card"><div class="label">Run</div><div class="value" style="font-size:1rem">${this._esc(App.runBaseLabel(run))}</div></div>
            <div class="card"><div class="label">Original Makespan</div><div class="value">${App.formatTime(originalSec)}</div></div>
            <div class="card"><div class="label">Window Start</div><div class="value">${App.formatTime(startSec)}</div></div>
            <div class="card"><div class="label">Window End</div><div class="value">${App.formatTime(endSec)}</div></div>
            <div class="card"><div class="label">Selected Span</div><div class="value">${App.formatTime(selectedSec)}</div></div>
            <div class="card"><div class="label">Coverage</div><div class="value">${coverage.toFixed(2)}%</div></div>
            <div class="card"><div class="label">Avg Util (Window)</div><div class="value">${avgUtil.toFixed(2)}%</div></div>
            <div class="card"><div class="label">Avg Queue Depth</div><div class="value">${avgQDepth.toFixed(2)}</div></div>
            <div class="card"><div class="label">Peak Queue Depth</div><div class="value">${Math.round(peakQDepth).toLocaleString()}</div></div>
            <div class="card"><div class="label">Avg Wait (Window)</div><div class="value">${App.formatTime(avgWait)}</div></div>
            <div class="card"><div class="label">Wait p90 (Window)</div><div class="value">${App.formatTime(waitP90)}</div></div>
        `;
    },

    _renderUtilization(labels, utilPct) {
        const id = "chart-mk-util";
        const ctx = document.getElementById(id);
        this._clearChart(id);
        if (!ctx || !labels.length) return;

        this.charts[id] = new Chart(ctx, {
            type: "line",
            data: {
                labels,
                datasets: [{
                    label: "Utilization",
                    data: utilPct,
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
        App.enableLineChartZoom(this.charts[id], { xScaleId: "x", minWindow: 20, zoomFactor: 0.55 });
    },

    _renderQueue(labels, queueDepth, queueSize) {
        const id = "chart-mk-queue";
        const ctx = document.getElementById(id);
        this._clearChart(id);
        if (!ctx || !labels.length) return;

        const datasets = [{
            label: "Queue Depth",
            data: queueDepth,
            borderColor: "#f59e0b",
            backgroundColor: "#f59e0b2a",
            fill: true,
            pointRadius: 0,
            borderWidth: 1.4,
            tension: 0.18,
            yAxisID: "y",
        }];

        if ((queueSize || []).some(v => Number(v || 0) > 0)) {
            datasets.push({
                label: "Queue Size (procs)",
                data: queueSize,
                borderColor: "#38bdf8",
                backgroundColor: "transparent",
                fill: false,
                pointRadius: 0,
                borderWidth: 1.3,
                tension: 0.18,
                yAxisID: "y1",
            });
        }

        this.charts[id] = new Chart(ctx, {
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
        App.enableLineChartZoom(this.charts[id], { xScaleId: "x", minWindow: 20, zoomFactor: 0.55 });
    },

    _renderWait(labels, avgWait) {
        const id = "chart-mk-wait";
        const ctx = document.getElementById(id);
        this._clearChart(id);
        if (!ctx || !labels.length) return;

        this.charts[id] = new Chart(ctx, {
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
                labels,
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
                                return `Time ${labels[idx] || "-"}`;
                            },
                            label: item => ` Avg Wait: ${App.formatTime(item.raw || 0)}`,
                        },
                    },
                },
            },
        });
        App.enableLineChartZoom(this.charts[id], { xScaleId: "x", minWindow: 8, zoomFactor: 0.5 });
    },

    _clearChart(id) {
        if (this.charts[id]) {
            this.charts[id].destroy();
            delete this.charts[id];
        }
    },

    _clearCharts() {
        this._clearChart("chart-mk-util");
        this._clearChart("chart-mk-queue");
        this._clearChart("chart-mk-wait");
    },
};
