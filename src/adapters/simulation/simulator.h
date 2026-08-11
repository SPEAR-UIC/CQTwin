#pragma once

#include <vector>
#include <deque>
#include <queue>
#include <unordered_map>
#include <unordered_set>
#include <functional>
#include <optional>
#include <memory>
#include <stdexcept>
#include <string>

#include "event.h"
#include "maintenance.h"
#include "../../core/job.h"
#include "../../core/node.h"
#include "../../core/sim_time.h"

enum class SimMode {
    Normal,   // scheduler sees requested walltime; jobs still end at runtime
    Perfect   // scheduler sees runtime as walltime; jobs still end at runtime
};

SimMode parse_sim_mode(const std::string& raw_mode);
const char* sim_mode_name(SimMode mode);

class Simulator {
public:
    // ── Construction ─────────────────────────────────────────────────────────
    Simulator(std::vector<SimJob> jobs,
              std::vector<NodeInfo> nodes,
              SimMode mode,
              const std::string& log_dir = "");

    // ── Copy / Move ──────────────────────────────────────────────────────────
    // get_copy: creates an isolated snapshot of simulator state.
    // enable_logging=false for lightweight copies with no file I/O.
    Simulator get_copy(bool enable_logging = true) const;

    // get_projection_copy: an isolated snapshot for a bounded-horizon *rollout*
    // (advisory projection) that starts the append-only history structures
    // (completed_jobs_, first_start_times_, completed_end_times_) EMPTY instead
    // of copying them. Those are never read for pre-fork jobs during a rollout —
    // backfill reads only running jobs' end times, and the rollout writes its own
    // start/completion entries for the jobs it advances — so a rollout on this
    // copy is identical to one on a full get_copy() (guarded by
    // tests/test_online_projection_copy.cpp), but the copy is O(running) instead
    // of O(completed) = O(N). Never logs. Do NOT use where pre-fork job history
    // must be readable (e.g. scenario_preview keeps get_copy()).
    Simulator get_projection_copy() const;
    Simulator(Simulator&&) noexcept = default;
    Simulator& operator=(Simulator&&) noexcept = default;

    // ── Event injection ──────────────────────────────────────────────────────
    void create_submit_event(SimTime time, int job_id);
    void create_scheduling_cycle_event(SimTime time);

    // Register job data without creating a Submit event.
    // Used by Driver for JIT submission: job metadata must be available before
    // the corresponding Submit event fires and the scheduling callback runs.
    void register_job(const SimJob& job);

    // Inject a SchedulingCycle event at the current time.
    // Useful when a scheduling policy needs to force reconsideration.
    void inject_scheduling_cycle();

    // ── Event stepping ───────────────────────────────────────────────────────
    Event                  step();
    std::optional<Event>   peek()          const;
    std::vector<Event>     kpeek(int k)    const;
    bool                   has_events()    const;
    bool                   is_done()       const;

    // ── Job queue access / reordering ────────────────────────────────────────
    // Policies may inspect and rewrite the queue directly before calling step().
    const std::deque<int>& get_job_queue()                          const;
    void                   sort_job_queue(const std::deque<int>& new_order);

    // ── Scheduling callback ──────────────────────────────────────────────────
    // Called on every SchedulingCycle event.
    // Signature: void fn(Simulator& sim, SimTime current_time)
    // Leave unset for pure event replay / snapshot stepping.
    using SchedulingCycleFn = std::function<void(Simulator&, SimTime)>;
    void set_scheduling_callback(SchedulingCycleFn fn);

    // ── Simulator configuration ──────────────────────────────────────────────
    void set_mode(SimMode mode);
    void set_backfilling(bool enabled);
    void set_logging(bool enabled);
    bool is_logging_enabled() const;

    // ── Maintenance ──────────────────────────────────────────────────────────
    void add_maintenance_windows(const std::vector<MaintenanceWindow>& windows);
    void append_maintenance_windows(const std::vector<MaintenanceWindow>& windows);
    SimTime next_maintenance_start() const;
    bool maintenance_active()     const { return maintenance_active_; }

