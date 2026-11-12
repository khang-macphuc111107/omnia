cmake_minimum_required(VERSION 3.24)

project(Omnia
    VERSION 4.0.0
    DESCRIPTION "Omnia Native C++20 Agentic Studio & Win32 Shell"
    LANGUAGES CXX
)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

enable_testing()

if(MSVC)
    add_compile_options(/utf-8 /EHsc /W4 /WX /Zc:__cplusplus /permissive-)
    add_compile_definitions(
        NOMINMAX
        WIN32_LEAN_AND_MEAN
        UNICODE
        _UNICODE
        _CRT_SECURE_NO_WARNINGS
        _WINSOCK_DEPRECATED_NO_WARNINGS
    )
else()
    add_compile_options(-Wall -Wextra -Wpedantic -Werror)
endif()

option(OMNIA_BUILD_CPP_CORE "Build Omnia C++20 core libraries, studio host, and CTest suite" ON)
option(OMNIA_BUILD_NATIVE_SHELL "Build Win32 shell" ON)

if(OMNIA_BUILD_CPP_CORE AND EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/cpp/CMakeLists.txt")
    add_subdirectory(cpp)
endif()

if(OMNIA_BUILD_NATIVE_SHELL AND EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/native/CMakeLists.txt")
    add_subdirectory(native)
endif()
