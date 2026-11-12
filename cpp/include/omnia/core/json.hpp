#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace omnia::core {

class JsonParseError : public std::runtime_error {
public:
    JsonParseError(std::string message, std::size_t offset)
        : std::runtime_error(std::move(message)), offset_(offset) {}

    std::size_t offset() const noexcept { return offset_; }

private:
    std::size_t offset_ = 0;
};

class JsonValue;
using JsonArray = std::vector<JsonValue>;
using JsonObject = std::map<std::string, JsonValue, std::less<>>;

class JsonValue {
public:
    using Storage = std::variant<
        std::nullptr_t,
        bool,
        std::int64_t,
        double,
        std::string,
        JsonArray,
        JsonObject
    >;

    JsonValue() noexcept : storage_(nullptr) {}
    JsonValue(std::nullptr_t) noexcept : storage_(nullptr) {}
    JsonValue(bool v) noexcept : storage_(v) {}
    JsonValue(int v) noexcept : storage_(static_cast<std::int64_t>(v)) {}
    JsonValue(long v) noexcept : storage_(static_cast<std::int64_t>(v)) {}
    JsonValue(std::int64_t v) noexcept : storage_(v) {}
    JsonValue(std::uint32_t v) noexcept : storage_(static_cast<std::int64_t>(v)) {}
    JsonValue(std::uint64_t v) noexcept {
        if (v <= static_cast<std::uint64_t>(INT64_MAX)) {
            storage_ = static_cast<std::int64_t>(v);
        } else {
            storage_ = static_cast<double>(v);
        }
    }
    JsonValue(double v) noexcept : storage_(v) {}
    JsonValue(const char* v) : storage_(std::string(v != nullptr ? v : "")) {}
    JsonValue(std::string v) noexcept : storage_(std::move(v)) {}
    JsonValue(std::string_view v) : storage_(std::string(v)) {}
    JsonValue(JsonArray v) noexcept : storage_(std::move(v)) {}
    JsonValue(JsonObject v) noexcept : storage_(std::move(v)) {}

    static JsonValue array() { return JsonValue(JsonArray{}); }
    static JsonValue object() { return JsonValue(JsonObject{}); }

    bool is_null() const noexcept { return std::holds_alternative<std::nullptr_t>(storage_); }
    bool is_bool() const noexcept { return std::holds_alternative<bool>(storage_); }
    bool is_int() const noexcept { return std::holds_alternative<std::int64_t>(storage_); }
    bool is_double() const noexcept { return std::holds_alternative<double>(storage_); }
    bool is_number() const noexcept { return is_int() || is_double(); }
    bool is_string() const noexcept { return std::holds_alternative<std::string>(storage_); }
    bool is_array() const noexcept { return std::holds_alternative<JsonArray>(storage_); }
    bool is_object() const noexcept { return std::holds_alternative<JsonObject>(storage_); }

    bool as_bool(bool fallback = false) const noexcept {
        if (const auto* p = std::get_if<bool>(&storage_)) {
            return *p;
        }
        return fallback;
    }

    std::int64_t as_int64(std::int64_t fallback = 0) const noexcept {
        if (const auto* p = std::get_if<std::int64_t>(&storage_)) {
            return *p;
        }
        if (const auto* d = std::get_if<double>(&storage_)) {
            return static_cast<std::int64_t>(*d);
        }
        return fallback;
    }

    double as_double(double fallback = 0.0) const noexcept {
        if (const auto* d = std::get_if<double>(&storage_)) {
            return *d;
        }
        if (const auto* i = std::get_if<std::int64_t>(&storage_)) {
            return static_cast<double>(*i);
        }
        return fallback;
    }

    const std::string& as_string() const {
        return std::get<std::string>(storage_);
    }

    std::string as_string_or(std::string_view fallback = "") const {
        if (const auto* s = std::get_if<std::string>(&storage_)) {
            return *s;
        }
        return std::string(fallback);
    }

    const JsonArray& as_array() const { return std::get<JsonArray>(storage_); }
    JsonArray& as_array() { return std::get<JsonArray>(storage_); }

    const JsonObject& as_object() const { return std::get<JsonObject>(storage_); }
    JsonObject& as_object() { return std::get<JsonObject>(storage_); }

    bool contains(std::string_view key) const noexcept {
        if (const auto* obj = std::get_if<JsonObject>(&storage_)) {
            return obj->find(key) != obj->end();
        }
        return false;
    }

    const JsonValue* find(std::string_view key) const noexcept {
        if (const auto* obj = std::get_if<JsonObject>(&storage_)) {
            const auto it = obj->find(key);
            if (it != obj->end()) {
                return &it->second;
            }
        }
        return nullptr;
    }

    std::string prop_string(std::string_view key, std::string_view fallback = "") const {
        if (const auto* v = find(key)) {
            return v->as_string_or(fallback);
        }
        return std::string(fallback);
    }

    std::int64_t prop_int64(std::string_view key, std::int64_t fallback = 0) const noexcept {
        if (const auto* v = find(key)) {
            return v->as_int64(fallback);
        }
        return fallback;
    }

    bool prop_bool(std::string_view key, bool fallback = false) const noexcept {
        if (const auto* v = find(key)) {
            return v->as_bool(fallback);
        }
        return fallback;
    }

    JsonValue& operator[](const std::string& key) {
        if (!is_object()) {
            storage_ = JsonObject{};
        }
        return std::get<JsonObject>(storage_)[key];
    }

    bool operator==(const JsonValue& other) const = default;

    static JsonValue parse(std::string_view input);
    static std::optional<JsonValue> try_parse(std::string_view input) noexcept;

    std::string dump(int indent = -1) const;

private:
    Storage storage_;
};

} // namespace omnia::core
