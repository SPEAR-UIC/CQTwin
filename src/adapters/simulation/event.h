#pragma once

#include <string>
#include <ostream>
#include "../../core/sim_time.h"

enum class EventType {
    Submit,
    Resubmit,       // RS: killed job re-enters the wait queue via an event
    Run,
    Backfill,
    End,
    SchedulingCycle,
    // ── Scheduled maintenance (known in advance) ─────────────────────────────
    // SMA fires at notice_time (48 h before SMS).  It kills any running job
    // whose walltime extends past the window, issues Resubmit events for those
    // jobs, then inserts SMS into the queue.
    ScheduledMaintenanceAnnounced,  // SMA – pre-loaded
    // SMS is inserted dynamically by SMA at start_time.  Any residual running
    // jobs are force-killed (safety net) and re-entered via Resubmit events.
    // Sets maintenance_active_; inserts SME.
    ScheduledMaintenanceStart,      // SMS – inserted by SMA handler
    // SME is inserted dynamically by SMS at end_time.  Clears maintenance_active_
    // and fires a scheduling cycle.
    ScheduledMaintenanceEnd,        // SME – inserted by SMS handler
    // ── Unscheduled (emergency) maintenance ──────────────────────────────────
    // UMS fires at start_time with no advance notice.  Kills all running jobs,
    // issues Resubmit events timed at UME, and inserts UME.
    UnscheduledMaintenanceStart,    // UMS – pre-loaded
    // UME is inserted dynamically by UMS at end_time.  Clears maintenance_active_
    // and fires a scheduling cycle (Resubmit events already in queue fire first).
    UnscheduledMaintenanceEnd,      // UME – inserted by UMS handler
};

struct Event {
    EventType type;
    SimTime time;
    // job_id: job number for Submit/Resubmit/Run/Backfill/End;
    //         window index for Maintenance*; -1 for SchedulingCycle.
    int job_id;
    long long serial = -1;

    // Priority: earlier time first; ties broken by type priority (lower = first).
    bool operator>(const Event& other) const {
        if (time != other.time) return time > other.time;
        if (priority() != other.priority()) return priority() > other.priority();
        return serial > other.serial;
    }

    std::string type_str() const {
        switch (type) {
            case EventType::Submit:                        return "Submit";
            case EventType::Resubmit:                      return "Resubmit";
            case EventType::Run:                           return "Run";
            case EventType::Backfill:                      return "Backfill";
            case EventType::End:                           return "End";
            case EventType::SchedulingCycle:               return "SchedulingCycle";
            case EventType::ScheduledMaintenanceAnnounced: return "SMA";
            case EventType::ScheduledMaintenanceStart:     return "SMS";
            case EventType::ScheduledMaintenanceEnd:       return "SME";
            case EventType::UnscheduledMaintenanceStart:   return "UMS";
            case EventType::UnscheduledMaintenanceEnd:     return "UME";
        }
        return "Unknown";
    }

private:
    int priority() const {
        // Lower value = processed first at same timestamp.
        switch (type) {
            case EventType::SchedulingCycle:               return -1; // legacy CQSim schedules immediately after each event
            case EventType::End:                           return 0;  // free procs first
            case EventType::ScheduledMaintenanceEnd:       return 1;  // restore before submits
            case EventType::UnscheduledMaintenanceEnd:     return 1;
            case EventType::ScheduledMaintenanceAnnounced: return 2;  // state change before submits
            case EventType::ScheduledMaintenanceStart:     return 2;
            case EventType::UnscheduledMaintenanceStart:   return 2;
            case EventType::Submit:                        return 3;
            case EventType::Resubmit:                      return 3;  // same tier as Submit
            case EventType::Run:                           return 5;
            case EventType::Backfill:                      return 5;
        }
        return 99;
    }
};

inline std::ostream& operator<<(std::ostream& os, const Event& e) {
    os << "Event{" << e.type_str() << " t=" << e.time << " job=" << e.job_id << "}";
    return os;
}
