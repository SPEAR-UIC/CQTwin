#pragma once

#include "../core/policy.h"
#include <memory>
#include <string>

std::unique_ptr<SchedulerPolicy>
make_heuristic_policy(const std::string& type, int window);
