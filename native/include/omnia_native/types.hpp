#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

namespace omnia::native {

struct NativeError {
    std::string code;
    std::string message;
    bool retryable{false};

    static NativeError make(std::string code_val, std::string msg_val, bool retry = false) {
        return NativeError{std::move(code_val), std::move(msg_val), retry};
    }

    static NativeError retryable_err(std::string code_val, std::string msg_val) {
        return NativeError{std::move(code_val), std::move(msg_val), true};
    }

    static NativeError invalid(std::string_view field, std::string_view reason) {
        return NativeError{
            "invalid_input",
            std::string(field) + " " + std::string(reason),
            false,
        };
    }

    std::string to_string() const {
        return code + ": " + message;
    }
};

template <typename T>
class Result {
public:
    static Result ok(T val) {
        return Result(std::move(val));
    }

    static Result err(NativeError error) {
        return Result(std::move(error));
    }

    bool is_ok() const noexcept {
        return std::holds_alternative<T>(data_);
    }

    bool is_err() const noexcept {
        return std::holds_alternative<NativeError>(data_);
    }

    const T& value() const& {
        return std::get<T>(data_);
    }

    T& value() & {
        return std::get<T>(data_);
    }

    T&& value() && {
        return std::get<T>(std::move(data_));
    }

    const NativeError& error() const& {
        return std::get<NativeError>(data_);
    }

    NativeError&& error() && {
        return std::get<NativeError>(std::move(data_));
    }

private:
    explicit Result(T val) : data_(std::move(val)) {}
    explicit Result(NativeError error) : data_(std::move(error)) {}

    std::variant<T, NativeError> data_;
};

template <>
class Result<void> {
public:
    static Result ok() {
        return Result(std::nullopt);
    }

    static Result err(NativeError error) {
        return Result(std::move(error));
    }

    bool is_ok() const noexcept {
        return !error_.has_value();
    }

    bool is_err() const noexcept {
        return error_.has_value();
    }

    const NativeError& error() const& {
        return *error_;
    }

private:
    explicit Result(std::optional<NativeError> error) : error_(std::move(error)) {}
    std::optional<NativeError> error_;
};

enum class Mode : uint8_t {
    Chat = 0,
    Browser = 1,
    Ide = 2,
};

Mode default_mode() noexcept;
std::optional<Mode> mode_from_command(uint16_t id) noexcept;
std::string_view mode_description(Mode mode) noexcept;

struct SessionForm {
    std::string title;
    std::string model;
    std::optional<size_t> effort_index;

    bool operator==(const SessionForm&) const = default;

    bool changed_from(const std::optional<SessionForm>& baseline) const {
        return baseline.has_value() && (*this != *baseline);
    }
};

// ---------------------------------------------------------------------------
// RFC-8259 JSON Value
// ---------------------------------------------------------------------------

struct JsonValue {
    using Array = std::vector<JsonValue>;
    using Object = std::map<std::string, JsonValue, std::less<>>;

    std::variant<std::nullptr_t, bool, int64_t, double, std::string, Array, Object> storage{nullptr};

    JsonValue() = default;
    JsonValue(std::nullptr_t) : storage(nullptr) {}
    JsonValue(bool b) : storage(b) {}
    JsonValue(int64_t i) : storage(i) {}
    JsonValue(int i) : storage(static_cast<int64_t>(i)) {}
    JsonValue(uint64_t u) : storage(static_cast<int64_t>(u)) {}
    JsonValue(double d) : storage(d) {}
    JsonValue(std::string s) : storage(std::move(s)) {}
    JsonValue(std::string_view sv) : storage(std::string(sv)) {}
    JsonValue(const char* s) : storage(std::string(s)) {}
    JsonValue(Array a) : storage(std::move(a)) {}
    JsonValue(Object o) : storage(std::move(o)) {}

    bool operator==(const JsonValue&) const = default;

    bool is_null() const noexcept { return std::holds_alternative<std::nullptr_t>(storage); }
    bool is_bool() const noexcept { return std::holds_alternative<bool>(storage); }
    bool is_int() const noexcept { return std::holds_alternative<int64_t>(storage); }
    bool is_double() const noexcept { return std::holds_alternative<double>(storage); }
    bool is_number() const noexcept { return is_int() || is_double(); }
    bool is_string() const noexcept { return std::holds_alternative<std::string>(storage); }
    bool is_array() const noexcept { return std::holds_alternative<Array>(storage); }
    bool is_object() const noexcept { return std::holds_alternative<Object>(storage); }

    bool as_bool(bool fallback = false) const noexcept {
        return is_bool() ? std::get<bool>(storage) : fallback;
    }

    int64_t as_int64(int64_t fallback = 0) const noexcept {
        if (is_int()) return std::get<int64_t>(storage);
        if (is_double()) return static_cast<int64_t>(std::get<double>(storage));
        return fallback;
    }

    uint64_t as_uint64(uint64_t fallback = 0) const noexcept {
        if (is_int()) {
            const auto v = std::get<int64_t>(storage);
            return v >= 0 ? static_cast<uint64_t>(v) : fallback;
        }
        return fallback;
    }

