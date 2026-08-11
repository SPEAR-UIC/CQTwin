#include "legacy_dispatch.h"

#include <algorithm>
#include <unordered_set>

namespace {

struct ReservationPoint {
    SimTime time = 0;
    int free_procs = 0;
};

static SimTime reservation_duration(const SimJob& job, SimMode mode) {
    (void)mode;
    return job.run_time > 0 ? job.run_time : job.walltime;
}

static std::vector<ReservationPoint>
build_reservation_timeline(const Simulator& s, SimTime current_time) {
    std::vector<std::pair<SimTime, int>> releases;
    for (int jid : s.running_jobs()) {
        SimTime end_time = s.get_job_end_time(jid);
        if (end_time < current_time)
            continue;
        releases.push_back({end_time, s.get_job(jid).requested.procs});
    }
    std::sort(releases.begin(), releases.end(),
              [](const auto& a, const auto& b) { return a.first < b.first; });

    std::vector<ReservationPoint> timeline;
    timeline.push_back({current_time, s.available_procs()});

    int free_procs = s.available_procs();
    for (std::size_t i = 0; i < releases.size();) {
        SimTime time = releases[i].first;
        while (i < releases.size() && releases[i].first == time) {
            free_procs += releases[i].second;
            ++i;
        }
        timeline.push_back({time, free_procs});
    }
    return timeline;
}

static std::size_t ensure_timepoint(std::vector<ReservationPoint>& timeline, SimTime time) {
    auto it = std::lower_bound(
        timeline.begin(),
        timeline.end(),
        time,
        [](const ReservationPoint& point, SimTime target) { return point.time < target; }
    );
    if (it != timeline.end() && it->time == time)
        return static_cast<std::size_t>(it - timeline.begin());

    int free_procs = timeline.empty() ? 0 : timeline.front().free_procs;
    if (it != timeline.begin())
        free_procs = (it - 1)->free_procs;

    it = timeline.insert(it, ReservationPoint{time, free_procs});
    return static_cast<std::size_t>(it - timeline.begin());
}

static bool can_fit_interval(const std::vector<ReservationPoint>& timeline,
                             SimTime start,
                             SimTime end,
                             int procs) {
    if (timeline.empty())
        return false;
    if (end <= start)
        end = start;

    auto it = std::upper_bound(
        timeline.begin(),
        timeline.end(),
        start,
        [](SimTime target, const ReservationPoint& point) { return target < point.time; }
    );
    if (it != timeline.begin())
        --it;

    for (; it != timeline.end() && it->time < end; ++it) {
        if (it->free_procs < procs)
            return false;
    }
    return true;
}

static void reserve_interval(std::vector<ReservationPoint>& timeline,
                             SimTime start,
                             SimTime end,
                             int procs) {
    if (end <= start)
        end = start;
    std::size_t begin = ensure_timepoint(timeline, start);
    std::size_t finish = ensure_timepoint(timeline, end);
    for (std::size_t i = begin; i < finish; ++i)
        timeline[i].free_procs -= procs;
}

static SimTime reserve_earliest(std::vector<ReservationPoint>& timeline,
                                SimTime current_time,
                                int procs,
                                SimTime duration) {
    if (timeline.empty())
        return current_time;

    std::size_t i = ensure_timepoint(timeline, current_time);
    while (i < timeline.size()) {
        SimTime candidate = timeline[i].time;
        if (timeline[i].free_procs < procs) {
            ++i;
            continue;
        }
        if (can_fit_interval(timeline, candidate, candidate + duration, procs)) {
            reserve_interval(timeline, candidate, candidate + duration, procs);
            return candidate;
        }
        ++i;
    }

    SimTime candidate = timeline.back().time;
    reserve_interval(timeline, candidate, candidate + duration, procs);
    return candidate;
}

}  // namespace

