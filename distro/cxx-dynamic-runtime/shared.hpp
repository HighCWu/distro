// SPDX-License-Identifier: MIT
#pragma once

#include <exception>

class CrossError final : public std::exception {
public:
    explicit CrossError(int value) noexcept;
    const char *what() const noexcept override;
    int value() const noexcept;

private:
    int value_;
};

class CleanupGuard final {
public:
    explicit CleanupGuard(int &counter) noexcept : counter_(counter) {}
    CleanupGuard(const CleanupGuard &) = delete;
    CleanupGuard &operator=(const CleanupGuard &) = delete;
    ~CleanupGuard() noexcept { ++counter_; }

private:
    int &counter_;
};

using MainThrowCallback = void (*)(int value, int *cleanup_count);
