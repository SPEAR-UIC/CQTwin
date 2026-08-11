#pragma once

#include <string>
#include <vector>
#include <memory>
#include <fstream>
#include <filesystem>

#include "../adapters/simulation/driver.h"
#include "metrics.h"

class Experiment {
public:
    explicit Experiment(const std::string& description);
    virtual ~Experiment() = default;

    void run();

    const std::string& output_dir() const { return output_dir_; }
    const std::vector<std::unique_ptr<Driver>>& drivers() const { return drivers_; }

    std::string output_dir_;

    void register_driver(std::unique_ptr<Driver> driver);
    void write_metrics(int total_procs, const std::vector<SimJob>& jobs);

protected:
    virtual void input_initialization()  {}
    virtual void driver_initialization() {}
    virtual void output_analytics()      {}

    void log(const std::string& msg);

private:
    void run_serial();
    void run_parallel();

    std::string logging_phase_ = "init";
    std::string description_;
    std::string log_file_path_;

    bool parallel_ = false;

    std::vector<std::unique_ptr<Driver>> drivers_;
};
