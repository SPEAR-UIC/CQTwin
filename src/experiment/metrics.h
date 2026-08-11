#pragma once

#include <vector>
#include <algorithm>
#include <numeric>
#include <cmath>
#include <limits>

struct PercentileStats {
    double min  = 0, p25 = 0, p50 = 0, p75 = 0, p80 = 0;
    double p90  = 0, p95 = 0, p99 = 0, max = 0, avg = 0;
};

inline double percentile(std::vector<double>& sorted, double p) {
    if (sorted.empty()) return 0.0;
    double idx = p / 100.0 * (sorted.size() - 1);
    int lo = static_cast<int>(idx);
    int hi = lo + 1;
    double frac = idx - lo;
    if (hi >= static_cast<int>(sorted.size())) return sorted.back();
    return sorted[lo] * (1.0 - frac) + sorted[hi] * frac;
}

inline PercentileStats compute_percentile_stats(std::vector<double> vals) {
    PercentileStats s;
    if (vals.empty()) return s;
    std::sort(vals.begin(), vals.end());
    s.min = vals.front();
    s.max = vals.back();
    s.avg = std::accumulate(vals.begin(), vals.end(), 0.0) / vals.size();
    s.p25 = percentile(vals, 25);
    s.p50 = percentile(vals, 50);
    s.p75 = percentile(vals, 75);
    s.p80 = percentile(vals, 80);
    s.p90 = percentile(vals, 90);
    s.p95 = percentile(vals, 95);
    s.p99 = percentile(vals, 99);
    return s;
}

struct MetricsSummary {
    PercentileStats wait_s;       // wait time in seconds
    PercentileStats slowdown;     // bounded slowdown (wait + walltime) / walltime
    double          total_util;   // used core-hours / (makespan * total_procs)
    int             jobs_completed = 0;
    long            makespan_s     = 0;
};
