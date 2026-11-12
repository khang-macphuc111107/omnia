cmake_minimum_required(VERSION 3.24)

if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
    project(OmniaNativeShell
        VERSION 4.0.0
        DESCRIPTION "Omnia Native C++20 Win32 + DWM Mica + Direct2D + Server-Side UIA Shell"
        LANGUAGES CXX
    )
    set(CMAKE_CXX_STANDARD 20)
    set(CMAKE_CXX_STANDARD_REQUIRED ON)
    set(CMAKE_CXX_EXTENSIONS OFF)
    set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
    enable_testing()
endif()

function(omnia_configure_native_target TARGET_NAME)
    target_compile_features(${TARGET_NAME} PUBLIC cxx_std_20)
    if(MSVC)
        target_compile_options(${TARGET_NAME} PRIVATE /utf-8 /EHsc /W4 /WX /Zc:__cplusplus /permissive-)
        target_compile_definitions(${TARGET_NAME} PUBLIC
            NOMINMAX
            WIN32_LEAN_AND_MEAN
            UNICODE
            _UNICODE
            _CRT_SECURE_NO_WARNINGS
            _WINSOCK_DEPRECATED_NO_WARNINGS
        )
    else()
        target_compile_options(${TARGET_NAME} PRIVATE -Wall -Wextra -Wpedantic -Werror)
    endif()
endfunction()

add_library(omnia_native_lib STATIC
    src/types.cpp
    src/store.cpp
    src/sessions.cpp
    src/composer.cpp
    src/uia_provider.cpp
    src/session_panel.cpp
    src/win32_shell.cpp
)
omnia_configure_native_target(omnia_native_lib)
target_include_directories(omnia_native_lib PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)
target_link_libraries(omnia_native_lib PUBLIC
    winsqlite3
    bcrypt
    ws2_32
    dwmapi
    d2d1
    dwrite
    uiautomationcore
    comctl32
    uxtheme
    gdi32
    user32
    ole32
    oleaut32
)

add_executable(omnia-native WIN32
    src/main.cpp
    app.manifest
)
omnia_configure_native_target(omnia-native)
target_link_libraries(omnia-native PRIVATE omnia_native_lib)

add_executable(omnia_qa_seed
    src/qa_seed.cpp
)
omnia_configure_native_target(omnia_qa_seed)
target_link_libraries(omnia_qa_seed PRIVATE omnia_native_lib)

add_executable(omnia_native_tests
    tests/test_native_cpp.cpp
)
omnia_configure_native_target(omnia_native_tests)
target_link_libraries(omnia_native_tests PRIVATE omnia_native_lib)

set(OMNIA_NATIVE_TEST_CASES
    default_is_projectless_chat_projection
    command_routing_rejects_unknown_commands
    unchanged_rendered_default_is_clean
    every_field_is_preserved_exactly
    reverting_or_accepting_new_baseline_clears_dirty_state
    symbol_palette_covers_math_physics_and_chemistry_with_unicode_previews
    paste_cancel_never_mutates_draft_while_inline_and_tray_share_deduped_payload
    drag_drop_zones_and_start_end_multi_file_ordering
    conversion_states_send_readiness_encrypted_honesty_undo_redo_and_restart_persistence
    worker_returns_durable_state_without_ui_thread_database_calls
    command_queue_is_bounded_and_drop_cancels_pending_work
    native_page_is_bounded_and_preserves_off_page_active_metadata
    native_sessions_reopen_with_exact_shared_schema_and_navigation
    native_metadata_view_shares_admission_owner_without_recovery
    stale_and_invalid_settings_do_not_overwrite_committed_values
    native_repository_reads_read_only_connection_without_recovery_or_writes
    native_repository_observes_callers_transaction_and_app_profile_scope
    native_selection_retains_adapter_and_routing_policy
    native_disabled_and_missing_secret_fail_before_destination_work
    malformed_reference_is_rejected_before_secret_callback
    invalid_secret_is_rejected_before_creating_credential
    native_event_is_committed_before_notification_and_replays_after_reopen
    native_journal_rejection_cancels_without_notifying_or_creating_an_event
    native_nested_approval_is_published_only_after_sender_readiness
    native_consumer_executes_http_stream_and_reopens_durable_transcript
    native_consumer_preserves_failed_provider_turn_without_retry
    native_consumer_cancels_pending_stream_and_saves_observed_spend
    native_consumer_does_not_report_success_after_recorded_persistence_failure
    shared_preparation_reads_current_native_settings_without_a_second_store
)

foreach(CASE_NAME IN LISTS OMNIA_NATIVE_TEST_CASES)
    add_test(
        NAME "native.${CASE_NAME}"
        COMMAND omnia_native_tests --test "${CASE_NAME}"
    )
endforeach()
