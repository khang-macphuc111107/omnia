#include "omnia/core/sha256.hpp"

#include <stdexcept>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <bcrypt.h>
#endif

namespace omnia::core {

namespace {

#ifdef _WIN32
struct AlgCloser {
    BCRYPT_ALG_HANDLE handle = nullptr;
    ~AlgCloser() noexcept {
        if (handle != nullptr) {
            BCryptCloseAlgorithmProvider(handle, 0);
        }
    }
};

struct HashCloser {
    BCRYPT_HASH_HANDLE handle = nullptr;
    ~HashCloser() noexcept {
        if (handle != nullptr) {
            BCryptDestroyHash(handle);
        }
    }
};
#endif

} // namespace

std::array<std::uint8_t, 32> sha256_bytes(std::span<const std::uint8_t> data) {
#ifdef _WIN32
    AlgCloser alg{};
    NTSTATUS status = BCryptOpenAlgorithmProvider(
        &alg.handle,
        BCRYPT_SHA256_ALGORITHM,
        nullptr,
        0
    );
    if (status < 0) {
        throw std::runtime_error("BCryptOpenAlgorithmProvider(SHA256) failed");
    }

    DWORD obj_len = 0;
    DWORD cb_result = 0;
    status = BCryptGetProperty(
        alg.handle,
        BCRYPT_OBJECT_LENGTH,
        reinterpret_cast<PUCHAR>(&obj_len),
        sizeof(obj_len),
        &cb_result,
        0
    );
    if (status < 0 || obj_len == 0) {
        throw std::runtime_error("BCryptGetProperty(BCRYPT_OBJECT_LENGTH) failed");
    }

    std::vector<std::uint8_t> hash_object(obj_len, 0);
    HashCloser hash{};
    status = BCryptCreateHash(
        alg.handle,
        &hash.handle,
        hash_object.data(),
        obj_len,
        nullptr,
        0,
        0
    );
    if (status < 0) {
        throw std::runtime_error("BCryptCreateHash failed");
    }

    std::uint8_t dummy = 0;
    std::size_t remaining = data.size();
    const std::uint8_t* ptr = data.empty() ? &dummy : data.data();
    while (remaining > 0) {
        const ULONG chunk = remaining > 0x40000000ULL
            ? 0x40000000UL
            : static_cast<ULONG>(remaining);
        status = BCryptHashData(
            hash.handle,
            const_cast<PUCHAR>(ptr),
            chunk,
            0
        );
        if (status < 0) {
            throw std::runtime_error("BCryptHashData failed");
        }
        ptr += chunk;
        remaining -= chunk;
    }

    std::array<std::uint8_t, 32> digest{};
    status = BCryptFinishHash(
        hash.handle,
        digest.data(),
        static_cast<ULONG>(digest.size()),
        0
    );
    if (status < 0) {
        throw std::runtime_error("BCryptFinishHash failed");
    }
    return digest;
#else
#error "Windows CNG BCrypt is required on this target"
#endif
}

std::array<std::uint8_t, 32> sha256_bytes(std::string_view text) {
    const auto* raw = reinterpret_cast<const std::uint8_t*>(text.data());
    return sha256_bytes(std::span<const std::uint8_t>(raw, text.size()));
}

std::string sha256_hex(std::span<const std::uint8_t> data) {
    static constexpr char kHex[] = "0123456789abcdef";
    const auto digest = sha256_bytes(data);
    std::string out;
    out.reserve(64);
    for (const std::uint8_t b : digest) {
        out.push_back(kHex[(b >> 4U) & 0x0FU]);
        out.push_back(kHex[b & 0x0FU]);
    }
    return out;
}

std::string sha256_hex(std::string_view text) {
    const auto* raw = reinterpret_cast<const std::uint8_t*>(text.data());
    return sha256_hex(std::span<const std::uint8_t>(raw, text.size()));
}

} // namespace omnia::core
