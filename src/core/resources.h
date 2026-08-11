#pragma once

struct Resources{
    int procs = 0;
    long memory_mb = 0;
    int gpus = 0;

    // Checks if this resrouce requirement fits entirely fits within another resource pool
    bool operator<=(const Resources& other) const {
        return procs <= other.procs &&
                memory_mb <= other.memory_mb &&
                gpus <= other.gpus;
    }

    // Accumulates resources
    Resources& operator+=(const Resources& other) {
        procs += other.procs;
        memory_mb += other.memory_mb;
        gpus += other.gpus;
        return *this;
    }

    //Frees/subtracts resources
    Resources& operator-=(const Resources& other) {
        procs -= other.procs;
        memory_mb -= other.memory_mb;
        gpus -=other.gpus;
        return *this;
    }

    //Named alias for the <= operator, for better readability
    bool fits_in(const Resources& available) const {
        return *this <= available;
    }

};