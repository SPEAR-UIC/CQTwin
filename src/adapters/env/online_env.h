#pragma once

// ─────────────────────────────────────────────────────────────────────────────
// OnlineEnv — a steppable, gym-style scheduling environment.
//
// Offline = trace replay under one fixed policy (JsonExperiment / Driver).
// Online  = the SAME trace/cluster, but at each scheduling decision an external
//           agent chooses which policy (from a configured pool) to apply.
//
// This class exposes reset() / step(action) so an external agent (see
// tools/cqsim_online.py) can drive it exactly like a Gym/Gymnasium environment.
// See docs/CQTwin_ONLINE_SIMULATION.md §8 for the full protocol.
// ─────────────────────────────────────────────────────────────────────────────

#include <climits>
#include <cstddef>
#include <fstream>
#include <memory>
#include <optional>
#include <string>
#include <unordered_set>
#include <vector>

#include <nlohmann/json.hpp>

#include "../simulation/legacy_dispatch.h"
#include "../simulation/simulator.h"
#include "../../core/job.h"
#include "../../core/policy.h"

// Reward objective (the user's optimization target).
enum class RewardType {
    NegAvgWaitDelta,  // −(avg wait, in hours, of jobs that started since last step)
    NegWaitDelta,     // −(total wait, in hours, accrued by jobs that started since last step)
    Util,             // instantaneous utilization at the new decision point
    Constant          // 0.0 (use info[] to compute a custom reward externally)
};

RewardType parse_reward_type(const std::string& s);

// Workload source: the process either reads the whole trace up front (Trace) or
// receives jobs one event at a time over the wire (Stream). These are the
// "workload source" — orthogonal to SimMode (the "simulation semantics",
// Normal/Perfect). Do not conflate the two `mode` knobs.
enum class WorkloadMode { Trace, Stream };

WorkloadMode parse_workload_mode(const std::string& s);

// Result of advancing the event loop toward the next agent decision.
//   Decision — stopped at a scheduling cycle with a non-empty queue; step() next.
//   Waiting  — stream mode only: reached the client-asserted horizon frontier
//              with no more provable-complete events; feed more then advance.
//   Terminal — the simulation is fully drained (trace exhausted / stream ended).
enum class AdvanceResult { Decision, Waiting, Terminal };

// One entry in the discrete action pool.
struct PoolEntry {
    std::string          type;                 // "fcfs", "sjf", "wfp3", ...
    int                  window_size = INT_MAX;
    LegacyDispatchConfig backfill{};           // { backfill, backfill_mode }
};

// One policy's bounded-horizon projection from the current decision point.
struct Projection {
    std::string policy;
    double      avg_wait       = 0.0;  // over queued jobs that started within horizon
    int         jobs_started   = 0;    // queued jobs that began running within horizon
    int         jobs_completed = 0;    // queued jobs that finished within horizon
    int         queue_measured = 0;    // queue size at the decision point
};

struct OnlineEnvConfig {
    WorkloadMode workload_mode  = WorkloadMode::Trace;  // trace replay vs event stream
    std::string swf_path;                      // required for Trace; unused for Stream
    int         total_procs     = 0;           // Trace: 0 => inferred; Stream: required
    SimMode     mode            = SimMode::Normal;
    int         max_submits     = INT_MAX;
    int         start_job_index = 0;

    std::vector<PoolEntry> pool;               // the discrete action set

    RewardType reward = RewardType::NegAvgWaitDelta;

    int     queue_window             = 32;     // max queued jobs exposed in obs
    bool    include_advisory         = false;  // include per-pool projections in obs
    SimTime advisory_horizon_seconds = 86400;
    int     advisory_interval        = 1;      // compute projections every Nth decision

    bool    randomize_start = false;           // vary trace slice per reset()

    std::string advisory_csv;                  // if set (+include_advisory): per-cycle
                                               // projection log written by the engine

    static OnlineEnvConfig from_json(const nlohmann::json& j);
    static OnlineEnvConfig from_file(const std::string& path);
};

class OnlineEnv {
public:
    explicit OnlineEnv(OnlineEnvConfig config);

    // gym-style API. Both return JSON (see doc §8.5/§8.7). Every transition
    // return carries a "status" field: "decision" | "waiting_for_events" |
    // "terminal" (trace mode never yields "waiting_for_events").
    nlohmann::json reset();          // { "obs":..., "status":.., "info":... }
    nlohmann::json step(int action); // { "obs":.., "reward":.., "done":.., "status":.., "truncated":.., "info":.. }

