#include "online_env.h"

#include <algorithm>
#include <cmath>
#include <deque>
#include <fstream>
#include <future>
#include <iomanip>
#include <limits>
#include <random>
#include <stdexcept>
#include <thread>
#include <unordered_set>

#include "../simulation/event.h"
#include "../../core/node.h"
#include "../../io/swf_reader.h"
#include "../../policies/policy_factory.h"

using json = nlohmann::json;

// ── Reward parsing ────────────────────────────────────────────────────────────

RewardType parse_reward_type(const std::string& s) {
    if (s == "neg_avg_wait_delta") return RewardType::NegAvgWaitDelta;
    if (s == "neg_wait_delta")     return RewardType::NegWaitDelta;
    if (s == "util")               return RewardType::Util;
    if (s == "constant")           return RewardType::Constant;
    return RewardType::NegAvgWaitDelta;
}

WorkloadMode parse_workload_mode(const std::string& s) {
    if (s == "trace")  return WorkloadMode::Trace;
    if (s == "stream") return WorkloadMode::Stream;
    throw std::runtime_error("online_env: unknown workload source '" + s +
                             "' (expected 'trace' or 'stream')");
}

// ── Config loading ────────────────────────────────────────────────────────────

OnlineEnvConfig OnlineEnvConfig::from_json(const json& j) {
    OnlineEnvConfig c;

    // "workload.mode" selects the WORKLOAD SOURCE (trace replay vs event stream).
    // This is deliberately distinct from the top-level "mode" below, which is the
    // SIMULATION SEMANTICS (Normal/Perfect). Two different knobs; keep them apart.
    if (j.contains("workload") && j["workload"].contains("mode"))
        c.workload_mode = parse_workload_mode(j["workload"]["mode"].get<std::string>());

    if (j.contains("cluster") && j["cluster"].contains("total_procs"))
        c.total_procs = j["cluster"]["total_procs"].get<int>();
    else if (j.contains("total_procs"))
        c.total_procs = j["total_procs"].get<int>();

    if (c.workload_mode == WorkloadMode::Trace) {
        if (!j.contains("swf_path"))
            throw std::runtime_error(
                "online_env: workload source 'trace' requires 'swf_path' "
                "(set workload.mode='stream' to feed jobs over the wire instead)");
        c.swf_path = j.at("swf_path").get<std::string>();
    } else {  // Stream: no trace to read or infer the cluster from.
        c.swf_path = j.value("swf_path", std::string());  // optional, ignored
        if (c.total_procs <= 0)
            throw std::runtime_error(
                "online_env: workload source 'stream' requires an explicit "
                "'cluster.total_procs' (there is no trace to infer cluster size from)");
    }

    if (j.contains("mode"))
        c.mode = parse_sim_mode(j["mode"].get<std::string>());

    c.max_submits     = j.value("max_submits", INT_MAX);
    c.start_job_index = j.value("start_job_index", 0);

    if (j.contains("pool")) {
        for (const auto& p : j["pool"]) {
            PoolEntry e;
            e.type = p.at("type").get<std::string>();
            std::transform(e.type.begin(), e.type.end(), e.type.begin(),
                           [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
            e.window_size = p.value("window_size", INT_MAX);
            if (e.window_size <= 0) e.window_size = 1;
            bool bf = p.value("backfilling", false);
            e.backfill = LegacyDispatchConfig{ bf, p.value("legacy_backfill_mode", bf ? 1 : 0) };
            c.pool.push_back(std::move(e));
        }
    }
    if (c.pool.empty())
        throw std::runtime_error("online_env: 'pool' must contain at least one policy");

    if (j.contains("reward"))
        c.reward = parse_reward_type(j["reward"].value("type", std::string("neg_avg_wait_delta")));

    if (j.contains("obs")) {
        c.queue_window             = j["obs"].value("queue_window", 32);
        c.include_advisory         = j["obs"].value("include_advisory", false);
        c.advisory_horizon_seconds = j["obs"].value("advisory_horizon_seconds", static_cast<SimTime>(86400));
        c.advisory_interval        = std::max(1, j["obs"].value("advisory_interval", 1));
    }
    if (j.contains("episode"))
        c.randomize_start = j["episode"].value("randomize_start", false);

    c.advisory_csv = j.value("advisory_csv", std::string());

    return c;
}

OnlineEnvConfig OnlineEnvConfig::from_file(const std::string& path) {
    std::ifstream f(path);
    if (!f.is_open())
        throw std::runtime_error("online_env: cannot open config: " + path);
    return OnlineEnvConfig::from_json(json::parse(f));
}

// ── Construction ──────────────────────────────────────────────────────────────

OnlineEnv::OnlineEnv(OnlineEnvConfig config) : config_(std::move(config)) {
    if (config_.workload_mode == WorkloadMode::Trace) {
        SwfReader reader(config_.swf_path);
        jobs_all_ = reader.read();

        if (config_.total_procs <= 0) config_.total_procs = reader.max_procs();
        if (config_.total_procs <= 0) {
            int m = 1;
            for (const auto& j : jobs_all_) m = std::max(m, j.requested.procs);
            config_.total_procs = m;
        }
    }
    // Stream mode: jobs_all_ stays empty; jobs arrive via submit_jobs(). The
    // cluster size was validated (> 0) in from_json() since it cannot be inferred.
    if (config_.pool.empty())
        throw std::runtime_error("online_env: empty policy pool");
}

// ── Dispatch (shared by the live callback and advisory rollouts) ──────────────

void OnlineEnv::dispatch_with(Simulator& s, SimTime t,
                              SchedulerPolicy* policy,
                              const LegacyDispatchConfig& bf) const {
    if (!policy) return;
    int primary = 0, backfill = 0;
    std::deque<int> remaining = dispatch_ordered_jobs(s, policy, t, primary, backfill);

    if (bf.backfill && bf.backfill_mode > 0 && !remaining.empty()) {
        std::unordered_set<int> filled;
        for (int id : legacy_backfill_candidates(s, remaining, t, s.mode(), bf.backfill_mode)) {
            if (s.try_start_job(id, t, true))
                filled.insert(id);
        }
        if (!filled.empty()) {
            std::deque<int> kept;
            for (int id : remaining)
                if (!filled.count(id)) kept.push_back(id);
            remaining = std::move(kept);
        }
    }
    s.sort_job_queue(remaining);
}

// ── Simulator (re)construction per episode ────────────────────────────────────

void OnlineEnv::build_sim() {
    episode_jobs_.clear();
    submit_cursor_ = 0;
    at_decision_   = false;

    if (config_.workload_mode == WorkloadMode::Trace) {
        std::vector<SimJob> jobs = jobs_all_;
        std::stable_sort(jobs.begin(), jobs.end(),
                         [](const SimJob& a, const SimJob& b) { return a.submit_time < b.submit_time; });

        const int n = static_cast<int>(jobs.size());
        int start = std::max(0, std::min(config_.start_job_index, n));

        if (config_.randomize_start && n > 0) {
            int span = std::max(0, n - std::min(config_.max_submits, n));
            if (span > 0) {
                std::mt19937 rng(static_cast<unsigned>(episode_count_) + 1u);
                start = static_cast<int>(rng() % (static_cast<unsigned>(span) + 1u));
            }
        }

        const int remain = n - start;
        const int limit  = start + std::min(config_.max_submits, remain);

        episode_jobs_.assign(jobs.begin() + start, jobs.begin() + limit);
        if (!episode_jobs_.empty()) {
            SimTime origin = episode_jobs_.front().submit_time;   // shift so "now" origin = 0
            for (auto& j : episode_jobs_) j.submit_time -= origin;
        }
    } else {
        // Stream mode: start with an EMPTY job set; submit_jobs() feeds the
        // sorted tail incrementally. No origin shift — stream submit_times are
        // absolute and must stay on the same clock the client asserts against
        // via stream_advance.
        //
        // TIME ORIGIN CONVENTION: the trace path above (and the offline Driver)
        // shift the timeline to origin 0; stream mode runs on ABSOLUTE time.
        // Per-job WAIT (start - submit) is therefore the quantity comparable
        // across paths (start times differ by the constant origin). This is a
        // deliberate design choice, not a discrepancy — the frontier/horizon
        // logic needs real wall-clock times. See tests/test_online_stream.cpp
        // and docs/live-adapter.md.
        //
        // Reset the frontier state for the new episode.
        asserted_until_.reset();
        stream_ended_ = false;
        known_ids_.clear();
    }

    std::vector<NodeInfo> nodes{ NodeInfo(0, "cluster", Resources{ config_.total_procs, 0, 0 }) };
    // Construct empty; Submit events are injected just-in-time in submit-time
    // order by inject_due_submits() as the sim advances — exactly like the
    // offline Driver (driver.cpp:173/:185). Two properties this guarantees:
    //  (1) fidelity: push_event assigns a global incrementing serial and the heap
    //      breaks same-time/same-type ties by serial, so same-time Submits must be
    //      injected in the Driver's sorted order or FCFS queue order diverges;
    //  (2) no future visibility: at any decision point the heap holds only submits
    //      up to that time, so a get_copy() projection fork cannot see future
    //      arrivals. (Preloading all submits at construction would break (2).)
    sim_ = std::make_unique<Simulator>(std::vector<SimJob>{}, std::move(nodes), config_.mode);
    // Submits are NOT preloaded — inject_due_submits() feeds them JIT during
    // advance_to_decision(), keeping the heap (and thus every projection fork)
    // free of future arrivals. submit_cursor_ starts at 0.

    pool_policies_.clear();
    for (const auto& e : config_.pool) {
        auto p = make_heuristic_policy(e.type, e.window_size);
        if (!p)
            throw std::runtime_error("online_env: unknown policy type '" + e.type + "'");
        pool_policies_.push_back(std::move(p));
    }

    active_policy_ = nullptr;
    sim_->set_scheduling_callback([this](Simulator& s, SimTime t) {
        dispatch_with(s, t, active_policy_, active_backfill_);
    });
}

int OnlineEnv::policy_index(const std::string& type) const {
    for (std::size_t i = 0; i < config_.pool.size(); ++i)
        if (config_.pool[i].type == type) return static_cast<int>(i);
    return -1;
}

int OnlineEnv::pending_arrivals() const {
    if (!sim_) return 0;
    const SimTime now = sim_->current_time();
    int count = 0;
    for (const auto& j : episode_jobs_)
        if (j.submit_time > now) ++count;
    return count;
}

// Just-in-time Submit injection: inject (register + push) only the IMMINENT
// submit batch — those whose submit_time is <= min(next heap event, next pending
// submit). Bounding by the *minimum* is what keeps the heap clean: injecting up
// to a far-future End event would pull in every submit before that End, leaking
// future arrivals into projection forks. Same-time ties (a submit and a heap
// event at the same instant) are injected together and ordered by the heap's own
// event priority, so this matches the offline Driver's schedule exactly.
void OnlineEnv::inject_due_submits(std::optional<Event> next_ev, SimTime horizon) {
    if (submit_cursor_ >= episode_jobs_.size()) return;
    const SimTime next_submit_time = episode_jobs_[submit_cursor_].submit_time;
    SimTime bound = next_ev ? std::min(next_ev->time, next_submit_time)
                            : next_submit_time;
    // Never inject past the client-asserted horizon: a delivered submit beyond it
    // could still be preceded by an as-yet-undelivered earlier arrival. In trace
    // mode horizon is +inf, so this cap is a no-op and injection is bit-identical.
    if (bound > horizon) bound = horizon;
    while (submit_cursor_ < episode_jobs_.size() &&
           episode_jobs_[submit_cursor_].submit_time <= bound) {
        const SimJob& j = episode_jobs_[submit_cursor_++];
        sim_->register_job(j);
        sim_->create_submit_event(j.submit_time, j.id);
    }
}

// The largest time the env may simulate to. Trace mode and a stream that has
// ended are unbounded (+inf); an open stream is bounded by the client's latest
// asserted-complete horizon (or -inf before any assertion — cannot advance yet).
SimTime OnlineEnv::stream_horizon() const {
    if (config_.workload_mode == WorkloadMode::Trace || stream_ended_)
        return std::numeric_limits<SimTime>::infinity();
    return asserted_until_.value_or(-std::numeric_limits<SimTime>::infinity());
}

const char* OnlineEnv::status_string(AdvanceResult r) {
    switch (r) {
        case AdvanceResult::Decision: return "decision";
        case AdvanceResult::Waiting:  return "waiting_for_events";
        case AdvanceResult::Terminal: return "terminal";
    }
    return "terminal";
}

// ── Event advancement ─────────────────────────────────────────────────────────
// Advance until the next decision point (a SchedulingCycle with a non-empty
// queue). SchedulingCycles with an empty queue are auto-consumed (nothing to
// decide). Returns false when the simulation is fully drained.

AdvanceResult OnlineEnv::advance_to_decision() {
    const SimTime horizon = stream_horizon();
    while (true) {
        inject_due_submits(sim_->peek(), horizon);  // JIT submits, capped at horizon
        auto next_ev = sim_->peek();
        if (!next_ev) {
            // Heap drained. In an open stream more events may still arrive, so
            // this is the frontier (wait), not the end. Trace mode / ended stream
            // has nothing more coming -> terminal.
            if (config_.workload_mode == WorkloadMode::Stream && !stream_ended_)
                return AdvanceResult::Waiting;
            return AdvanceResult::Terminal;
        }
        // The next event lies beyond the proven-complete horizon. Stop here and
        // wait rather than consuming it — this is what bounds EVENT processing
        // (e.g. an End at 1500) by the asserted horizon T, not just submit
        // injection: a submit at 1200 could still legitimately arrive. Never
        // triggers in trace mode (horizon is +inf).
        if (next_ev->time > horizon)
            return AdvanceResult::Waiting;
        if (next_ev->type == EventType::SchedulingCycle && !sim_->get_job_queue().empty())
            return AdvanceResult::Decision;
        sim_->step();
    }
}

// Set terminal/decision flags from an advance result and build the transition
// return shared by reset()/stream_advance()/stream_end(). step() builds its own
// (it also carries reward/info) but sets the same flags + status.
json OnlineEnv::observe_after_advance(AdvanceResult r) {
    at_decision_ = (r == AdvanceResult::Decision);
    done_        = (r == AdvanceResult::Terminal);

    json out;
    out["obs"]    = build_obs();
    out["status"] = status_string(r);
    out["done"]   = done_;
    out["info"]   = { { "episode", episode_count_ }, { "action_count", action_count() } };
    if (r == AdvanceResult::Waiting) {
        out["info"]["frontier"] = {
            { "current_time",      static_cast<double>(sim_->current_time()) },
            { "asserted_until",    asserted_until_ ? json(static_cast<double>(*asserted_until_)) : json() },
            { "pending_delivered", static_cast<int>(episode_jobs_.size() - submit_cursor_) },
            { "stream_ended",      stream_ended_ },
        };
    }
    if (done_) out["info"]["summary"] = episode_summary();
    return out;
}

// ── reset ─────────────────────────────────────────────────────────────────────

json OnlineEnv::reset() {
    ++episode_count_;
    build_sim();
    step_index_ = 0;
    started_ids_.clear();
    completed_note_cursor_  = 0;
    completed_agg_cursor_   = 0;
    completed_agg_wait_sum_ = 0.0;
    completed_agg_count_    = 0;

    if (!config_.advisory_csv.empty() && config_.include_advisory && !advisory_file_.is_open()) {
        advisory_file_.open(config_.advisory_csv, std::ios::trunc);
        advisory_file_ << "cycle,sim_time,committed_policy,policy,"
                          "proj_avg_wait,proj_jobs_completed,queue_measured\n";
    }

    // Trace mode: advances straight to the first decision (or terminal). Stream
    // mode: starts empty, so this returns waiting_for_events until the client
    // feeds jobs and calls stream_advance.
    return observe_after_advance(advance_to_decision());
}

// ── step ──────────────────────────────────────────────────────────────────────

json OnlineEnv::step(int action) {
    if (done_)
        throw std::runtime_error("online_env: step() after episode end; call reset()");
    if (!at_decision_)
        throw std::runtime_error("online_env: step() with no decision pending "
            "(status is waiting_for_events); feed jobs then call stream_advance/stream_end");
    if (action < 0 || action >= static_cast<int>(pool_policies_.size()))
        throw std::runtime_error("online_env: action out of range: " + std::to_string(action));

    const SimTime prev_time = sim_->current_time();

    // Per-cycle projection log: uses the projections cached for THIS decision
    // (computed in the preceding build_obs) plus the committed policy = the
    // action being applied now. Written before dispatch.
    if (advisory_file_.is_open())
        write_advisory_rows(step_index_, sim_->current_time(), config_.pool[action].type);

    // Apply the chosen policy at the pending decision point.
    active_policy_   = pool_policies_[action].get();
    active_backfill_ = config_.pool[action].backfill;
    sim_->step();  // fires the callback -> dispatch_with(active_policy_)

    const AdvanceResult adv = advance_to_decision();
    const SimTime cur    = sim_->current_time();
    ++step_index_;

    // Credit newly started jobs since the last observation.
    double wait_sum = 0.0;
    int    newly    = 0;
    auto note = [&](int id) {
        if (started_ids_.count(id)) return;
        SimTime st = sim_->job_start_time(id);
        if (st < 0) return;
        started_ids_.insert(id);
        wait_sum += static_cast<double>(st - sim_->get_job(id).submit_time);
        ++newly;
    };
    for (int id : sim_->running_jobs()) note(id);   // bounded by concurrent jobs
    // Only the newly-completed tail can hold a job that started AND completed
    // within this interval without ever being observed in running_jobs_; every
    // older completion was already noted when it first appeared. Equivalent to
    // scanning all completions, without the per-cycle O(N) rescan.
    const std::vector<int>& done_jobs = sim_->completed_jobs();
    for (std::size_t i = completed_note_cursor_; i < done_jobs.size(); ++i)
        note(done_jobs[i]);
    completed_note_cursor_ = done_jobs.size();

    const int total = sim_->total_procs();
    const double util = total > 0
        ? static_cast<double>(total - sim_->available_procs()) / total
        : 0.0;

    double reward = 0.0;
    switch (config_.reward) {
        case RewardType::NegAvgWaitDelta: reward = newly > 0 ? -(wait_sum / newly) / 3600.0 : 0.0; break;
        case RewardType::NegWaitDelta:    reward = -wait_sum / 3600.0; break;
        case RewardType::Util:            reward = util; break;
        case RewardType::Constant:        reward = 0.0; break;
    }

    done_        = (adv == AdvanceResult::Terminal);
    at_decision_ = (adv == AdvanceResult::Decision);

    json out;
    out["obs"]       = build_obs();
    out["reward"]    = reward;
    out["done"]      = done_;
    out["status"]    = status_string(adv);
    out["truncated"] = false;
    out["info"] = {
        { "jobs_started",     newly },
        { "wait_delta",       wait_sum },
        { "interval_seconds", static_cast<double>(cur - prev_time) },
        { "util",             util },
        { "completed",        static_cast<int>(sim_->completed_jobs().size()) },
    };
    if (adv == AdvanceResult::Waiting) {
        out["info"]["frontier"] = {
            { "current_time",      static_cast<double>(sim_->current_time()) },
            { "asserted_until",    asserted_until_ ? json(static_cast<double>(*asserted_until_)) : json() },
            { "pending_delivered", static_cast<int>(episode_jobs_.size() - submit_cursor_) },
            { "stream_ended",      stream_ended_ },
        };
    }
    if (done_) {
        out["info"]["summary"] = episode_summary();
        if (advisory_file_.is_open()) advisory_file_.flush();
    }
    return out;
}

// ── Stream ingestion ──────────────────────────────────────────────────────────
// submit_jobs registers delivered jobs into the sorted, un-injected tail; it
// never advances the clock and never throws on a bad job (bad jobs come back as
// structured rejections so a live adapter can log-and-skip). stream_advance /
// stream_end move the asserted-complete horizon and then advance the sim.

json OnlineEnv::submit_jobs(const json& msg) {
    if (config_.workload_mode != WorkloadMode::Stream)
        throw std::runtime_error("online_env: submit_job requires workload.mode='stream'");

    std::vector<json> items;
    if (msg.contains("jobs") && msg["jobs"].is_array()) {
        for (const auto& jj : msg["jobs"]) items.push_back(jj);
    } else if (msg.contains("job")) {
        items.push_back(msg["job"]);
    }

    json accepted = json::array();
    json rejected = json::array();
    const std::size_t tail_start = submit_cursor_;
    const std::size_t before     = episode_jobs_.size();

    auto reject = [&](const json& src, const char* reason, json extra = json::object()) {
        json r = extra;
        r["job_id"] = (src.is_object() && src.contains("id")) ? src["id"] : json();
        r["reason"] = reason;
        rejected.push_back(std::move(r));
    };

    for (const auto& jj : items) {
        if (!jj.is_object() || !jj.contains("id") || !jj.contains("submit_time")
            || !jj.contains("requested_walltime") || !jj.contains("runtime")
            || !jj.contains("requested_procs")) {
            reject(jj, "malformed");
            continue;
        }

        long long id = 0, procs = 0;
        double submit_time = 0.0, req_wall = 0.0, runtime = 0.0;
        try {
            id          = jj["id"].get<long long>();
            submit_time = jj["submit_time"].get<double>();
            req_wall    = jj["requested_walltime"].get<double>();
            runtime     = jj["runtime"].get<double>();
            procs       = jj["requested_procs"].get<long long>();
        } catch (const std::exception&) {
            reject(jj, "malformed");
            continue;
        }

        if (stream_ended_) { reject(jj, "stream_ended"); continue; }
        if (known_ids_.count(static_cast<int>(id))) { reject(jj, "duplicate_id"); continue; }

        // Accepting a job at or behind the asserted-complete frontier would
        // rewrite already-settled simulated history — reject it, naming the
        // frontier so the adapter can see it advanced its window too aggressively.
        const SimTime frontier = asserted_until_.value_or(-std::numeric_limits<SimTime>::infinity());
        if (submit_time <= frontier) {
            reject(jj, "behind_frontier",
                   { { "frontier_time", static_cast<double>(frontier) },
                     { "submit_time", submit_time } });
            continue;
        }

        std::string why;
        auto rec = make_swf_job_record(
            id, submit_time, req_wall, runtime, procs,
            jj.value("allocated_procs", 0LL), jj.value("requested_memory", 0LL),
            jj.value("user_id", -1LL), jj.value("group_id", -1LL),
            jj.value("queue_id", -1LL), &why);
        if (!rec) { reject(jj, why.c_str()); continue; }

        episode_jobs_.push_back(*rec);
        known_ids_.insert(static_cast<int>(id));
        accepted.push_back(static_cast<int>(id));
    }

    // Keep the un-injected tail sorted by submit_time; stable so same-time ties
    // preserve delivery order — the same tie rule the trace path gets from its
    // stable_sort, which the stream==trace equivalence test depends on. Only the
    // tail beyond the cursor is reordered; injected jobs are settled.
    if (episode_jobs_.size() != before) {
        std::stable_sort(episode_jobs_.begin() + static_cast<std::ptrdiff_t>(tail_start),
                         episode_jobs_.end(),
                         [](const SimJob& a, const SimJob& b) { return a.submit_time < b.submit_time; });
    }

    return { { "accepted", accepted }, { "rejected", rejected } };
}

json OnlineEnv::stream_advance(SimTime until) {
    if (config_.workload_mode != WorkloadMode::Stream)
        throw std::runtime_error("online_env: stream_advance requires workload.mode='stream'");
    if (stream_ended_)
        throw std::runtime_error("online_env: stream_advance after stream_end");
    if (asserted_until_ && until < *asserted_until_)
        throw std::runtime_error("online_env: stream_advance 'until' must be monotonic (got "
            + std::to_string(until) + " < asserted " + std::to_string(*asserted_until_) + ")");
    asserted_until_ = until;
    return observe_after_advance(advance_to_decision());
}

json OnlineEnv::stream_end() {
    if (config_.workload_mode != WorkloadMode::Stream)
        throw std::runtime_error("online_env: stream_end requires workload.mode='stream'");
    stream_ended_ = true;   // horizon becomes +inf; run out remaining decisions
    return observe_after_advance(advance_to_decision());
}

// ── Observation ───────────────────────────────────────────────────────────────

json OnlineEnv::build_pool_json() const {
    json p = json::array();
    for (const auto& e : config_.pool) p.push_back(e.type);
    return p;
}

json OnlineEnv::build_obs() {
    json o;
    o["step"] = step_index_;
    o["time"] = static_cast<double>(sim_->current_time());

    const int total = sim_->total_procs();
    const int free  = sim_->available_procs();
    o["system"] = {
        { "total_procs",   total },
        { "free_procs",    free },
        { "util",          total > 0 ? static_cast<double>(total - free) / total : 0.0 },
        { "running_count", static_cast<int>(sim_->running_jobs().size()) },
        { "queue_len",     static_cast<int>(sim_->get_job_queue().size()) },
    };

    // Fold only newly-completed jobs into the running wait sum (completed_jobs_ is
    // append-only). Bit-identical to summing all completions from scratch each
    // cycle, since the fold order matches the vector's index order.
    const std::vector<int>& completed = sim_->completed_jobs();
    for (std::size_t i = completed_agg_cursor_; i < completed.size(); ++i) {
        SimTime st = sim_->job_start_time(completed[i]);
        if (st >= 0) {
            completed_agg_wait_sum_ +=
                static_cast<double>(st - sim_->get_job(completed[i]).submit_time);
            ++completed_agg_count_;
        }
    }
    completed_agg_cursor_ = completed.size();
    o["metrics"] = {
        { "avg_wait_so_far", completed_agg_count_ > 0
                                 ? completed_agg_wait_sum_ / completed_agg_count_ : 0.0 },
        { "completed",       static_cast<int>(completed_agg_count_) },
    };

    const SimTime now = sim_->current_time();
    json q = json::array();
    int k = 0;
    for (int id : sim_->get_job_queue()) {
        if (k++ >= config_.queue_window) break;
        const SimJob& j = sim_->get_job(id);
        q.push_back({
            { "id",       id },
            { "procs",    j.requested.procs },
            { "walltime", static_cast<double>(sim_->job_walltime_for(id)) },
            { "waited",   static_cast<double>(now - j.submit_time) },
        });
    }
    o["queue"] = q;

    json r = json::array();
    for (int id : sim_->running_jobs()) {
        const SimJob& j = sim_->get_job(id);
        SimTime end = sim_->get_job_end_time(id);
        r.push_back({
            { "id",        id },
            { "procs",     j.requested.procs },
            { "walltime",  static_cast<double>(sim_->job_walltime_for(id)) },
            { "remaining", static_cast<double>(std::max<SimTime>(0, end - now)) },
        });
    }
    o["running"] = r;

    o["pool"] = build_pool_json();
    const bool project_now = config_.include_advisory &&
        (config_.advisory_interval <= 1 || step_index_ % config_.advisory_interval == 0);
    if (project_now) {
        compute_projections();
        json arr = json::array();
        for (const auto& p : last_projections_) {
            arr.push_back({
                { "policy",            p.policy },
                { "proj_avg_wait",     p.avg_wait },
                { "proj_jobs_started", p.jobs_started },
                { "queue_measured",    p.queue_measured },
            });
        }
        o["advisory"] = arr;
    } else {
        last_projections_.clear();  // no projection this cycle (interval skip)
    }
    return o;
}

// ── Advisory projections ──────────────────────────────────────────────────────
// For each pool policy, snapshot the live sim, roll it forward a bounded horizon
// under that policy, and measure the currently queued jobs. Rollout copies see
// no future arrivals (online-consistent). `avg_wait` is over jobs that STARTED
// within the horizon (wait is a start-time quantity); `jobs_completed` counts
// queued jobs whose End fired within the horizon.

Projection OnlineEnv::project_policy(const PoolEntry& entry, SimTime deadline) const {
    auto policy = make_heuristic_policy(entry.type, entry.window_size);
    SchedulerPolicy* pol = policy.get();
    LegacyDispatchConfig bf = entry.backfill;

    // Projection copy: starts append-only history empty (O(running), not O(N)).
    // A bounded rollout never reads pre-fork history, so this is behaviour-
    // identical to get_copy(false) here — see tests/test_online_projection_copy.cpp.
    Simulator copy = sim_->get_projection_copy();
    copy.set_scheduling_callback([this, pol, bf](Simulator& s, SimTime t) {
        dispatch_with(s, t, pol, bf);
    });

    std::vector<int> queued(copy.get_job_queue().begin(), copy.get_job_queue().end());

    auto nx = copy.peek();
    if (!nx || nx->type != EventType::SchedulingCycle)
        copy.inject_scheduling_cycle();

    // Roll the fork forward under this policy up to the bounded horizon. (An early
    // stop once all queued jobs have started was tried and reverted: it can't help
    // the case that matters — under heavy congestion the queue doesn't drain within
    // the horizon, so there's no tail to skip, and the per-start bookkeeping only
    // added overhead. Measured neutral/slightly slower; see git history / notes.)
    while (copy.has_events()) {
        auto e = copy.peek();
        if (!e || e->time > deadline) break;
        copy.step();
    }

    std::unordered_set<int> completed(copy.completed_jobs().begin(), copy.completed_jobs().end());

    Projection p;
    p.policy         = entry.type;
    p.queue_measured = static_cast<int>(queued.size());
    double wsum = 0.0;
    for (int id : queued) {
        SimTime st = copy.job_start_time(id);
        if (st >= 0 && st <= deadline) {
            wsum += static_cast<double>(st - copy.get_job(id).submit_time);
            ++p.jobs_started;
        }
        if (completed.count(id)) ++p.jobs_completed;
    }
    p.avg_wait = p.jobs_started > 0 ? wsum / p.jobs_started : 0.0;
    return p;
}

void OnlineEnv::compute_projections() {
    last_projections_.clear();
    SimTime t0 = sim_->current_time();
    if (auto nx = sim_->peek(); nx && nx->type == EventType::SchedulingCycle)
        t0 = nx->time;
    const SimTime deadline = t0 + config_.advisory_horizon_seconds;

    const std::size_t n = config_.pool.size();
    last_projections_.assign(n, Projection{});

    // Each pool policy's projection is independent — it rolls its OWN
    // get_projection_copy() forward under one policy, and the job table is
    // shared-const, so concurrent reads are safe. These rollouts dominate the
    // online-advisory cost, so fan them out across cores. Results are written by
    // index, preserving pool order (advisory.csv output is unchanged).
    if (n <= 1) {
        for (std::size_t i = 0; i < n; ++i)
            last_projections_[i] = project_policy(config_.pool[i], deadline);
        return;
    }
    std::vector<std::future<Projection>> futs;
    futs.reserve(n);
    for (std::size_t i = 0; i < n; ++i) {
        const PoolEntry* e = &config_.pool[i];   // stable address into config_.pool
        futs.push_back(std::async(std::launch::async,
            [this, e, deadline] { return project_policy(*e, deadline); }));
    }
    for (std::size_t i = 0; i < n; ++i)
        last_projections_[i] = futs[i].get();
}

void OnlineEnv::write_advisory_rows(int cycle, SimTime t, const std::string& committed) {
    if (!advisory_file_.is_open()) return;
    for (const auto& p : last_projections_) {
        advisory_file_ << cycle << ",";
        advisory_file_ << std::defaultfloat << std::setprecision(17) << t << ",";
        advisory_file_ << committed << "," << p.policy << ",";
        advisory_file_ << std::fixed << std::setprecision(4) << p.avg_wait << ",";
        advisory_file_ << p.jobs_completed << "," << p.queue_measured << "\n";
    }
}

// ── Episode summary ───────────────────────────────────────────────────────────

json OnlineEnv::episode_summary() const {
    std::vector<double> waits;
    SimTime earliest = std::numeric_limits<SimTime>::max();
    for (int id : sim_->completed_jobs()) {
        const SimJob& j = sim_->get_job(id);
        SimTime st = sim_->job_start_time(id);
        if (st >= 0) waits.push_back(static_cast<double>(st - j.submit_time));
        earliest = std::min(earliest, j.submit_time);
    }

    double avg = 0.0;
    for (double w : waits) avg += w;
    avg = waits.empty() ? 0.0 : avg / waits.size();

    auto pct = [](std::vector<double> v, double q) -> double {
        if (v.empty()) return 0.0;
        std::sort(v.begin(), v.end());
        std::size_t idx = static_cast<std::size_t>(std::ceil(q * v.size()));
        if (idx > 0) --idx;
        if (idx >= v.size()) idx = v.size() - 1;
        return v[idx];
    };
    double p90 = pct(waits, 0.90);
    double p99 = pct(waits, 0.99);

    SimTime makespan = waits.empty() ? 0 : sim_->current_time() -
                       (earliest == std::numeric_limits<SimTime>::max() ? 0 : earliest);

    return {
        { "avg_wait",  avg },
        { "p90_wait",  p90 },
        { "p99_wait",  p99 },
        { "makespan",  static_cast<double>(makespan) },
        { "completed", static_cast<int>(waits.size()) },
    };
}
