#pragma once

#include <string>

class ScenarioPreview {
public:
    explicit ScenarioPreview(const std::string& json_path);
    void run();

private:
    std::string json_path_;
};
