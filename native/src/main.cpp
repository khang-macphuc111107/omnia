#include "omnia_native/win32_shell.hpp"

#include <windows.h>

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    const auto res = omnia::native::run_native_shell();
    if (res.is_err()) {
        omnia::native::show_startup_error(res.error().message);
        return 1;
    }
    return 0;
}
