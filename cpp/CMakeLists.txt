# Omnia Native C++20 Core, Storage, Routing, Bidirectional Graph, Harness & Studio Host

add_library(omnia_core STATIC
    src/core/sha256.cpp
    src/core/json.cpp
    src/core/utf8.cpp
    src/core/redactor.cpp
)
target_include_directories(omnia_core PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)
if(WIN32)
    target_link_libraries(omnia_core PUBLIC bcrypt)
endif()

add_library(omnia_storage STATIC
    src/storage/session_store.cpp
)
target_include_directories(omnia_storage PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)
target_link_libraries(omnia_storage PUBLIC omnia_core)
if(WIN32)
    target_link_libraries(omnia_storage PUBLIC winsqlite3)
endif()

add_library(omnia_routing STATIC
    src/routing/dynamic_router.cpp
)
target_include_directories(omnia_routing PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)
target_link_libraries(omnia_routing PUBLIC omnia_core)

add_library(omnia_graph STATIC
    src/graph/peer_mesh.cpp
    src/graph/graphify_index.cpp
)
target_include_directories(omnia_graph PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)
target_link_libraries(omnia_graph PUBLIC omnia_core)

add_library(omnia_harness STATIC
    src/harness/memory_graph.cpp
    src/harness/proactive_rag.cpp
    src/harness/skill_registry.cpp
    src/harness/composer_steer.cpp
    src/studio/studio_server.cpp
)
target_include_directories(omnia_harness PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)
target_link_libraries(omnia_harness PUBLIC
    omnia_core
    omnia_storage
    omnia_routing
    omnia_graph
)
if(WIN32)
    target_link_libraries(omnia_harness PUBLIC ws2_32 psapi winhttp shell32)
endif()

add_executable(omnia-studio
    apps/omnia_studio/main.cpp
)
target_link_libraries(omnia-studio PRIVATE omnia_harness)

# CTest Suite
function(omnia_add_cpp_test TEST_NAME TEST_SOURCE)
    add_executable(${TEST_NAME} ${TEST_SOURCE})
    target_link_libraries(${TEST_NAME} PRIVATE omnia_harness)
    add_test(
        NAME ${TEST_NAME}
        COMMAND ${TEST_NAME} "$<TARGET_FILE:omnia-studio>" "${CMAKE_SOURCE_DIR}"
    )
endfunction()

omnia_add_cpp_test(test_omnia_core tests/test_core.cpp)
omnia_add_cpp_test(test_omnia_storage tests/test_storage.cpp)
omnia_add_cpp_test(test_omnia_routing tests/test_routing.cpp)
omnia_add_cpp_test(test_omnia_graph tests/test_graph.cpp)
omnia_add_cpp_test(test_omnia_harness tests/test_harness.cpp)
omnia_add_cpp_test(test_omnia_studio_http tests/test_studio_http.cpp)
