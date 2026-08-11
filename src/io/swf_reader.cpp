#include "swf_reader.h"
#include <cmath>
#include <fstream>
#include <sstream>
#include <stdexcept>

std::optional<SimJob> make_swf_job_record(
    long long id, double submit_time, double requested_time, double run_time,
    long long num_requested_procs, long long num_allocated_procs,
    long long requested_memory, long long user_id,
    long long group_id, long long queue_id,
    std::string* reject_reason)
{
    auto reject = [&](const char* reason) -> std::optional<SimJob> {
        if (reject_reason) *reject_reason = reason;
        return std::nullopt;
    };

    double actual_run = run_time;
    if (static_cast<long long>(run_time) > static_cast<long long>(requested_time))
        actual_run = requested_time;

    if (id <= 0)                                        return reject("non_positive_id");
    if (static_cast<long long>(submit_time) < 0)        return reject("negative_submit_time");
    if (static_cast<long long>(actual_run) <= 0)        return reject("non_positive_runtime");
    if (static_cast<long long>(requested_time) <= 0)    return reject("non_positive_requested_time");

    Resources res;
    res.procs     = static_cast<int>(num_requested_procs > 0 ? num_requested_procs : num_allocated_procs);
    res.memory_mb = static_cast<long>(requested_memory > 0 ? requested_memory : 0);
    if (res.procs <= 0)                                 return reject("non_positive_procs");

    SimJob job(static_cast<int>(id), submit_time, requested_time, res, actual_run, 0, requested_time);
    job.user_id  = user_id;
    job.group_id = group_id;
    job.queue_id = static_cast<int>(queue_id);
    return job;
}

SwfReader::SwfReader(const std::string& filepath) : filepath_(filepath) {}

std::vector<SimJob> SwfReader::read() {
    std::ifstream file(filepath_);
    if (!file.is_open()) {
        throw std::runtime_error("Failed to open SWF file: " + filepath_);
    }

    std::vector<SimJob> jobs;
    std::string line;

    while (std::getline(file, line)) {
        if (line.empty() || line[0] == ';') {
            parse_header(line);
            continue;
        }

        std::istringstream iss(line);

        long long wait_time, used_memory, requested_memory, think_time;
        double avg_cpu_time;
        long long num_allocated_procs, status, user_id, group_id,
                  executable_number, partition_number, preceding_job_number;

        long long id, queue_id, num_requested_procs;
        double submit_time, run_time;
        double requested_time;

        iss >> id >> submit_time >> wait_time >> run_time
            >> num_allocated_procs >> avg_cpu_time >> used_memory
            >> num_requested_procs >> requested_time >> requested_memory
            >> status >> user_id >> group_id >> executable_number
            >> queue_id >> partition_number >> preceding_job_number >> think_time;

        if (iss.fail()) continue;

        std::optional<SimJob> job = make_swf_job_record(
            id, submit_time, requested_time, run_time,
            num_requested_procs, num_allocated_procs, requested_memory,
            user_id, group_id, queue_id);
        if (job) jobs.push_back(*job);
    }

    return jobs;
}

void SwfReader::parse_header(const std::string& line) {
    if (line.size() < 2 || line[0] != ';') return;

    std::string content = line.substr(1);
    size_t start = content.find_first_not_of(" \t");
    if (start == std::string::npos) return;
    content = content.substr(start);

    size_t colon = content.find(':');
    if (colon == std::string::npos) return;

    std::string key   = content.substr(0, colon);
    std::string value = content.substr(colon + 1);
    start = value.find_first_not_of(" \t");
    if (start != std::string::npos) value = value.substr(start);

    if      (key == "MaxNodes")      max_nodes_       = std::stoi(value);
    else if (key == "MaxProcs")      max_procs_       = std::stoi(value);
    else if (key == "UnixStartTime") unix_start_time_ = std::stod(value);
}

int  SwfReader::max_procs()       const { return max_procs_; }
int  SwfReader::max_nodes()       const { return max_nodes_; }
SimTime SwfReader::unix_start_time() const { return unix_start_time_; }
