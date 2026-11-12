#pragma once

#include "omnia_native/types.hpp"

#include <string_view>

namespace omnia::native {

void show_startup_error(std::string_view message);
Result<void> run_native_shell();

} // namespace omnia::native
