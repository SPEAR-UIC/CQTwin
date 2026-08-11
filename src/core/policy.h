#pragma once

#include <string>
#include "state.h"
#include "decision.h"

class SchedulerPolicy {

    public:
        virtual std::vector<const Job*> order(const State& s) {
            return s.pending;
        }
        virtual std::vector<Decision> schedule(const State& s) = 0;
        virtual std::string name() const = 0;
        virtual std::string last_cycle_policy() const { return ""; }
        virtual int last_cycle_root_branching() const { return 0; }
        virtual std::string last_cycle_possible_policies() const { return ""; }
        virtual int last_cycle_iterations() const { return 0; }
        virtual ~SchedulerPolicy() = default;


};
