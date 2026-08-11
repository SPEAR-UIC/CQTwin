#include "policy_factory.h"

#include "bsld.h"
#include "f1.h"
#include "f2.h"
#include "f3.h"
#include "f4.h"
#include "fat.h"
#include "fcsj.h"
#include "fifo.h"
#include "lcf.h"
#include "lcfs.h"
#include "ljf.h"
#include "lrf.h"
#include "scf.h"
#include "sjf.h"
#include "srf.h"
#include "sww.h"
#include "unicep.h"
#include "wfp.h"
#include "wfp1.h"
#include "wfp2.h"

std::unique_ptr<SchedulerPolicy>
make_heuristic_policy(const std::string& type, int window) {
    if (type == "fcfs" || type == "fifo")       return std::make_unique<FifoPolicy>();
    if (type == "sjf")                           return std::make_unique<SjfPolicy>(window);
    if (type == "ljf")                           return std::make_unique<LjfPolicy>(window);
    if (type == "srf")                           return std::make_unique<SrfPolicy>(window);
    if (type == "lrf")                           return std::make_unique<LrfPolicy>(window);
    if (type == "scf")                           return std::make_unique<ScfPolicy>(window);
    if (type == "lcf")                           return std::make_unique<LcfPolicy>(window);
    if (type == "lcfs")                          return std::make_unique<LcfsPolicy>(window);
    if (type == "wfp" || type == "wfp3")         return std::make_unique<WfpPolicy>(window);
    if (type == "wfp1")                          return std::make_unique<Wfp1Policy>(window);
    if (type == "wfp2")                          return std::make_unique<Wfp2Policy>(window);
    if (type == "sww")                           return std::make_unique<SwwPolicy>(window);
    if (type == "fcsj")                          return std::make_unique<FcsjPolicy>(window);
    if (type == "fat")                           return std::make_unique<FatPolicy>(window);
    if (type == "unicep" || type == "unicef")    return std::make_unique<UnicepPolicy>(window);
    if (type == "bsld")                          return std::make_unique<BsldPolicy>(window);
    if (type == "f1")                            return std::make_unique<F1Policy>(window);
    if (type == "f2")                            return std::make_unique<F2Policy>(window);
    if (type == "f3")                            return std::make_unique<F3Policy>(window);
    if (type == "f4")                            return std::make_unique<F4Policy>(window);
    return nullptr;
}
