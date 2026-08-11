/* setup.js - CQTwin setup wizard: files, presets, params, run polling */

const DEFAULT_FORM = {
    read_num: -1,
    output_mode: "new",
    alg: "w,+,2",
    algorithm: "fcfs",
    alg_sign: "1,0,1",
    backfill: 2,
    win: 5,
    win_para: "5,0,0",
    bf_para: "",
    ad_bf: 0,
    ad_win: 0,
    ad_alg: 0,
    ad_win_para: "",
    ad_bf_para: "ad_bf_para.set",
    ad_alg_para: "",
    start: 0,
    anchor: 0,
    start_date: "None",
    monitor: 500,
    read_input_freq: 1000,
    log_freq: 1,
    cluster_fraction: 1.0,
    debug_lvl: 3,
    pre_name: "CQSIM_",
    output: "",
    debug: "",
    job_save: "",
    node_save: "",
    config_n: "config_n.set",
    config_sys: "config_sys.set",
    ext_fmt_j: ".csv",
    ext_fmt_n: ".csv",
    ext_fmt_j_c: ".con",
    ext_fmt_n_c: ".con",
    path_in: "InputFiles/",
    path_out: "Results/",
    path_fmt: "Fmt/",
    path_debug: "Debug/",
    ext_jr: ".rst",
    ext_si: ".ult",
    ext_ai: ".adp",
    ext_debug: ".log",
    sweep_backfills: "2,1,0",
    sweep_windows: "16,64,128",
    sweep_max_runs: 18,
};

const BATCH_ALL_SWF = "__ALL_SWF__";
const POLICY_ALIASES = {
    "w,+,2": "fcfs",
    "w": "fcfs",
    "t": "sjf",
    "-t": "ljf",
    "w/t": "wfp1",
    "(n*(w/(t if t>0 else 1))**3)": "wfp3",
    "weighted_wait2": "fcfs",
    "fifo_wait": "fcfs",
    "wait_time_ratio": "wfp1",
    "wfp_alcf": "wfp3",
};
const SWEEP_POLICY_PRESETS = {
    "fcfs": { label: "fcfs", alg_sign: "1" },
    "lcfs": { label: "lcfs", alg_sign: "1" },
    "sjf": { label: "sjf", alg_sign: "1" },
    "ljf": { label: "ljf", alg_sign: "1" },
    "srf": { label: "srf", alg_sign: "1" },
    "lrf": { label: "lrf", alg_sign: "1" },
    "scf": { label: "scf", alg_sign: "1" },
    "lcf": { label: "lcf", alg_sign: "1" },
    "wfp1": { label: "wfp1", alg_sign: "1" },
    "wfp2": { label: "wfp2", alg_sign: "1" },
    "wfp3": { label: "wfp3", alg_sign: "1" },
    "sww": { label: "sww", alg_sign: "1" },
    "fcsj": { label: "fcsj", alg_sign: "1" },
    "fat": { label: "fat", alg_sign: "1" },
    "unicep": { label: "unicep", alg_sign: "1" },
    "f1": { label: "f1", alg_sign: "1" },
    "f2": { label: "f2", alg_sign: "1" },
    "f3": { label: "f3", alg_sign: "1" },
    "f4": { label: "f4", alg_sign: "1" },
    "bsld": { label: "bsld", alg_sign: "1" },
};

function normalizePolicyName(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return DEFAULT_FORM.algorithm;
    return POLICY_ALIASES[raw] || raw;
}

