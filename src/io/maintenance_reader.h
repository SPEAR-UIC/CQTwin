#pragma once

#include <string>
#include <vector>
#include <fstream>
#include <sstream>
#include <stdexcept>

#include "../adapters/simulation/maintenance.h"

// Reads a .mlog file (produced by scripts/preprocess_maintenance.py).
//
// .mlog format (space-separated):
//   # comment lines are ignored
//   <start_unix> <end_unix> <S|U> [<note text...>]
//
//   S = Scheduled (announced notice_hours in advance)
//   U = Unscheduled (notice_time == start_time)
class MaintenanceReader {
public:
    explicit MaintenanceReader(const std::string& mlog_path,
                               double notice_hours = 48.0)
        : mlog_path_(mlog_path),
          notice_seconds_(notice_hours * 3600.0)
    {}

    std::vector<MaintenanceWindow> read() const {
        std::ifstream f(mlog_path_);
        if (!f.is_open())
            throw std::runtime_error("Cannot open maintenance file: " + mlog_path_);

        std::vector<MaintenanceWindow> windows;
        std::string line;
        while (std::getline(f, line)) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            if (line.empty() || line[0] == '#') continue;

            std::istringstream iss(line);
            SimTime start, end;
            std::string type_str;
            if (!(iss >> start >> end >> type_str)) continue;
            if (end <= start) continue;

            bool scheduled = (type_str == "S" || type_str == "s");
            MaintenanceWindow w;
            w.start_time  = start;
            w.end_time    = end;
            w.scheduled   = scheduled;
            w.notice_time = scheduled
                              ? std::max(0.0, start - notice_seconds_)
                              : start;
            windows.push_back(w);
        }
        return windows;
    }

private:
    std::string mlog_path_;
    SimTime     notice_seconds_;
};
