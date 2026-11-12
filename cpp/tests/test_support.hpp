#pragma once

#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string_view>

#define OMNIA_CHECK(expr)                                                          \
    do {                                                                           \
        if (!(expr)) {                                                             \
            std::cerr << "[FAIL] " << __FILE__ << ":" << __LINE__                  \
                      << " assertion failed: " #expr << "\n";                      \
            std::exit(1);                                                          \
        }                                                                          \
    } while (false)

#define OMNIA_CHECK_THROWS(expr)                                                   \
    do {                                                                           \
        bool caught_ = false;                                                      \
        try {                                                                      \
            (void)(expr);                                                          \
        } catch (...) {                                                            \
            caught_ = true;                                                        \
        }                                                                          \
        if (!caught_) {                                                            \
            std::cerr << "[FAIL] " << __FILE__ << ":" << __LINE__                  \
                      << " expected exception: " #expr << "\n";                    \
            std::exit(1);                                                          \
        }                                                                          \
    } while (false)