const Setup = {
    runId: null,
    pollTimer: null,
    batchMode: false,
    batchAbort: false,
    _bound: false,

    async init() {
        await this._loadFiles();
        this._bindEvents();
    },

    async _loadFiles() {
        try {
            const payload = await fetch("/api/files").then(r => r.json());
            const files = payload.files || [];
            const swfFiles = files.filter(f => f.toLowerCase().endsWith(".swf"));

            const jobSel = document.getElementById("sel-job-trace");
            const nodeSel = document.getElementById("sel-node-struc");
            const prevJob = jobSel.value;
            const prevNode = nodeSel.value;
            if (!files.length) {
                jobSel.innerHTML = '<option value="">No input files found</option>';
                nodeSel.innerHTML = '<option value="">No node files found</option>';
                document.getElementById("btn-run-sim").disabled = true;
                return;
            }

            jobSel.innerHTML = [
                `<option value="${BATCH_ALL_SWF}">[Batch] Run all .swf files</option>`,
                ...files.map(f => `<option value="${f}">${f}</option>`),
            ].join("");

            nodeSel.innerHTML = [
                '<option value="">Auto per trace</option>',
                ...files.map(f => `<option value="${f}">${f}</option>`),
            ].join("");

            const jobOpts = [...jobSel.options].map(o => o.value);
            const nodeOpts = [...nodeSel.options].map(o => o.value);
            jobSel.value = jobOpts.includes(prevJob) ? prevJob : (files[0] || BATCH_ALL_SWF);
            nodeSel.value = nodeOpts.includes(prevNode) ? prevNode : "";

            // The Online workspace (its own tab) owns its trace picker + launch
            // button; hand it the same file lists so it needs no second fetch.
            if (typeof Online !== "undefined") Online.populateTraces(files, swfFiles);

            this._autoSelectNode();
            document.getElementById("btn-run-sim").disabled = swfFiles.length === 0;
        } catch {
            document.getElementById("sel-job-trace").innerHTML =
                '<option value="">API unreachable - start python3 dashboard/serve.py</option>';
            const status = document.getElementById("upload-status");
            if (status) {
                status.textContent = "Cannot reach backend API. Start server and refresh.";
            }
        }
    },

    _networkHint(err) {
        const msg = String(err?.message || err || "");
        if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
            return " Cannot reach backend API. Start `python3 dashboard/serve.py` and refresh.";
        }
        return "";
    },

    _autoSelectNode() {
        const jobVal = document.getElementById("sel-job-trace").value;
        const nodeSel = document.getElementById("sel-node-struc");
        const files = [...nodeSel.options].map(o => o.value);

        if (jobVal === BATCH_ALL_SWF) {
            nodeSel.value = "";
            return;
        }

        nodeSel.value = this._pickNodeForJob(jobVal, files);
    },

    _pickNodeForJob(jobTrace, allFiles) {
        if (!jobTrace || jobTrace === BATCH_ALL_SWF) return "";
        const files = new Set(allFiles || []);

        let base = jobTrace.replace(/\.swf$/i, "");
        base = base.split("__")[0];
        base = base.replace(/_p\d+$/i, "");
        const normKey = /_norm$/i.test(base) ? base : (base + "_norm");

        if (files.has(normKey)) return normKey;
        if (files.has(jobTrace)) return jobTrace;
        return "";
    },

    _bindEvents() {
        if (this._bound) return;
        this._bound = true;

        document.getElementById("sel-job-trace").addEventListener("change", () => {
            this._autoSelectNode();
        });

        const presetSel = document.getElementById("sel-alg-preset");
        presetSel.addEventListener("change", () => {
            const opt = presetSel.selectedOptions[0];
            if (!document.getElementById("inp-alg-custom").value.trim()) {
                document.getElementById("inp-alg-sign").value = opt?.dataset.sign || DEFAULT_FORM.alg_sign;
            }
        });

        document.getElementById("file-upload-input").addEventListener("change", async e => {
            const file = e.target.files[0];
            if (!file) return;

            const status = document.getElementById("upload-status");
            status.textContent = "Uploading...";
            try {
                const resp = await fetch("/api/upload", {
                    method: "POST",
                    headers: {
                        "Content-Length": file.size,
                        "X-Filename": file.name,
                    },
                    body: file,
                });
                const data = await resp.json();
                if (data.error) throw new Error(data.error);

                status.textContent = `Uploaded: ${data.filename}`;
                await this._loadFiles();
                document.getElementById("sel-job-trace").value = data.filename;
                this._autoSelectNode();
            } catch (err) {
                status.textContent = "Upload failed: " + err.message;
            }
        });

        document.getElementById("btn-save-preset").addEventListener("click", () => this._savePreset());
        document.getElementById("btn-load-preset").addEventListener("click", () => this._loadPreset());
        document.getElementById("btn-view-results").addEventListener("click", () => this._viewExistingResults());
        document.getElementById("btn-reset-preset").addEventListener("click", () => this._resetPreset());
        document.getElementById("btn-run-sweep").addEventListener("click", () => this._startSweep());
        document.getElementById("btn-clear-results").addEventListener("click", () => this._clearAllResults());
        document.getElementById("btn-preview-delete-results").addEventListener("click", () => this._previewDeleteMatches());
        document.getElementById("btn-delete-results").addEventListener("click", () => this._deleteMatchingResults());
        document.getElementById("preset-file-input").addEventListener("change", e => this._onPresetFilePicked(e));

        document.getElementById("btn-run-sim").addEventListener("click", () => this._startRun());
        document.getElementById("btn-cancel").addEventListener("click", () => this._cancelRun());
        // Online mode lives in its own tab now; the wizard just opens it.
        const openOnline = document.getElementById("btn-open-online");
        if (openOnline) openOnline.addEventListener("click", () => App.enterOnline());
    },

    _collectParams() {
        const presetSel = document.getElementById("sel-alg-preset");
        const presetOpt = presetSel.selectedOptions[0];
        const presetAlg = normalizePolicyName(presetSel.value);
        const presetLegacy = String(presetOpt?.dataset.legacy || presetSel.value || DEFAULT_FORM.alg).trim();
        const customAlg = document.getElementById("inp-alg-custom").value.trim();
        const rawAlg = customAlg || presetLegacy || DEFAULT_FORM.alg;
        const alg = normalizePolicyName(rawAlg) || DEFAULT_FORM.algorithm;

        const parseIntOr = (id, fallback) => {
            const v = parseInt(document.getElementById(id).value, 10);
            return Number.isFinite(v) ? v : fallback;
        };

        const parseFloatOr = (id, fallback) => {
            const v = parseFloat(document.getElementById(id).value);
            return Number.isFinite(v) ? v : fallback;
        };

        const nodeCount = parseInt(document.getElementById("inp-node-count").value, 10);
        const procsPerNode = parseInt(document.getElementById("inp-procs-per-node").value, 10);

        return {
            run_label: document.getElementById("inp-run-label").value.trim(),
            output_mode: document.getElementById("sel-output-mode").value,

            job_trace: document.getElementById("sel-job-trace").value,
            node_struc: document.getElementById("sel-node-struc").value,
            read_num: parseIntOr("inp-read-num", DEFAULT_FORM.read_num),

            alg: rawAlg || DEFAULT_FORM.alg,
            algorithm: alg || DEFAULT_FORM.algorithm,
            alg_sign: document.getElementById("inp-alg-sign").value.trim() || DEFAULT_FORM.alg_sign,

            backfill: parseIntOr("sel-backfill", DEFAULT_FORM.backfill),
            win: parseIntOr("inp-win", DEFAULT_FORM.win),
            win_para: document.getElementById("inp-win-para").value.trim() || DEFAULT_FORM.win_para,
            bf_para: document.getElementById("inp-bf-para").value.trim(),

            ad_bf: parseIntOr("sel-ad-bf", DEFAULT_FORM.ad_bf),
            ad_win: parseIntOr("sel-ad-win", DEFAULT_FORM.ad_win),
            ad_alg: parseIntOr("sel-ad-alg", DEFAULT_FORM.ad_alg),
            ad_win_para: document.getElementById("inp-ad-win-para").value.trim(),
            ad_bf_para: document.getElementById("inp-ad-bf-para").value.trim() || DEFAULT_FORM.ad_bf_para,
            ad_alg_para: document.getElementById("inp-ad-alg-para").value.trim(),

            start: parseIntOr("inp-start", DEFAULT_FORM.start),
            anchor: parseIntOr("inp-anchor", DEFAULT_FORM.anchor),
            start_date: document.getElementById("inp-start-date").value.trim() || DEFAULT_FORM.start_date,

            cluster_fraction: parseFloatOr("inp-frac", DEFAULT_FORM.cluster_fraction),
            monitor: parseIntOr("inp-monitor", DEFAULT_FORM.monitor),
            read_input_freq: parseIntOr("inp-read-input-freq", DEFAULT_FORM.read_input_freq),
            log_freq: parseIntOr("inp-log-freq", DEFAULT_FORM.log_freq),
            debug_lvl: parseIntOr("inp-debug-lvl", DEFAULT_FORM.debug_lvl),
            pre_name: document.getElementById("inp-pre-name").value.trim() || DEFAULT_FORM.pre_name,
            output: document.getElementById("inp-output").value.trim(),
            debug: document.getElementById("inp-debug").value.trim(),
            job_save: document.getElementById("inp-job-save").value.trim(),
            node_save: document.getElementById("inp-node-save").value.trim(),
            config_n: document.getElementById("inp-config-n").value.trim() || DEFAULT_FORM.config_n,
            config_sys: document.getElementById("inp-config-sys").value.trim() || DEFAULT_FORM.config_sys,
            ext_fmt_j: document.getElementById("inp-ext-fmt-j").value.trim() || DEFAULT_FORM.ext_fmt_j,
            ext_fmt_n: document.getElementById("inp-ext-fmt-n").value.trim() || DEFAULT_FORM.ext_fmt_n,
            ext_fmt_j_c: document.getElementById("inp-ext-fmt-j-c").value.trim() || DEFAULT_FORM.ext_fmt_j_c,
            ext_fmt_n_c: document.getElementById("inp-ext-fmt-n-c").value.trim() || DEFAULT_FORM.ext_fmt_n_c,
            path_in: document.getElementById("inp-path-in").value.trim() || DEFAULT_FORM.path_in,
            path_out: document.getElementById("inp-path-out").value.trim() || DEFAULT_FORM.path_out,
            path_fmt: document.getElementById("inp-path-fmt").value.trim() || DEFAULT_FORM.path_fmt,
            path_debug: document.getElementById("inp-path-debug").value.trim() || DEFAULT_FORM.path_debug,
            ext_jr: document.getElementById("inp-ext-jr").value.trim() || DEFAULT_FORM.ext_jr,
            ext_si: document.getElementById("inp-ext-si").value.trim() || DEFAULT_FORM.ext_si,
            ext_ai: document.getElementById("inp-ext-ai").value.trim() || DEFAULT_FORM.ext_ai,
            ext_debug: document.getElementById("inp-ext-debug").value.trim() || DEFAULT_FORM.ext_debug,

            node_count: Number.isFinite(nodeCount) ? nodeCount : null,
            procs_per_node: Number.isFinite(procsPerNode) ? procsPerNode : null,
        };
    },

    _snapshotForPreset() {
        const p = this._collectParams();
        return {
            run_label: p.run_label,
            job_trace: p.job_trace,
            node_struc: p.node_struc,
            output_mode: p.output_mode,
            read_num: p.read_num,
            alg: p.alg,
            algorithm: p.algorithm,
            alg_sign: p.alg_sign,
            backfill: p.backfill,
            win: p.win,
            win_para: p.win_para,
            bf_para: p.bf_para,
            ad_bf: p.ad_bf,
            ad_win: p.ad_win,
            ad_alg: p.ad_alg,
            ad_win_para: p.ad_win_para,
            ad_bf_para: p.ad_bf_para,
            ad_alg_para: p.ad_alg_para,
            start: p.start,
            anchor: p.anchor,
            start_date: p.start_date,
            cluster_fraction: p.cluster_fraction,
            monitor: p.monitor,
            read_input_freq: p.read_input_freq,
            log_freq: p.log_freq,
            debug_lvl: p.debug_lvl,
            pre_name: p.pre_name,
            output: p.output,
            debug: p.debug,
            job_save: p.job_save,
            node_save: p.node_save,
            config_n: p.config_n,
            config_sys: p.config_sys,
            ext_fmt_j: p.ext_fmt_j,
            ext_fmt_n: p.ext_fmt_n,
            ext_fmt_j_c: p.ext_fmt_j_c,
            ext_fmt_n_c: p.ext_fmt_n_c,
            path_in: p.path_in,
            path_out: p.path_out,
            path_fmt: p.path_fmt,
            path_debug: p.path_debug,
            ext_jr: p.ext_jr,
            ext_si: p.ext_si,
            ext_ai: p.ext_ai,
            ext_debug: p.ext_debug,
            sweep_backfills: document.getElementById("inp-sweep-backfills").value.trim() || DEFAULT_FORM.sweep_backfills,
            sweep_windows: document.getElementById("inp-sweep-wins").value.trim() || DEFAULT_FORM.sweep_windows,
            sweep_max_runs: parseInt(document.getElementById("inp-sweep-max-runs").value, 10) || DEFAULT_FORM.sweep_max_runs,
            sweep_policies: [...document.querySelectorAll('input[name="sweep-policy"]:checked')].map(el => el.value),
        };
    },

    _applyParams(p = {}) {
        const get = (k, d) => (p[k] !== undefined && p[k] !== null ? p[k] : d);

        const jobSel = document.getElementById("sel-job-trace");
        const nodeSel = document.getElementById("sel-node-struc");
        const pickedJob = String(get("job_trace", ""));
        const pickedNode = String(get("node_struc", ""));
        if (pickedJob && [...jobSel.options].some(o => o.value === pickedJob)) {
            jobSel.value = pickedJob;
        }
        if (pickedNode && [...nodeSel.options].some(o => o.value === pickedNode)) {
            nodeSel.value = pickedNode;
        } else {
            this._autoSelectNode();
        }

        document.getElementById("inp-run-label").value = get("run_label", "");
        document.getElementById("sel-output-mode").value = get("output_mode", DEFAULT_FORM.output_mode);
        document.getElementById("inp-read-num").value = get("read_num", DEFAULT_FORM.read_num);

        const rawAlg = String(get("alg", get("algorithm", DEFAULT_FORM.alg)));
        const alg = normalizePolicyName(rawAlg);
        const presetSel = document.getElementById("sel-alg-preset");
        const hasPreset = [...presetSel.options].some(o => o.value === alg);
        presetSel.value = hasPreset ? alg : DEFAULT_FORM.algorithm;
        const selectedLegacy = presetSel.selectedOptions[0]?.dataset.legacy || presetSel.value || DEFAULT_FORM.alg;
        document.getElementById("inp-alg-custom").value = (rawAlg !== alg && rawAlg !== selectedLegacy) ? rawAlg : "";

        document.getElementById("inp-alg-sign").value = get("alg_sign", DEFAULT_FORM.alg_sign);
        document.getElementById("sel-backfill").value = String(get("backfill", DEFAULT_FORM.backfill));
        document.getElementById("inp-win").value = get("win", DEFAULT_FORM.win);
        document.getElementById("inp-win-para").value = get("win_para", DEFAULT_FORM.win_para);
        document.getElementById("inp-bf-para").value = get("bf_para", DEFAULT_FORM.bf_para);

        document.getElementById("sel-ad-bf").value = String(get("ad_bf", DEFAULT_FORM.ad_bf));
        document.getElementById("sel-ad-win").value = String(get("ad_win", DEFAULT_FORM.ad_win));
        document.getElementById("sel-ad-alg").value = String(get("ad_alg", DEFAULT_FORM.ad_alg));
        document.getElementById("inp-ad-win-para").value = get("ad_win_para", DEFAULT_FORM.ad_win_para);
        document.getElementById("inp-ad-bf-para").value = get("ad_bf_para", DEFAULT_FORM.ad_bf_para);
        document.getElementById("inp-ad-alg-para").value = get("ad_alg_para", DEFAULT_FORM.ad_alg_para);

        document.getElementById("inp-start").value = get("start", DEFAULT_FORM.start);
        document.getElementById("inp-anchor").value = get("anchor", DEFAULT_FORM.anchor);
        const sd = String(get("start_date", DEFAULT_FORM.start_date));
        document.getElementById("inp-start-date").value = sd === "None" ? "" : sd;

        document.getElementById("inp-frac").value = get("cluster_fraction", DEFAULT_FORM.cluster_fraction);
        document.getElementById("inp-monitor").value = get("monitor", DEFAULT_FORM.monitor);
        document.getElementById("inp-read-input-freq").value = get("read_input_freq", DEFAULT_FORM.read_input_freq);
        document.getElementById("inp-log-freq").value = get("log_freq", DEFAULT_FORM.log_freq);
        document.getElementById("inp-debug-lvl").value = get("debug_lvl", DEFAULT_FORM.debug_lvl);
        document.getElementById("inp-pre-name").value = get("pre_name", DEFAULT_FORM.pre_name);
        document.getElementById("inp-output").value = get("output", DEFAULT_FORM.output);
        document.getElementById("inp-debug").value = get("debug", DEFAULT_FORM.debug);
        document.getElementById("inp-job-save").value = get("job_save", DEFAULT_FORM.job_save);
        document.getElementById("inp-node-save").value = get("node_save", DEFAULT_FORM.node_save);
        document.getElementById("inp-config-n").value = get("config_n", DEFAULT_FORM.config_n);
        document.getElementById("inp-config-sys").value = get("config_sys", DEFAULT_FORM.config_sys);
        document.getElementById("inp-ext-fmt-j").value = get("ext_fmt_j", DEFAULT_FORM.ext_fmt_j);
        document.getElementById("inp-ext-fmt-n").value = get("ext_fmt_n", DEFAULT_FORM.ext_fmt_n);
        document.getElementById("inp-ext-fmt-j-c").value = get("ext_fmt_j_c", DEFAULT_FORM.ext_fmt_j_c);
        document.getElementById("inp-ext-fmt-n-c").value = get("ext_fmt_n_c", DEFAULT_FORM.ext_fmt_n_c);
        document.getElementById("inp-path-in").value = get("path_in", DEFAULT_FORM.path_in);
        document.getElementById("inp-path-out").value = get("path_out", DEFAULT_FORM.path_out);
        document.getElementById("inp-path-fmt").value = get("path_fmt", DEFAULT_FORM.path_fmt);
        document.getElementById("inp-path-debug").value = get("path_debug", DEFAULT_FORM.path_debug);
        document.getElementById("inp-ext-jr").value = get("ext_jr", DEFAULT_FORM.ext_jr);
        document.getElementById("inp-ext-si").value = get("ext_si", DEFAULT_FORM.ext_si);
        document.getElementById("inp-ext-ai").value = get("ext_ai", DEFAULT_FORM.ext_ai);
        document.getElementById("inp-ext-debug").value = get("ext_debug", DEFAULT_FORM.ext_debug);

        document.getElementById("inp-sweep-backfills").value = get("sweep_backfills", DEFAULT_FORM.sweep_backfills);
        document.getElementById("inp-sweep-wins").value = get("sweep_windows", DEFAULT_FORM.sweep_windows);
        document.getElementById("inp-sweep-max-runs").value = get("sweep_max_runs", DEFAULT_FORM.sweep_max_runs);

        const selectedSweepPolicies = Array.isArray(p.sweep_policies) && p.sweep_policies.length
            ? new Set(p.sweep_policies.map(normalizePolicyName))
            : new Set(["fcfs"]);
        let checkedCount = 0;
        document.querySelectorAll('input[name="sweep-policy"]').forEach(el => {
            el.checked = selectedSweepPolicies.has(el.value);
            if (el.checked) checkedCount += 1;
        });
        if (!checkedCount) {
            const fallback = document.querySelector('input[name="sweep-policy"][value="fcfs"]');
            if (fallback) fallback.checked = true;
        }
    },

    async _savePreset() {
        const status = document.getElementById("upload-status");

        const now = new Date();
        const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
        const defaultName = `preset_${stamp}.json`;
        const entered = window.prompt("Preset file name (saved in dashboard/preset/):", defaultName);
        if (!entered) {
            status.textContent = "Preset save cancelled.";
            return;
        }

        try {
            const resp = await fetch("/api/presets/save", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    filename: entered,
                    preset: this._snapshotForPreset(),
                }),
            });
            const data = await resp.json();
            if (!resp.ok || data.error) throw new Error(data.error || "Failed to save preset");
            status.textContent = `Preset saved: ${data.filename}`;
        } catch (err) {
            status.textContent = "Preset save failed: " + err.message + this._networkHint(err);
        }
    },

    _loadPreset() {
        const input = document.getElementById("preset-file-input");
        input.value = "";
        input.click();
    },

    async _onPresetFilePicked(event) {
        const file = event.target.files && event.target.files[0];
        if (!file) return;

        const status = document.getElementById("upload-status");
        status.textContent = `Loading preset: ${file.name}...`;
        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            const preset = (parsed && typeof parsed.preset === "object") ? parsed.preset : parsed;
            if (!preset || typeof preset !== "object") {
                throw new Error("Preset file format is invalid.");
            }
            this._applyParams(preset);
            status.textContent = `Preset loaded from file: ${file.name}`;
        } catch (err) {
            status.textContent = "Preset load failed: " + err.message;
        }
    },

    _resetPreset() {
        this._applyParams(DEFAULT_FORM);
        document.getElementById("inp-run-label").value = "";
        document.getElementById("inp-node-count").value = "";
        document.getElementById("inp-procs-per-node").value = "";
        document.getElementById("clear-results-status").textContent = "";
        document.getElementById("delete-results-status").textContent = "";
        document.getElementById("inp-delete-results-keyword").value = "";
        this._setDeletePreview("");
        document.getElementById("sweep-status").textContent = "";
        const status = document.getElementById("upload-status");
        status.textContent = "Defaults restored.";
    },

    async _refreshHistoricalData({ fast = false } = {}) {
        const qs = fast ? "?fast=1" : "";
        const resp = await fetch(`/api/historical${qs}`, { cache: "no-store" });
        const payload = await resp.json();
        if (!resp.ok || payload?.error) {
            throw new Error(payload?.error || `HTTP ${resp.status}`);
        }
        const hydrated = App._hydrateHistorical(payload.summary || [], payload.worklog || []);
        App.summaryData = hydrated.summary;
        App.worklogData = hydrated.worklog;
        return payload;
    },

    async _rebuildHistoricalIndex() {
        const resp = await fetch("/api/rebuild-index", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ force: true }),
        });
        const payload = await resp.json();
        if (!resp.ok || payload?.error) {
            throw new Error(payload?.error || `HTTP ${resp.status}`);
        }
        return payload;
    },

    _pickLatestHistoricalRun() {
        const worklogLatest = (App.worklogData || [])
            .filter(w => w && w.run_name)
            .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))[0];

        if (worklogLatest?.run_name) return String(worklogLatest.run_name);
        const last = App.summaryData[App.summaryData.length - 1];
        return last ? App.runKey(last) : "";
    },

    async _viewExistingResults() {
        const status = document.getElementById("upload-status");
        status.textContent = "Opening existing results...";

        if (!App.summaryData.length && !App.worklogData.length) {
            status.textContent = "Loading indexed run list...";
            try {
                await App.loadHistorical({ fast: true });
                if (!App.summaryData.length && !App.worklogData.length) {
                    await App.loadHistorical({ fast: false });
                }
            } catch (err) {
                status.textContent = "Failed to load run list: " + err.message + this._networkHint(err);
                return;
            }
        }

        if (!App.summaryData.length && !App.worklogData.length) {
            status.textContent = "No existing results found yet.";
            return;
        }

        let runName = String(this._pickLatestHistoricalRun() || "").trim();
        if (!runName) {
            status.textContent = "Could not resolve a run name from historical data.";
            return;
        }

        status.textContent = `Loading existing result: ${runName}...`;
        const loadRun = async name => {
            return App.fetchRun(name, { lite: true });
        };

        try {
            const result = await loadRun(runName);
            App.setResultData(result);
            App.setState("RESULTS");
            status.textContent = `Loaded existing result: ${runName}`;
        } catch (err) {
            status.textContent = "Selected result failed to load. Refreshing index once...";
            try {
                await App.loadHistorical({ fast: false });
                runName = String(this._pickLatestHistoricalRun() || "").trim();
                if (!runName) throw new Error("No runs available after refresh.");
                const result = await loadRun(runName);
                App.setResultData(result);
                App.setState("RESULTS");
                status.textContent = `Loaded existing result after refresh: ${runName}`;
            } catch (retryErr) {
                status.textContent = "Failed to load existing result: " + retryErr.message + this._networkHint(retryErr);
            }
        }
    },

    _setProgressUI({ pct = 0, stage = "Queued", elapsed = 0, title = "", log = [] } = {}) {
        const p = Math.max(0, Math.min(100, Number(pct) || 0));
        document.getElementById("prog-bar").style.width = `${p}%`;
        document.getElementById("prog-pct").textContent = `${p}%`;
        document.getElementById("prog-stage").textContent = stage || "Running";
        document.getElementById("prog-elapsed").textContent = App.formatTime(elapsed || 0);
        document.getElementById("prog-filename").textContent = title || "";

        const logEl = document.getElementById("prog-log");
        if (Array.isArray(log) && log.length) {
            logEl.textContent = log.slice(-20).join("\n");
            logEl.scrollTop = logEl.scrollHeight;
        } else if (!logEl.textContent) {
            logEl.textContent = "No logs yet.";
        }
    },

    async _clearAllResults() {
        const status = document.getElementById("clear-results-status");
        const btn = document.getElementById("btn-clear-results");

        const first = window.confirm(
            "This will delete all simulation outputs and dashboard processed summaries. Continue?"
        );
        if (!first) {
            status.textContent = "Clear cancelled.";
            return;
        }

        const typed = window.prompt("Type DELETE to confirm permanent deletion:");
        if (typed !== "DELETE") {
            status.textContent = "Second confirmation failed. Nothing deleted.";
            return;
        }

        btn.disabled = true;
        status.textContent = "Clearing result files...";

        try {
            const resp = await fetch("/api/clear-results", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ confirm_phrase: "DELETE_ALL_RESULTS" }),
            });
            const data = await resp.json();
            if (!resp.ok || data.error) throw new Error(data.error || "Failed to clear results");

            status.textContent =
                `Cleared: ${data.deleted?.results_entries || 0} result entries, ` +
                `${data.deleted?.timeseries_entries || 0} timeseries entries, ` +
                `${data.deleted?.metadata_files || 0} metadata files.`;
            this._setDeletePreview("");

            App.summaryData = [];
            App.worklogData = [];
            App.timeseriesCache = {};
            App.currentResult = null;
            Worklog.init([]);
        } catch (err) {
            status.textContent = "Clear failed: " + err.message + this._networkHint(err);
        } finally {
            btn.disabled = false;
        }
    },

    _setDeletePreview(text) {
        const box = document.getElementById("delete-results-preview");
        if (!box) return;
        const msg = String(text || "").trim();
        if (!msg) {
            box.textContent = "";
            box.classList.add("hidden");
            return;
        }
        box.textContent = msg;
        box.classList.remove("hidden");
    },

    async _previewDeleteMatches() {
        const keywordEl = document.getElementById("inp-delete-results-keyword");
        const status = document.getElementById("delete-results-status");
        const btn = document.getElementById("btn-preview-delete-results");
        const keyword = String(keywordEl?.value || "").trim();

        if (!keyword) {
            status.textContent = "Enter a keyword first.";
            this._setDeletePreview("");
            return;
        }

        btn.disabled = true;
        status.textContent = `Previewing runs matching "${keyword}"...`;
        this._setDeletePreview("");

        try {
            const qs = new URLSearchParams({
                keyword,
                limit: "80",
            });
            const resp = await fetch(`/api/delete-results/preview?${qs.toString()}`, { cache: "no-store" });
            const raw = await resp.text();
            let data = null;
            try {
                data = JSON.parse(raw);
            } catch {
                throw new Error("Preview API returned non-JSON. Restart backend server and try again.");
            }
            if (!resp.ok || data.error) {
                throw new Error(data.error || "Failed to preview matches");
            }

            const totalMatches = Number(data.total_matches || 0);
            const previewRuns = Array.isArray(data.preview_runs) ? data.preview_runs : [];
            const hasMore = Boolean(data.has_more);
            if (totalMatches <= 0) {
                status.textContent = `No runs matched keyword "${keyword}".`;
                this._setDeletePreview("");
                return;
            }

            status.textContent =
                `Matched ${totalMatches} run(s), ${data.result_files || 0} result files, ` +
                `${data.timeseries_files || 0} timeseries files, ${data.summary_rows || 0} summary rows.`;

            const lines = [
                "Preview of runs that will be deleted:",
                ...previewRuns.map((run, idx) => `${idx + 1}. ${run}`),
            ];
            if (hasMore) {
                lines.push(`...and ${Math.max(totalMatches - previewRuns.length, 0)} more run(s).`);
            }
            this._setDeletePreview(lines.join("\n"));
        } catch (err) {
            status.textContent = "Preview failed: " + err.message + this._networkHint(err);
            this._setDeletePreview("");
        } finally {
            btn.disabled = false;
        }
    },

    async _deleteMatchingResults() {
        const keywordEl = document.getElementById("inp-delete-results-keyword");
        const status = document.getElementById("delete-results-status");
        const btn = document.getElementById("btn-delete-results");
        const previewBtn = document.getElementById("btn-preview-delete-results");
        const keyword = String(keywordEl?.value || "").trim();

        if (!keyword) {
            status.textContent = "Enter a keyword first.";
            return;
        }

        const first = window.confirm(
            `Delete results whose run name contains \"${keyword}\"? This cannot be undone.`
        );
        if (!first) {
            status.textContent = "Delete cancelled.";
            return;
        }

        const typed = window.prompt("Type DELETE to confirm matching-result deletion:");
        if (typed !== "DELETE") {
            status.textContent = "Second confirmation failed. Nothing deleted.";
            return;
        }

        btn.disabled = true;
        if (previewBtn) previewBtn.disabled = true;
        status.textContent = `Deleting runs matching \"${keyword}\"...`;

        try {
            const resp = await fetch("/api/delete-results", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    keyword,
                    confirm_phrase: "DELETE_MATCHING_RESULTS",
                }),
            });
            const data = await resp.json();
            if (!resp.ok || data.error) throw new Error(data.error || "Failed to delete matching results");

            const matched = Array.isArray(data.matched_runs) ? data.matched_runs : [];
            const matchedSet = new Set(matched);

            if (matched.length) {
                App.summaryData = (App.summaryData || []).filter(row => !matchedSet.has(App.runKey(row)));
                App.worklogData = (App.worklogData || []).filter(row => !matchedSet.has(String(row?.run_name || "")));
                const cache = App.timeseriesCache || {};
                for (const runName of matchedSet) {
                    delete cache[runName];
                    delete cache[`${runName}_scatter`];
                }
                App.timeseriesCache = cache;

                const currentName = App.currentResult?.summary?.run_name || App.currentResult?.meta?.run_name || "";
                if (matchedSet.has(String(currentName))) {
                    App.currentResult = null;
                }
            }

            await this._refreshHistoricalData({ fast: true });
            Worklog.init(App.worklogData || []);
            this._setDeletePreview("");

            status.textContent =
                matched.length
                    ? `Deleted ${matched.length} run(s): ${data.deleted?.result_files || 0} result files, ${data.deleted?.timeseries_files || 0} timeseries files.`
                    : `No runs matched keyword \"${keyword}\".`;
        } catch (err) {
            status.textContent = "Delete failed: " + err.message + this._networkHint(err);
        } finally {
            btn.disabled = false;
            if (previewBtn) previewBtn.disabled = false;
        }
    },

    _parseIntCsv(text, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
        const vals = String(text || "")
            .split(",")
            .map(s => parseInt(s.trim(), 10))
            .filter(v => Number.isFinite(v) && v >= min && v <= max);
        return [...new Set(vals)];
    },

    _collectSweepSpec() {
        const selectedPolicies = [...document.querySelectorAll('input[name="sweep-policy"]:checked')]
            .map(el => el.value)
            .filter(v => SWEEP_POLICY_PRESETS[v]);
        if (!selectedPolicies.length) {
            throw new Error("Select at least one sweep policy.");
        }

        const backfills = this._parseIntCsv(
            document.getElementById("inp-sweep-backfills").value,
            { min: 0, max: 2 }
        );
        if (!backfills.length) {
            throw new Error("Backfill CSV must include at least one of: 0 or 1.");
        }

        const windows = this._parseIntCsv(
            document.getElementById("inp-sweep-wins").value,
            { min: 1, max: 2000 }
        );
        if (!windows.length) {
            throw new Error("Window CSV must include at least one integer >= 1.");
        }

        const maxRunsRaw = parseInt(document.getElementById("inp-sweep-max-runs").value, 10);
        const maxRuns = Number.isFinite(maxRunsRaw) && maxRunsRaw > 0
            ? maxRunsRaw
            : DEFAULT_FORM.sweep_max_runs;

        const combos = [];
        for (const alg of selectedPolicies) {
            const policy = SWEEP_POLICY_PRESETS[alg];
            for (const backfill of backfills) {
                for (const win of windows) {
                    combos.push({
                        algorithm: alg,
                        alg_sign: policy.alg_sign,
                        policy_label: policy.label,
                        backfill,
                        win,
                    });
                }
            }
        }

        const rawCount = combos.length;
        return {
            combos: combos.slice(0, maxRuns),
            rawCount,
            maxRuns,
        };
    },

    _buildSweepParams(baseParams, combo, index) {
        const params = Object.assign({}, baseParams);
        const win = combo.win;

        let winPara = String(baseParams.win_para || "5,0,0");
        if (win <= 0) {
            winPara = "0,0,0";
        } else {
            const parts = winPara.split(",").map(s => s.trim()).filter(Boolean);
            const check = parts[1] ?? "0";
            const maxStart = parts[2] ?? "0";
            winPara = `${win},${check},${maxStart}`;
        }

        const baseLabel = String(baseParams.run_label || "").trim();
        const prefix = baseLabel ? `${baseLabel}_` : "";
        const sweepLabel = `${prefix}sweep_${combo.policy_label}_bf${combo.backfill}_w${combo.win}_r${index}`;

        Object.assign(params, {
            output_mode: "new",
            run_label: sweepLabel,
            algorithm: combo.algorithm,
            alg_sign: combo.alg_sign,
            backfill: combo.backfill,
            win: combo.win,
            win_para: winPara,
        });

        return params;
    },

    async _startSweep() {
        const sweepStatus = document.getElementById("sweep-status");
        const btn = document.getElementById("btn-run-sweep");

        let baseParams;
        let spec;
        try {
            baseParams = this._collectParams();
            if (baseParams.job_trace === BATCH_ALL_SWF) {
                throw new Error("Sweep requires one selected job trace (not [Batch] all .swf).");
            }
            spec = this._collectSweepSpec();
        } catch (err) {
            sweepStatus.textContent = `Sweep setup error: ${err.message}`;
            return;
        }

        btn.disabled = true;
        sweepStatus.textContent = `Preparing ${spec.combos.length} sweep run(s)...`;

        try {
            const payload = await fetch("/api/files").then(r => r.json());
            const allFiles = payload.files || [];

            this.batchMode = true;
            this.batchAbort = false;
            App.setState("RUNNING");

            let completed = 0;
            const failed = [];
            const sweepRunKeys = [];

            for (let i = 0; i < spec.combos.length; i++) {
                if (this.batchAbort) break;
                const combo = spec.combos[i];
                const params = this._buildSweepParams(baseParams, combo, i + 1);
                if (!params.node_struc) {
                    params.node_struc = this._pickNodeForJob(params.job_trace, allFiles);
                }

                this._setProgressUI({
                    pct: Math.round((i / spec.combos.length) * 100),
                    stage: `Sweep ${i + 1}/${spec.combos.length} queued`,
                    elapsed: 0,
                    title: `${params.job_trace} | ${combo.policy_label} | bf${combo.backfill} | w${combo.win}`,
                    log: [
                        `Sweep run ${i + 1}/${spec.combos.length}`,
                        `policy=${combo.algorithm}`,
                        `backfill=${combo.backfill}`,
                        `win=${combo.win}`,
                    ],
                });

                let runId = null;
                try {
                    const resp = await fetch("/api/run", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(params),
                    });
                    const data = await resp.json();
                    if (!resp.ok || data.error) throw new Error(data.error || "Failed to launch run");
                    runId = data.run_id;
                    this.runId = runId;
                } catch (err) {
                    failed.push(`run ${i + 1}: ${err.message}`);
                    continue;
                }

                const startedAt = Date.now();
                const run = await this._pollSingleRun(runId, r => {
                    const overall = ((i + (r.progress || 0) / 100) / spec.combos.length) * 100;
                    this._setProgressUI({
                        pct: Math.round(overall),
                        stage: `Sweep ${i + 1}/${spec.combos.length} | ${r.stage || r.status}`,
                        elapsed: Math.floor((Date.now() - startedAt) / 1000),
                        title: `${combo.policy_label} | bf${combo.backfill} | w${combo.win}`,
                        log: r.log || [],
                    });
                });

                if (run.status === "complete") {
                    try {
                        const result = await fetch(`/api/results/${runId}`).then(r => r.json());
                        if (!result.error) {
                            App.setResultData(result);
                            const key = result?.summary?.run_name || result?.meta?.run_name;
                            if (key) sweepRunKeys.push(key);
                        }
                    } catch {
                        // Keep sweep moving if a post-fetch fails
                    }
                    completed += 1;
                } else if (!this.batchAbort) {
                    failed.push(`run ${i + 1}: ${run.error || run.status || "unknown error"}`);
                }
            }

            this.batchMode = false;
            this.runId = null;

            if (this.batchAbort) {
                sweepStatus.textContent = "Sweep cancelled.";
                App.setState("SETUP");
                return;
            }

            if (completed > 0) {
                App.lastSweepRunKeys = sweepRunKeys;
                sweepStatus.textContent =
                    `Sweep finished: ${completed} completed, ${failed.length} failed` +
                    (spec.rawCount > spec.combos.length ? ` (capped from ${spec.rawCount})` : "") +
                    `.`;
                App.setState("RESULTS");
                const compareTab = document.querySelector('.tab[data-tab="compare"]');
                if (compareTab) compareTab.click();
            } else {
                sweepStatus.textContent = `Sweep failed: ${failed.length} failed runs.`;
                App.setState("SETUP");
            }
        } catch (err) {
            this.batchMode = false;
            this.runId = null;
            sweepStatus.textContent = "Sweep launch failed: " + err.message + this._networkHint(err);
            App.setState("SETUP");
        } finally {
            btn.disabled = false;
        }
    },

    async _startRun() {
        const params = this._collectParams();
        if (params.job_trace === BATCH_ALL_SWF) {
            await this._startRunAll(params);
            return;
        }

        this._setProgressUI({
            pct: 0,
            stage: "Dispatching",
            elapsed: 0,
            title: `${params.job_trace} | alg: ${params.algorithm} | mode: ${params.output_mode}`,
            log: ["Preparing simulation request..."],
        });

        App.setState("RUNNING");

        try {
            const resp = await fetch("/api/run", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(params),
            });
            const data = await resp.json();
            if (data.error) throw new Error(data.error);

            this.runId = data.run_id;
            this._startPolling();
        } catch (err) {
            this._setProgressUI({
                pct: 0,
                stage: "Error",
                elapsed: 0,
                title: `Error: ${err.message}`,
                log: [`Run launch failed: ${err.message}${this._networkHint(err)}`],
            });
            setTimeout(() => App.setState("SETUP"), 1100);
        }
    },

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },

    async _pollSingleRun(runId, onTick) {
        while (true) {
            if (this.batchAbort) return { status: "cancelled", error: "Batch cancelled by user" };

            try {
                const all = await fetch("/api/status").then(r => r.json());
                const run = all[runId];
                if (run) {
                    if (onTick) onTick(run);
                    if (run.status === "complete" || run.status === "error" || run.status === "cancelled") {
                        return run;
                    }
                }
            } catch {
                // Keep waiting on transient network issues
            }
            await this._sleep(1500);
        }
    },

    async _startRunAll(baseParams) {
        const statusEl = document.getElementById("upload-status");

        try {
            const payload = await fetch("/api/files").then(r => r.json());
            const files = payload.files || [];
            const swfFiles = files.filter(f => f.toLowerCase().endsWith(".swf"));
            if (!swfFiles.length) {
                throw new Error("No .swf files found in input folder.");
            }

            this.batchMode = true;
            this.batchAbort = false;
            App.setState("RUNNING");

            let completed = 0;
            const failed = [];

            for (let i = 0; i < swfFiles.length; i++) {
                if (this.batchAbort) break;

                const file = swfFiles[i];
                const params = Object.assign({}, baseParams, {
                    job_trace: file,
                    node_struc: this._pickNodeForJob(file, files),
                });

                this._setProgressUI({
                    pct: Math.round((i / swfFiles.length) * 100),
                    stage: `Batch ${i + 1}/${swfFiles.length} queued`,
                    elapsed: 0,
                    title: `${file}`,
                    log: [`Starting batch run ${i + 1}/${swfFiles.length}: ${file}`],
                });

                let runId = null;
                try {
                    const resp = await fetch("/api/run", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(params),
                    });
                    const data = await resp.json();
                    if (!resp.ok || data.error) throw new Error(data.error || "Failed to launch run");

                    runId = data.run_id;
                    this.runId = runId;
                } catch (err) {
                    failed.push(`${file}: ${err.message}`);
                    continue;
                }

                const startedAt = Date.now();
                const run = await this._pollSingleRun(runId, r => {
                    const overall = ((i + (r.progress || 0) / 100) / swfFiles.length) * 100;
                    this._setProgressUI({
                        pct: Math.round(overall),
                        stage: `Batch ${i + 1}/${swfFiles.length} | ${r.stage || r.status}`,
                        elapsed: Math.floor((Date.now() - startedAt) / 1000),
                        title: `${file} | ${r.status}`,
                        log: r.log || [],
                    });
                });

                if (run.status === "complete") {
                    try {
                        const result = await fetch(`/api/results/${runId}`).then(r => r.json());
                        if (!result.error) App.setResultData(result);
                    } catch {
                        // Keep batch moving even if single result fetch fails
                    }
                    completed += 1;
                } else if (!this.batchAbort) {
                    failed.push(`${file}: ${run.error || run.status || "unknown error"}`);
                }
            }

            this.batchMode = false;
            this.runId = null;

            if (this.batchAbort) {
                statusEl.textContent = "Batch run cancelled.";
                App.setState("SETUP");
                return;
            }

            if (completed > 0) {
                statusEl.textContent = `Batch finished: ${completed} completed, ${failed.length} failed.`;
                App.setState("RESULTS");
            } else {
                statusEl.textContent = `Batch failed: ${failed.length} failed runs.`;
                App.setState("SETUP");
            }
        } catch (err) {
            this.batchMode = false;
            this.runId = null;
            statusEl.textContent = "Batch launch failed: " + err.message + this._networkHint(err);
            App.setState("SETUP");
        }
    },

    _startPolling() {
        clearInterval(this.pollTimer);
        this.pollTimer = setInterval(async () => {
            try {
                const all = await fetch("/api/status").then(r => r.json());
                const run = all[this.runId];
                if (!run) return;

                this._setProgressUI({
                    pct: run.progress || 0,
                    stage: run.stage || run.status,
                    elapsed: run.elapsed_sec || 0,
                    title: `${run.output_name || "output"} | ${run.status}`,
                    log: run.log || [],
                });

                if (run.status === "complete") {
                    clearInterval(this.pollTimer);
                    const result = await fetch(`/api/results/${this.runId}`).then(r => r.json());
                    App.setResultData(result);
                    App.setState("RESULTS");
                } else if (run.status === "error" || run.status === "cancelled") {
                    clearInterval(this.pollTimer);
                    const msg = run.status === "cancelled"
                        ? "Run cancelled"
                        : "Run failed: " + (run.error || "Unknown error");

                    this._setProgressUI({
                        pct: run.progress || 0,
                        stage: run.status,
                        elapsed: run.elapsed_sec || 0,
                        title: msg,
                        log: run.log || [msg],
                    });
                    setTimeout(() => App.setState("SETUP"), 1200);
                }
            } catch {
                // Network hiccup; keep polling
            }
        }, 1500);
    },

    async _cancelRun() {
        clearInterval(this.pollTimer);
        if (this.batchMode) this.batchAbort = true;
        if (!this.runId) {
            App.setState("SETUP");
            return;
        }

        try {
            await fetch("/api/cancel", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ run_id: this.runId }),
            });
        } catch {
            // Ignore cancel errors and return to setup
        }

        App.setState("SETUP");
    },
};