    // ── Helpers exposed for scheduling callbacks and MCTS ────────────────────
    bool            try_start_job(int job_id, SimTime current_time, bool is_backfill = false);
    int             available_procs()            const;
    int             total_procs()                const;
    const SimJob&   get_job(int job_id)          const;
    SimTime         job_start_time(int job_id)   const;
    SimTime         job_end_time(int job_id)     const;
    SimTime         current_time()               const;
    SimMode         mode()                       const;
    int             sim_id()                     const;
    SimTime         job_duration_for(int job_id) const;
    SimTime         job_walltime_for(int job_id) const;

    // ── Backfill helpers ─────────────────────────────────────────────────────
    SimTime earliest_start_time(int procs_needed) const;
    SimTime get_job_end_time(int job_id)          const;
    int     calculate_free_procs_at(SimTime time) const;

    // ── Stats ────────────────────────────────────────────────────────────────
    const std::vector<int>& completed_jobs() const;
    const std::vector<int>& running_jobs()   const;

    // ── Node access ──────────────────────────────────────────────────────────
    const std::vector<NodeInfo>& nodes() const;

private:
    // ── Event handlers ───────────────────────────────────────────────────────
    void handle_submit(const Event& e);
    void handle_resubmit(const Event& e);
    void handle_run(const Event& e);
    void handle_end(const Event& e);
    void handle_scheduling_cycle(const Event& e);
    void handle_sma(const Event& e);
    void handle_sms(const Event& e);
    void handle_sme(const Event& e);
    void handle_ums(const Event& e);
    void handle_ume(const Event& e);

    // ── Default FIFO scheduling ──────────────────────────────────────────────
    void default_scheduling_cycle(SimTime current_time);

    // ── Internal helpers ─────────────────────────────────────────────────────
    void push_event(Event e);
    SimTime job_duration(const SimJob& job) const;

    // ── Private copy constructor (used by get_copy / get_projection_copy) ────
    // reset_history=true starts the append-only history maps/vectors empty
    // (completed_jobs_, first_start_times_, completed_end_times_) for rollouts.
    Simulator(const Simulator& other, bool enable_logging, bool reset_history = false);

    // ── State ────────────────────────────────────────────────────────────────
    SimMode mode_;
    SimTime current_time_ = 0;

    // Jobs: shared across copies — read-only after construction (MCTS safe)
    std::shared_ptr<const std::unordered_map<int, SimJob>> jobs_;

    // Nodes: copied per instance (each copy tracks its own resource state)
    std::vector<NodeInfo> nodes_;

    // Event queue (min-heap: earliest time first, ties broken by priority)
    std::priority_queue<Event, std::vector<Event>, std::greater<Event>> event_queue_;

    // Wait queue (FIFO by default; can be reordered by MXTS or heuristic function)
    std::deque<int> job_queue_;

    // Tracking
    std::vector<int>              running_jobs_;
    std::vector<int>              completed_jobs_;
    std::unordered_map<int, SimTime> first_start_times_; // job_id -> first dispatch time
    std::unordered_map<int, SimTime> completed_end_times_;
    std::unordered_map<int, SimTime> end_times_;      // job_id → scheduled end time
    std::unordered_map<int, int>  job_to_node_;    // job_id → node index in nodes_

    // Scheduling
    SchedulingCycleFn callback_;
    bool              backfilling_enabled_ = false;

    // Logging
    std::string log_dir_;
    int         sim_id_ = -1;
    bool        logging_ = false;

    // Maintenance
    std::vector<MaintenanceWindow>   maintenance_windows_;
    std::optional<MaintenanceWindow> announced_maintenance_;
    bool                             maintenance_active_ = false;
    std::unordered_set<int>          cancelled_end_events_;
};