    // Stream-mode ingestion (workload_mode == Stream). See docs/live-adapter.md.
    //   submit_jobs   — register one or a batch of jobs; returns
    //                   { "accepted":[ids], "rejected":[{"job_id":..,"reason":..}] }.
    //                   Never advances the clock; never throws on a bad job.
    //   stream_advance — client asserts no further events with time <= until;
    //                    advances the sim up to `until` and returns a transition.
    //   stream_end     — no more jobs ever; runs out remaining decisions to term.
    nlohmann::json submit_jobs(const nlohmann::json& msg);
    nlohmann::json stream_advance(SimTime until);
    nlohmann::json stream_end();

    int  action_count()               const { return static_cast<int>(config_.pool.size()); }
    bool done()                       const { return done_; }
    int  policy_index(const std::string& type) const;  // -1 if not in pool

    // Read-only access to the underlying simulator (e.g. per-job start times for
    // fidelity checks against the offline Driver). Valid after reset().
    const Simulator& simulator() const { return *sim_; }

    // Number of this-episode jobs whose submit_time is strictly after the current
    // sim time — i.e. future arrivals that must NOT be visible to a projection
    // fork taken now. Used by the fork-visibility audit.
    int pending_arrivals() const;

private:
    void           build_sim();
    // JIT submit injection, bounded by min(next event, next pending submit, horizon).
    void           inject_due_submits(std::optional<Event> next_ev, SimTime horizon);
    AdvanceResult  advance_to_decision();      // horizon-bounded; see AdvanceResult
    SimTime        stream_horizon() const;     // +inf (trace/ended), else asserted-until
    nlohmann::json observe_after_advance(AdvanceResult r);  // sets done_/at_decision_, builds obs
    static const char* status_string(AdvanceResult r);
    void           dispatch_with(Simulator& s, SimTime t,
                                 SchedulerPolicy* policy,
                                 const LegacyDispatchConfig& bf) const;
    nlohmann::json build_obs();                // computes/caches projections if enabled
    nlohmann::json build_pool_json()       const;
    Projection     project_policy(const PoolEntry& entry, SimTime deadline) const;
    void           compute_projections();      // fills last_projections_ for this decision
    void           write_advisory_rows(int cycle, SimTime t, const std::string& committed);
    nlohmann::json episode_summary()       const;

    OnlineEnvConfig     config_;
    std::vector<SimJob> jobs_all_;             // trace loaded once

    std::unique_ptr<Simulator>                    sim_;
    std::vector<std::unique_ptr<SchedulerPolicy>> pool_policies_;

    std::vector<SimJob> episode_jobs_;   // sorted, shifted slice for this episode
    std::size_t         submit_cursor_ = 0;  // next job to inject (JIT)

    // Dispatch control: set just before stepping a pending SchedulingCycle so
    // the (single, persistent) callback applies the agent-chosen policy.
    SchedulerPolicy*     active_policy_ = nullptr;
    LegacyDispatchConfig active_backfill_{};

    int  step_index_    = 0;
    bool done_          = true;
    bool at_decision_   = false;               // true iff a decision is pending (step() legal)
    int  episode_count_ = 0;
    std::unordered_set<int> started_ids_;      // jobs already counted as started

    // Stream-mode frontier state (unused in Trace mode).
    //   asserted_until_ — highest T the client has proven complete (nullopt = none
    //                     asserted yet); the sim may never advance past it. Also the
    //                     rejection frontier: a submit_time <= asserted_until_ would
    //                     rewrite already-settled history and is rejected.
    //   stream_ended_   — stream_end received; horizon becomes +inf (run to term).
    //   known_ids_      — every job id ever accepted this episode (duplicate guard).
    std::optional<SimTime>  asserted_until_;
    bool                    stream_ended_ = false;
    std::unordered_set<int> known_ids_;

    // Incremental completed-job aggregation. completed_jobs_ is append-only, so
    // both the reward accounting (step) and the avg-wait metric (build_obs) fold
    // only the NEW tail each cycle instead of rescanning all completions — the
    // difference between O(N) and O(N^2) over a full trace. Folding in index
    // order keeps the running sums bit-identical to the old from-scratch loops.
    std::size_t completed_note_cursor_  = 0;   // step(): tail folded into started_ids_
    std::size_t completed_agg_cursor_   = 0;   // build_obs(): tail folded into avg wait
    double      completed_agg_wait_sum_ = 0.0; // running sum of (start - submit)
    std::size_t completed_agg_count_    = 0;   // completed jobs with a valid start

    std::vector<Projection> last_projections_; // projections for the current decision
    std::ofstream           advisory_file_;    // per-cycle projection log (optional)
};
