
#pragma once

#include "resources.h"
#include "sim_time.h"

enum class JobState{
    Queued,
    Running,
    Held, // Currently not being considered for scheduler
    Completed, // Exit code 0
    Cancelled, // User Cancellation
    Failed
};

struct Job {

    int id;
    JobState state;
    Resources requested;
    SimTime submit_time;
    SimTime walltime;
    double requested_time;
    int priority;
    long long user_id = -1;
    long long group_id = -1;
    int queue_id = -1;
    SimTime start_time = -1;
    SimTime end_time = -1;

    Job(int id, SimTime submit_time, SimTime walltime, Resources requested, int priority = 0,
        double requested_time = -1.0)
        : id(id),
        state(JobState::Queued),
        requested(requested),
        submit_time(submit_time),
        walltime(walltime),
        requested_time(requested_time > 0 ? requested_time : static_cast<double>(walltime)),
        priority(priority)
    {}
};

struct SimJob : Job {
    SimTime run_time = -1;

    SimJob(int id, SimTime submit_time, SimTime walltime, Resources requested, SimTime run_time,
           int priority = 0, double requested_time = -1.0)
        : Job(id, submit_time, walltime, requested, priority, requested_time),
          run_time(run_time)
    {}
};
