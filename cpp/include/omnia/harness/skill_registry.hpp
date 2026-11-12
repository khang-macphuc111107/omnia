#pragma once

#include <cstddef>
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

namespace omnia::harness {

struct SkillEntry {
    std::string name;
    std::string description;
    std::string relative_path;
    std::string category;
};

struct RankedSkill {
    SkillEntry skill;
    double score = 0.0;
};

class SkillRegistry {
public:
    static constexpr std::size_t kMaxSkillsPerRoot = 1024;
    static constexpr std::size_t kMaxDescriptionCodepoints = 1024;
    static constexpr std::uintmax_t kMaxSkillFileBytes = 256 * 1024;

    SkillRegistry() = default;

    /// Scans `<skills_root>/*/SKILL.md` with canonical symlink containment checks,
    /// enforcing a 1024-skill cap and 1024-codepoint UTF-8 safe description truncation.
    std::size_t load_from_directory(
        const std::filesystem::path& skills_root,
        std::string_view display_prefix = ".agents/skills"
    );

    void register_skill(SkillEntry entry);

    std::size_t size() const noexcept { return skills_.size(); }
    const std::vector<SkillEntry>& all() const noexcept { return skills_; }

    /// BM25 + keyword/prefix search over loaded skills. Empty query returns all skills sorted by name.
    std::vector<RankedSkill> search(std::string_view query, std::size_t limit = 64) const;

    static std::pair<std::string, std::string> split_yaml_frontmatter(std::string_view content);
    static std::string parse_frontmatter_field(std::string_view frontmatter, std::string_view key);

private:
    std::vector<SkillEntry> skills_;
};

} // namespace omnia::harness
