#include "ndjson_server.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cstring>
#include <iostream>
#include <string>

#include <nlohmann/json.hpp>

#include "online_env.h"

using json = nlohmann::json;

namespace {

bool send_line(int fd, const json& j) {
    std::string s = j.dump();
    s.push_back('\n');
    std::size_t sent = 0;
    while (sent < s.size()) {
        ssize_t n = ::send(fd, s.data() + sent, s.size() - sent, 0);
        if (n <= 0) return false;
        sent += static_cast<std::size_t>(n);
    }
    return true;
}

}  // namespace

int run_ndjson_server(OnlineEnv& env, const std::string& host, int port) {
    int server_fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd < 0) { std::perror("socket"); return 1; }

    int opt = 1;
    ::setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port   = htons(static_cast<uint16_t>(port));
    if (::inet_pton(AF_INET, host.c_str(), &addr.sin_addr) != 1) {
        std::cerr << "online-serve: invalid host: " << host << "\n";
        ::close(server_fd);
        return 1;
    }

    if (::bind(server_fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        std::perror("bind");
        ::close(server_fd);
        return 1;
    }

    socklen_t alen = sizeof(addr);
    ::getsockname(server_fd, reinterpret_cast<sockaddr*>(&addr), &alen);
    int actual_port = ntohs(addr.sin_port);

    if (::listen(server_fd, 1) < 0) {
        std::perror("listen");
        ::close(server_fd);
        return 1;
    }

    // Handshake line the launcher reads to learn the (possibly ephemeral) port.
    std::cout << "LISTENING " << actual_port << std::endl;
    std::cout.flush();

    int client = ::accept(server_fd, nullptr, nullptr);
    if (client < 0) { std::perror("accept"); ::close(server_fd); return 1; }

    std::string buf;
    char chunk[4096];
    bool running = true;

    while (running) {
        std::size_t nl;
        while ((nl = buf.find('\n')) == std::string::npos) {
            ssize_t n = ::recv(client, chunk, sizeof(chunk), 0);
            if (n <= 0) { running = false; break; }
            buf.append(chunk, static_cast<std::size_t>(n));
        }
        if (!running) break;

        std::string line = buf.substr(0, nl);
        buf.erase(0, nl + 1);
        if (line.empty()) continue;

        json req;
        try {
            req = json::parse(line);
        } catch (const std::exception&) {
            send_line(client, { { "error", "invalid json" } });
            continue;
        }

        std::string cmd = req.value("cmd", std::string());
        try {
            if (cmd == "reset") {
                send_line(client, env.reset());
            } else if (cmd == "step") {
                int action;
                if (req.contains("action")) {
                    action = req["action"].get<int>();
                } else if (req.contains("policy")) {
                    action = env.policy_index(req["policy"].get<std::string>());
                    if (action < 0)
                        throw std::runtime_error("policy not in pool: " + req["policy"].get<std::string>());
                } else {
                    throw std::runtime_error("step requires 'action' or 'policy'");
                }
                send_line(client, env.step(action));
            } else if (cmd == "submit_job") {
                // Stream-mode ingestion: one "job" object or a "jobs" batch.
                // Returns { accepted:[ids], rejected:[{job_id,reason,...}] }.
                send_line(client, env.submit_jobs(req));
            } else if (cmd == "stream_advance") {
                if (!req.contains("until"))
                    throw std::runtime_error("stream_advance requires 'until'");
                send_line(client, env.stream_advance(req["until"].get<double>()));
            } else if (cmd == "stream_end") {
                send_line(client, env.stream_end());
            } else if (cmd == "close") {
                send_line(client, { { "ok", true } });
                running = false;
            } else {
                send_line(client, { { "error", "unknown cmd: " + cmd } });
            }
        } catch (const std::exception& e) {
            if (!send_line(client, { { "error", e.what() } })) running = false;
        }
    }

    ::close(client);
    ::close(server_fd);
    return 0;
}
