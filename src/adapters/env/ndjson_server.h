#pragma once

#include <string>

class OnlineEnv;

// Serve one OnlineEnv over a line-delimited JSON (NDJSON) request/response loop
// on a TCP socket. Handles a single client connection (the driving agent).
//
// Requests (one JSON object per line):
//   {"cmd":"reset"}                       -> {"obs":..,"info":..}
//   {"cmd":"step","action":<int>}         -> {"obs":..,"reward":..,"done":..,"truncated":..,"info":..}
//   {"cmd":"step","policy":"<name>"}      -> same (name mapped to pool index)
//   {"cmd":"close"}                       -> {"ok":true}, then disconnects
//
// If port == 0 the OS assigns an ephemeral port; the chosen port is printed to
// stdout as "LISTENING <port>" so a launcher can read it. Returns 0 on clean
// shutdown, non-zero on a fatal socket error.
int run_ndjson_server(OnlineEnv& env, const std::string& host, int port);
