#include "simulator.h"
#include <algorithm>
#include <cassert>
#include <cctype>
#include <limits>
#include <atomic>

static std::atomic<int> next_sim_id_{0};
static std::atomic<long long> next_event_serial_{0};

SimMode parse_sim_mode(const std::string& raw_mode) {
    std::string mode = raw_mode;
    std::transform(mode.begin(), mode.end(), mode.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    if (mode == "perfect")
        return SimMode::Perfect;
    if (mode == "real" || mode == "prediction")
        return SimMode::Normal;
    return SimMode::Normal;
}

const char* sim_mode_name(SimMode mode) {
    switch (mode) {
        case SimMode::Normal:
            return "normal";
        case SimMode::Perfect:
            return "perfect";
    }
    return "normal";
}

// ── Public constructor ────────────────────────────────────────────────────────

Simulator::Simulator(std::vector<SimJob> jobs, std::vector<NodeInfo> nodes,
                     SimMode mode, const std::string& log_dir)
    : mode_(mode),
      nodes_(std::move(nodes)),
      log_dir_(log_dir),
      sim_id_(next_sim_id_.fetch_add(1)),
      logging_(!log_dir.empty())
{
    auto job_map = std::make_shared<std::unordered_map<int, SimJob>>();
    for (auto& j : jobs)
        job_map->emplace(j.id, std::move(j));
    jobs_ = std::move(job_map);

    for (const auto& [id, job] : *jobs_)
        push_event({EventType::Submit, job.submit_time, id});
}

// ── Private copy constructor (used by get_copy) ───────────────────────────────

Simulator::Simulator(const Simulator& other, bool enable_logging, bool reset_history)
    : mode_(other.mode_),
      current_time_(other.current_time_),
      jobs_(other.jobs_),               // shared — no deep copy
      nodes_(other.nodes_),             // copied — independent resource state
      event_queue_(other.event_queue_),
      job_queue_(other.job_queue_),
      running_jobs_(other.running_jobs_),
      // completed_jobs_, first_start_times_, completed_end_times_ are the only
      // append-only (O(N)) structures; they are assigned in the body so a
      // projection copy (reset_history=true) can skip the O(N) copy entirely.
      end_times_(other.end_times_),         // O(running): erased on job End
      job_to_node_(other.job_to_node_),     // O(running): erased on job End
      // Search / rollout snapshots must not retain the driver's scheduling
      // callback, otherwise stepping a SchedulingCycle inside MCTS re-enters
      // policy scheduling recursively.
      callback_(),
      backfilling_enabled_(other.backfilling_enabled_),
      log_dir_(enable_logging ? other.log_dir_ : ""),
      sim_id_(next_sim_id_.fetch_add(1)),
      logging_(enable_logging && !other.log_dir_.empty()),
      maintenance_windows_(other.maintenance_windows_),
      announced_maintenance_(other.announced_maintenance_),
      maintenance_active_(other.maintenance_active_),
      cancelled_end_events_(other.cancelled_end_events_)
{
    // Full copy: replicate the append-only history so callers that read past
    // job start/end times (e.g. scenario_preview) see the complete record.
    // Projection copy: leave them empty — a bounded rollout never reads pre-fork
    // history (it writes its own for the jobs it advances), so this is behaviour-
    // identical for the projection while making the copy O(running) not O(N).
    if (!reset_history) {
        completed_jobs_      = other.completed_jobs_;
        first_start_times_   = other.first_start_times_;
        completed_end_times_ = other.completed_end_times_;
    }
}

// ── get_copy ──────────────────────────────────────────────────────────────────

Simulator Simulator::get_copy(bool enable_logging) const {
    return Simulator(*this, enable_logging);
}

Simulator Simulator::get_projection_copy() const {
    return Simulator(*this, /*enable_logging=*/false, /*reset_history=*/true);
}

// ── Event injection ───────────────────────────────────────────────────────────

void Simulator::create_submit_event(SimTime time, int job_id) {
    push_event({EventType::Submit, time, job_id});
}

void Simulator::create_scheduling_cycle_event(SimTime time) {
    push_event({EventType::SchedulingCycle, time, -1});
}

void Simulator::register_job(const SimJob& job) {
    const_cast<std::unordered_map<int,SimJob>&>(*jobs_).emplace(job.id, job);
}

void Simulator::inject_scheduling_cycle() {
    create_scheduling_cycle_event(current_time_);
}

// ── Event stepping ────────────────────────────────────────────────────────────

Event Simulator::step() {
    if (event_queue_.empty())
        throw std::runtime_error("Simulator::step() called with no events");

    Event e = event_queue_.top();
    event_queue_.pop();
    current_time_ = e.time;

    switch (e.type) {
        case EventType::Submit:                        handle_submit(e);   break;
        case EventType::Resubmit:                      handle_resubmit(e); break;
        case EventType::Run:                           handle_run(e);      break;
        case EventType::Backfill:                      handle_run(e);      break;
        case EventType::End:                           handle_end(e);      break;
        case EventType::SchedulingCycle:               handle_scheduling_cycle(e); break;
        case EventType::ScheduledMaintenanceAnnounced: handle_sma(e); break;
        case EventType::ScheduledMaintenanceStart:     handle_sms(e); break;
        case EventType::ScheduledMaintenanceEnd:       handle_sme(e); break;
        case EventType::UnscheduledMaintenanceStart:   handle_ums(e); break;
        case EventType::UnscheduledMaintenanceEnd:     handle_ume(e); break;
    }

    return e;
}

std::optional<Event> Simulator::peek() const {
    if (event_queue_.empty()) return std::nullopt;
    return event_queue_.top();
}

std::vector<Event> Simulator::kpeek(int k) const {
    auto pq = event_queue_;
    std::vector<Event> result;
    for (int i = 0; i < k && !pq.empty(); ++i) {
        result.push_back(pq.top());
        pq.pop();
    }
    return result;
}

bool Simulator::has_events() const { return !event_queue_.empty(); }
bool Simulator::is_done()    const { return event_queue_.empty(); }

// ── Job queue ────────────────────────────────────────────────────────────────

const std::deque<int>& Simulator::get_job_queue() const { return job_queue_; }

void Simulator::sort_job_queue(const std::deque<int>& new_order) {
    job_queue_ = new_order;
}

// ── Configuration ─────────────────────────────────────────────────────────────

void Simulator::set_scheduling_callback(SchedulingCycleFn fn) {
    callback_ = std::move(fn);
}

void Simulator::set_mode(SimMode mode)          { mode_ = mode; }
void Simulator::set_backfilling(bool enabled)   { backfilling_enabled_ = enabled; }

void Simulator::set_logging(bool enabled) {
    logging_ = enabled && !log_dir_.empty();
}

bool Simulator::is_logging_enabled() const { return logging_; }

// ── Maintenance ───────────────────────────────────────────────────────────────

void Simulator::add_maintenance_windows(const std::vector<MaintenanceWindow>& windows) {
    maintenance_windows_ = windows;
    std::sort(maintenance_windows_.begin(), maintenance_windows_.end(),
              [](const MaintenanceWindow& a, const MaintenanceWindow& b) {
                  return a.start_time < b.start_time;
              });

    for (int i = 0; i < static_cast<int>(maintenance_windows_.size()); ++i) {
        const auto& w = maintenance_windows_[i];
        if (w.scheduled)
            push_event({EventType::ScheduledMaintenanceAnnounced, w.notice_time, i});
        else
            push_event({EventType::UnscheduledMaintenanceStart, w.start_time, i});
    }
}

void Simulator::append_maintenance_windows(const std::vector<MaintenanceWindow>& windows) {
    if (windows.empty())
        return;

    std::vector<MaintenanceWindow> incoming = windows;
    std::sort(incoming.begin(), incoming.end(),
              [](const MaintenanceWindow& a, const MaintenanceWindow& b) {
                  if (a.start_time != b.start_time)
                      return a.start_time < b.start_time;
                  return a.notice_time < b.notice_time;
              });

    for (const auto& window : incoming) {
        maintenance_windows_.push_back(window);
        int index = static_cast<int>(maintenance_windows_.size()) - 1;
        if (window.scheduled)
            push_event({EventType::ScheduledMaintenanceAnnounced, window.notice_time, index});
        else
            push_event({EventType::UnscheduledMaintenanceStart, window.start_time, index});
    }
}

SimTime Simulator::next_maintenance_start() const {
    return announced_maintenance_
        ? announced_maintenance_->start_time
        : std::numeric_limits<SimTime>::max();
}

// ── Accessors ─────────────────────────────────────────────────────────────────

int  Simulator::available_procs() const {
    int free = 0;
    for (const auto& n : nodes_)
        if (n.state == NodeState::Online)
            free += n.available.procs;
    return free;
}

int Simulator::total_procs() const {
    int total = 0;
    for (const auto& n : nodes_)
        total += n.total.procs;
    return total;
}

const SimJob& Simulator::get_job(int job_id) const {
    return jobs_->at(job_id);
}

SimTime Simulator::job_start_time(int job_id) const {
    auto it = first_start_times_.find(job_id);
    return it != first_start_times_.end() ? it->second : -1;
}

SimTime Simulator::job_end_time(int job_id) const {
    auto done = completed_end_times_.find(job_id);
    if (done != completed_end_times_.end()) return done->second;
    auto live = end_times_.find(job_id);
    return live != end_times_.end() ? live->second : -1;
}

SimTime Simulator::current_time()               const { return current_time_; }
SimMode Simulator::mode()                       const { return mode_; }
int     Simulator::sim_id()                     const { return sim_id_; }

SimTime Simulator::job_duration_for(int job_id) const {
    return job_walltime_for(job_id);
}

SimTime Simulator::job_walltime_for(int job_id) const {
    const SimJob& j = jobs_->at(job_id);
    if (mode_ == SimMode::Perfect)
        return j.run_time > 0 ? j.run_time : j.walltime;
    return j.walltime > 0 ? j.walltime : j.run_time;
}

const std::vector<int>&      Simulator::completed_jobs() const { return completed_jobs_; }
const std::vector<int>&      Simulator::running_jobs()   const { return running_jobs_; }
const std::vector<NodeInfo>& Simulator::nodes()          const { return nodes_; }

// ── try_start_job ─────────────────────────────────────────────────────────────

bool Simulator::try_start_job(int job_id, SimTime current_time, bool is_backfill) {
    auto it = jobs_->find(job_id);
    if (it == jobs_->end()) return false;

    const SimJob& job = it->second;
    const Resources& req = job.requested;

    // Find the first online node that can fit this job
    NodeInfo* target = nullptr;
    int target_idx = -1;
    for (int i = 0; i < static_cast<int>(nodes_.size()); ++i) {
        if (nodes_[i].can_fit(req)) { target = &nodes_[i]; target_idx = i; break; }
    }
    if (!target) return false;

    // Block jobs that would spill past an announced maintenance window
    SimTime walltime = job_walltime_for(job_id);
    if (announced_maintenance_) {
        if (current_time + walltime > announced_maintenance_->start_time)
            return false;
    }

    first_start_times_.emplace(job_id, current_time);
    target->allocate(req);
    running_jobs_.push_back(job_id);
    end_times_[job_id]   = current_time + walltime;
    job_to_node_[job_id] = target_idx;

    SimTime actual_end = current_time + job_duration(job);
    EventType run_type = is_backfill ? EventType::Backfill : EventType::Run;
    push_event({run_type,          current_time, job_id});
    push_event({EventType::End,    actual_end,   job_id});

    return true;
}

// ── Backfill helpers ──────────────────────────────────────────────────────────

SimTime Simulator::get_job_end_time(int job_id) const {
    auto it = end_times_.find(job_id);
    return (it != end_times_.end()) ? it->second : -1;
}

SimTime Simulator::earliest_start_time(int procs_needed) const {
    if (procs_needed <= available_procs()) return current_time_;

    std::vector<std::pair<SimTime, int>> timeline;
    for (int jid : running_jobs_) {
        auto et = end_times_.find(jid);
        if (et == end_times_.end()) continue;
        timeline.push_back({et->second, jobs_->at(jid).requested.procs});
    }
    std::sort(timeline.begin(), timeline.end());

    int free = available_procs();
    for (const auto& [time, procs] : timeline) {
        free += procs;
        if (free >= procs_needed) return time;
    }
    return std::numeric_limits<SimTime>::max();
}

int Simulator::calculate_free_procs_at(SimTime time) const {
    int used = 0;
    for (int jid : running_jobs_) {
        if (get_job_end_time(jid) > time)
            used += jobs_->at(jid).requested.procs;
    }
    return total_procs() - used;
}

// ── Event handlers ────────────────────────────────────────────────────────────

void Simulator::handle_submit(const Event& e) {
    job_queue_.push_back(e.job_id);
    if (!maintenance_active_)
        push_event({EventType::SchedulingCycle, e.time, -1});
}

void Simulator::handle_resubmit(const Event& e) {
    job_queue_.push_front(e.job_id);
    if (!maintenance_active_)
        push_event({EventType::SchedulingCycle, current_time_, -1});
}

void Simulator::handle_run(const Event& /*e*/) {
    // Informational — dispatch already happened in try_start_job
}

void Simulator::handle_end(const Event& e) {
    if (cancelled_end_events_.count(e.job_id)) {
        cancelled_end_events_.erase(e.job_id);
        return;
    }

    const SimJob& job = jobs_->at(e.job_id);

    auto node_it = job_to_node_.find(e.job_id);
    if (node_it != job_to_node_.end()) {
        nodes_[node_it->second].release(job.requested);
        job_to_node_.erase(node_it);
    }

    running_jobs_.erase(
        std::remove(running_jobs_.begin(), running_jobs_.end(), e.job_id),
        running_jobs_.end());
    completed_jobs_.push_back(e.job_id);
    completed_end_times_[e.job_id] = e.time;
    end_times_.erase(e.job_id);

    push_event({EventType::SchedulingCycle, e.time, -1});
}

void Simulator::handle_scheduling_cycle(const Event& e) {
    if (callback_)
        callback_(*this, e.time);
    else
        default_scheduling_cycle(e.time);
}

// ── Default FIFO + optional EASY backfill ─────────────────────────────────────

void Simulator::default_scheduling_cycle(SimTime current_time) {
    if (maintenance_active_) return;

    while (!job_queue_.empty()) {
        int job_id = job_queue_.front();
        if (!try_start_job(job_id, current_time)) break;
        job_queue_.pop_front();
    }

    if (!backfilling_enabled_ || job_queue_.empty()) return;

    int head_procs = jobs_->at(job_queue_.front()).requested.procs;
    SimTime shadow_time = earliest_start_time(head_procs);
    if (announced_maintenance_)
        shadow_time = std::min(shadow_time, announced_maintenance_->start_time);

    auto it = std::next(job_queue_.begin());
    while (it != job_queue_.end()) {
        int jid = *it;
        const SimJob& job = jobs_->at(jid);
        int procs = job.requested.procs;
        SimTime duration = job_walltime_for(jid);

        if (procs <= available_procs()) {
            if ((current_time + duration <= shadow_time) ||
                (calculate_free_procs_at(shadow_time) - procs >= head_procs)) {
                if (try_start_job(jid, current_time, true)) {
                    it = job_queue_.erase(it);
                    continue;
                }
            }
        }
        ++it;
    }
}

// ── Maintenance handlers ──────────────────────────────────────────────────────

static void kill_job(int jid, SimTime resubmit_time,
                     const std::shared_ptr<const std::unordered_map<int, SimJob>>& jobs,
                     std::vector<NodeInfo>& nodes,
                     std::vector<int>& running_jobs,
                     std::unordered_map<int, SimTime>& end_times,
                     std::unordered_map<int, int>& job_to_node,
                     std::unordered_set<int>& cancelled,
                     std::priority_queue<Event, std::vector<Event>, std::greater<Event>>& eq)
{
    const SimJob& job = jobs->at(jid);

    auto node_it = job_to_node.find(jid);
    if (node_it != job_to_node.end()) {
        nodes[node_it->second].release(job.requested);
        job_to_node.erase(node_it);
    }

    cancelled.insert(jid);
    end_times.erase(jid);
    running_jobs.erase(std::remove(running_jobs.begin(), running_jobs.end(), jid),
                       running_jobs.end());
    eq.push({EventType::Resubmit, resubmit_time, jid});
}

void Simulator::handle_sma(const Event& e) {
    int idx = e.job_id;
    const MaintenanceWindow& w = maintenance_windows_[idx];
    announced_maintenance_ = w;

    // Kill any job whose walltime spills past the maintenance start
    std::vector<int> spillers;
    for (int jid : running_jobs_) {
        auto it = end_times_.find(jid);
        if (it != end_times_.end() && it->second > w.start_time)
            spillers.push_back(jid);
    }
    for (int jid : spillers)
        kill_job(jid, e.time, jobs_, nodes_, running_jobs_, end_times_,
                 job_to_node_, cancelled_end_events_, event_queue_);

    push_event({EventType::ScheduledMaintenanceStart, w.start_time, idx});
    push_event({EventType::SchedulingCycle,           e.time,        -1});
}

void Simulator::handle_sms(const Event& e) {
    int idx = e.job_id;
    const MaintenanceWindow& w = maintenance_windows_[idx];
    maintenance_active_      = true;
    announced_maintenance_   = std::nullopt;

    // Set affected nodes to Maintenance state
    if (w.node_ids.empty()) {
        for (auto& n : nodes_) n.state = NodeState::Maintenance;
    } else {
        for (int nid : w.node_ids)
            if (nid < static_cast<int>(nodes_.size()))
                nodes_[nid].state = NodeState::Maintenance;
    }

    // Safety net: kill any residual running jobs
    std::vector<int> residual(running_jobs_);
    for (int jid : residual)
        kill_job(jid, e.time, jobs_, nodes_, running_jobs_, end_times_,
                 job_to_node_, cancelled_end_events_, event_queue_);

    push_event({EventType::ScheduledMaintenanceEnd, w.end_time, idx});
}

void Simulator::handle_sme(const Event& e) {
    int idx = e.job_id;
    const MaintenanceWindow& w = maintenance_windows_[idx];
    maintenance_active_ = false;

    // Restore affected nodes
    if (w.node_ids.empty()) {
        for (auto& n : nodes_) n.state = NodeState::Online;
    } else {
        for (int nid : w.node_ids)
            if (nid < static_cast<int>(nodes_.size()))
                nodes_[nid].state = NodeState::Online;
    }

    push_event({EventType::SchedulingCycle, e.time, -1});
}

void Simulator::handle_ums(const Event& e) {
    int idx = e.job_id;
    const MaintenanceWindow& w = maintenance_windows_[idx];
    maintenance_active_ = true;

    if (w.node_ids.empty()) {
        for (auto& n : nodes_) n.state = NodeState::Maintenance;
    } else {
        for (int nid : w.node_ids)
            if (nid < static_cast<int>(nodes_.size()))
                nodes_[nid].state = NodeState::Maintenance;
    }

    std::vector<int> all_running(running_jobs_);
    for (int jid : all_running)
        kill_job(jid, w.end_time, jobs_, nodes_, running_jobs_, end_times_,
                 job_to_node_, cancelled_end_events_, event_queue_);

    push_event({EventType::UnscheduledMaintenanceEnd, w.end_time, idx});
}

void Simulator::handle_ume(const Event& e) {
    int idx = e.job_id;
    const MaintenanceWindow& w = maintenance_windows_[idx];
    maintenance_active_ = false;

    if (w.node_ids.empty()) {
        for (auto& n : nodes_) n.state = NodeState::Online;
    } else {
        for (int nid : w.node_ids)
            if (nid < static_cast<int>(nodes_.size()))
                nodes_[nid].state = NodeState::Online;
    }

    push_event({EventType::SchedulingCycle, e.time, -1});
}

// ── Internal helpers ──────────────────────────────────────────────────────────

void Simulator::push_event(Event e) {
    if (e.serial < 0)
        e.serial = next_event_serial_.fetch_add(1);
    event_queue_.push(std::move(e));
}

SimTime Simulator::job_duration(const SimJob& job) const {
    return job.run_time > 0 ? job.run_time : job.walltime;
}