    std::string_view as_string_view(std::string_view fallback = {}) const noexcept {
        return is_string() ? std::string_view(std::get<std::string>(storage)) : fallback;
    }

    std::string as_string(std::string fallback = {}) const {
        return is_string() ? std::get<std::string>(storage) : std::move(fallback);
    }

    const Array* as_array_ptr() const noexcept {
        return std::get_if<Array>(&storage);
    }

    const Object* as_object_ptr() const noexcept {
        return std::get_if<Object>(&storage);
    }

    const JsonValue* find(std::string_view key) const noexcept {
        const auto* obj = as_object_ptr();
        if (!obj) return nullptr;
        const auto it = obj->find(key);
        return it == obj->end() ? nullptr : &it->second;
    }

    std::string dump() const;
    static Result<JsonValue> parse(std::string_view input);
};

// ---------------------------------------------------------------------------
// Canonical Session & Navigation Domain Types
// ---------------------------------------------------------------------------

enum class SessionScope : uint8_t {
    Projectless = 0,
    Project = 1,
};

enum class PermissionMode : uint8_t {
    AskAll = 0,
    AutoEdit = 1,
    AutoAll = 2,
};

struct AgentSessionSummary {
    std::string id;
    std::string title;
    SessionScope scope{SessionScope::Project};
    std::string cwd;
    std::string profile_id;
    std::string model;
    PermissionMode permission_mode{PermissionMode::AskAll};
    std::vector<JsonValue> rules;
    std::optional<std::string> reasoning_effort;
    std::vector<std::string> fallback_models;
    std::optional<uint64_t> token_budget;
    uint64_t tokens_used{0};
    std::optional<JsonValue> system_prompt;
    std::optional<std::string> parent_id;
    uint64_t settings_revision{1};
    size_t message_count{0};
    int64_t created_at_ms{0};
    int64_t updated_at_ms{0};

    bool operator==(const AgentSessionSummary&) const = default;

    JsonValue to_json_value() const;
    std::string to_json() const;
    static Result<AgentSessionSummary> from_json(std::string_view raw);
};

struct AgentSessionPageCursor {
    int64_t updated_at_ms{0};
    std::string id;

    bool operator==(const AgentSessionPageCursor&) const = default;
};

struct AgentSessionPageRequest {
    uint32_t limit{50};
    std::optional<AgentSessionPageCursor> cursor;
};

struct AgentSessionNavigationSnapshot {
    uint32_t schema_version{1};
    int64_t revision{0};
    std::vector<std::string> open_ids;
    std::optional<std::string> active_id;
    int64_t updated_at_ms{0};

    bool operator==(const AgentSessionNavigationSnapshot&) const = default;

    std::string to_json() const;
    static Result<AgentSessionNavigationSnapshot> from_json(std::string_view raw);
};

struct SaveAgentSessionNavigationRequest {
    int64_t expected_revision{0};
    std::vector<std::string> open_ids;
    std::optional<std::string> active_id;

    static Result<SaveAgentSessionNavigationRequest> from_json_strict(const JsonValue& val);
};

struct AgentSessionNavigationLoad {
    AgentSessionNavigationSnapshot snapshot;
    std::string receipt_id;
};

struct AgentSessionNavigationSave {
    enum class Status : uint8_t {
        Saved = 0,
        Conflict = 1,
    };
    Status status{Status::Saved};
    AgentSessionNavigationSnapshot snapshot;
    std::string receipt_id;

    bool is_saved() const noexcept { return status == Status::Saved; }
    bool is_conflict() const noexcept { return status == Status::Conflict; }
};

struct AgentSessionPage {
    std::vector<AgentSessionSummary> rows;
    std::optional<AgentSessionSummary> active;
    AgentSessionNavigationLoad navigation;
    std::optional<AgentSessionPageCursor> next_cursor;
};

// ---------------------------------------------------------------------------
// Encoding, Crypto & UTF-8 Utilities
// ---------------------------------------------------------------------------

std::string sha256_hex(std::span<const uint8_t> bytes);
std::string sha256_hex(std::string_view text);
std::string base64_encode(std::span<const uint8_t> bytes);
std::string hex_encode(std::span<const uint8_t> bytes);
std::string hex_encode(std::string_view text);
Result<std::vector<uint8_t>> hex_decode(std::string_view hex);
Result<std::string> decode_hex_utf8(std::string_view hex);

std::string uuid_v4();
std::string uuid_v4_simple();
Result<int64_t> now_epoch_ms();

std::wstring utf8_to_wide(std::string_view utf8);
std::string wide_to_utf8(std::wstring_view wide);
bool is_valid_utf8(std::string_view s) noexcept;
bool utf8_has_control_chars(std::string_view s) noexcept;
std::string_view trim_ascii(std::string_view s) noexcept;
std::string to_lower_utf8(std::string_view s);
size_t utf8_char_count(std::string_view s) noexcept;
std::pair<std::string, std::string> utf8_split_at_char(std::string_view s, size_t char_index);
std::string utf8_take_chars(std::string_view s, size_t max_chars);

} // namespace omnia::native