std::vector<int> legacy_backfill_candidates(const Simulator& s,
                                            const std::deque<int>& remaining,
                                            SimTime current_time,
                                            SimMode mode,
                                            int backfill_mode) {
    std::vector<int> selected;
    if (remaining.size() <= 1 || backfill_mode <= 0)
        return selected;

    std::vector<ReservationPoint> timeline = build_reservation_timeline(s, current_time);
    const SimJob& head = s.get_job(remaining.front());
    reserve_earliest(
        timeline,
        current_time,
        head.requested.procs,
        reservation_duration(head, mode)
    );

    for (std::size_t idx = 1; idx < remaining.size(); ++idx) {
        const SimJob& job = s.get_job(remaining[idx]);
        SimTime duration = reservation_duration(job, mode);
        bool can_backfill = can_fit_interval(
            timeline,
            current_time,
            current_time + duration,
            job.requested.procs
        );
        if (can_backfill)
            selected.push_back(job.id);

        if (backfill_mode == 1) {
            if (can_backfill) {
                reserve_interval(
                    timeline,
                    current_time,
                    current_time + duration,
                    job.requested.procs
                );
            }
        } else {
            reserve_earliest(timeline, current_time, job.requested.procs, duration);
        }
    }

    return selected;
}

std::deque<int> dispatch_ordered_jobs(Simulator& s,
                                      SchedulerPolicy* policy,
                                      SimTime current_time,
                                      int& primary_started,
                                      int& backfill_started) {
    State state;
    state.current_time = current_time;
    state.nodes = s.nodes();
    state.sim = &s;

    for (int id : s.get_job_queue())
        state.pending.push_back(&s.get_job(id));
    for (int id : s.running_jobs())
        state.running.push_back(&s.get_job(id));
    for (const Job* job : state.pending)
        state.job_walltimes.emplace(job->id, s.job_walltime_for(job->id));
    for (const Job* job : state.running)
        state.job_walltimes.emplace(job->id, s.job_walltime_for(job->id));

    std::vector<const Job*> ordered = policy ? policy->order(state) : state.pending;
    std::unordered_set<int> started;

    primary_started = 0;
    backfill_started = 0;

    for (std::size_t i = 0; i < ordered.size(); ++i) {
        int job_id = ordered[i]->id;
        if (!s.try_start_job(job_id, current_time, false))
            break;
        started.insert(job_id);
        primary_started++;
    }

    std::deque<int> remaining;
    for (const Job* job : ordered) {
        if (!started.count(job->id))
            remaining.push_back(job->id);
    }
    return remaining;
}

void install_legacy_scheduling_callback(Simulator& sim,
                                        SchedulerPolicy* policy,
                                        const LegacyDispatchConfig& config,
                                        int* cycle_primary_started,
                                        int* cycle_backfill_started) {
    sim.set_scheduling_callback([policy, config, cycle_primary_started, cycle_backfill_started](Simulator& s, SimTime t) {
        int primary_started = 0;
        int backfill_started = 0;

        std::deque<int> remaining = dispatch_ordered_jobs(
            s,
            policy,
            t,
            primary_started,
            backfill_started
        );

        if (config.backfill && config.backfill_mode > 0 && !remaining.empty()) {
            std::unordered_set<int> backfilled;
            for (int job_id : legacy_backfill_candidates(
                    s,
                    remaining,
                    t,
                    s.mode(),
                    config.backfill_mode)) {
                if (s.try_start_job(job_id, t, true)) {
                    backfilled.insert(job_id);
                    backfill_started++;
                }
            }

            if (!backfilled.empty()) {
                std::deque<int> filtered;
                for (int job_id : remaining) {
                    if (!backfilled.count(job_id))
                        filtered.push_back(job_id);
                }
                remaining = std::move(filtered);
            }
        }

        if (cycle_primary_started)
            *cycle_primary_started = primary_started;
        if (cycle_backfill_started)
            *cycle_backfill_started = backfill_started;

        s.sort_job_queue(remaining);
    });
}
