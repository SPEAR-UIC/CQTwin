#pragma once

#include <optional>
#include <string>
#include <vector>

#include "../core/job.h"
#include "../core/sim_time.h"

// Build one validated SimJob from SWF-semantic primitive fields — the SAME
// record semantics SwfReader::read() applies per trace line: runtime is clamped
// to the request (actual_run = min(run_time, requested_time)); walltime and
// requested_time both take the requested time; priority is 0. Returns nullopt
// for an invalid record (non-positive id / runtime / requested_time / procs, or
// negative submit), and on nullopt sets *reject_reason (when non-null) to a
// short machine-readable slug. Single-sourced so the online stream path
// (submit_job) constructs records identically to trace reads — the stream==trace
// equivalence test guards this. num_allocated_procs is the SWF field-5 fallback
// used only when requested procs are absent; stream callers may pass 0.
std::optional<SimJob> make_swf_job_record(
    long long id, double submit_time, double requested_time, double run_time,
    long long num_requested_procs, long long num_allocated_procs = 0,
    long long requested_memory = 0, long long user_id = -1,
    long long group_id = -1, long long queue_id = -1,
    std::string* reject_reason = nullptr);

class SwfReader {

public:
    explicit SwfReader(const std::string& filepath);
    std::vector<SimJob> read();
    int max_procs()     const;
    int max_nodes()     const;
    SimTime unix_start_time()  const;

private:
    void parse_header(const std::string& line);
    std::string filepath_;
    int max_procs_          = 0;
    int max_nodes_          = 0;
    SimTime unix_start_time_   = 0;
};
