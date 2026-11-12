#pragma once

#include <array>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>

namespace omnia::core {

std::array<std::uint8_t, 32> sha256_bytes(std::span<const std::uint8_t> data);
std::array<std::uint8_t, 32> sha256_bytes(std::string_view text);

std::string sha256_hex(std::span<const std::uint8_t> data);
std::string sha256_hex(std::string_view text);

} // namespace omnia::core
