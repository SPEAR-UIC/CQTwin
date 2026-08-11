#pragma once

#include <string>
#include "resources.h"

enum class NodeState {
    Online,      // available for scheduling
    Offline,     // down, not usable
    Draining,    // finishing current jobs, no new allocations
    Maintenance, // explicitly under maintenance
};

struct NodeInfo {
    int        id;
    std::string name;
    Resources  total;
    Resources  available;
    NodeState  state = NodeState::Online;

    NodeInfo(int id, std::string name, Resources total)
        : id(id),
          name(std::move(name)),
          total(total),
          available(total)
    {}

    bool can_fit(const Resources& r) const {
        return state == NodeState::Online && r.fits_in(available);
    }

    void allocate(const Resources& r) {
        available -= r;
    }

    void release(const Resources& r) {
        available += r;
    }
};
