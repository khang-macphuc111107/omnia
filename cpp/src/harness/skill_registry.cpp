#include "omnia/harness/skill_registry.hpp"
#include "omnia/core/utf8.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <fstream>
#include <map>
#include <set>
#include <unordered_map>

namespace omnia::harness {

namespace {

std::string trim_ascii(std::string_view sv) {
    while (!sv.empty() && (sv.front() == ' ' || sv.front() == '\t' || sv.front() == '\r' || sv.front() == '\n')) {
        sv.remove_prefix(1);
    }
    while (!sv.empty() && (sv.back() == ' ' || sv.back() == '\t' || sv.back() == '\r' || sv.back() == '\n')) {
        sv.remove_suffix(1);
    }
    return std::string(sv);
}

std::string unquote_scalar(std::string_view sv) {
    const std::string t = trim_ascii(sv);
    if (t.size() >= 2 && ((t.front() == '"' && t.back() == '"') ||
                          (t.front() == '\'' && t.back() == '\''))) {
        return t.substr(1, t.size() - 2);
    }
    return t;
}

std::string to_lower_ascii(std::string_view sv) {
    std::string out(sv);
    for (char& c : out) {
        const auto uc = static_cast<unsigned char>(c);
        if (uc < 0x80U) {
            c = static_cast<char>(std::tolower(uc));
        }
    }
    return out;
}

bool is_path_contained(
    const std::filesystem::path& canonical_root,
    const std::filesystem::path& candidate_canonical
) {
    auto r_it = canonical_root.begin();
    auto c_it = candidate_canonical.begin();
    for (; r_it != canonical_root.end(); ++r_it, ++c_it) {
        if (c_it == candidate_canonical.end()) {
            return false;
        }
        const std::string a = to_lower_ascii(r_it->generic_string());
        const std::string b = to_lower_ascii(c_it->generic_string());
        if (a != b) {
            return false;
        }
    }
    return true;
}

bool valid_skill_name(std::string_view name) noexcept {
    if (name.empty() || core::utf8_codepoint_count(name) > 128) {
        return false;
    }
    for (const char ch : name) {
        if (static_cast<unsigned char>(ch) < 0x20U) {
            return false;
        }
    }
    return true;
}

std::string infer_skill_category(std::string_view name, std::string_view desc) {
    const std::string low = to_lower_ascii(std::string(name) + " " + std::string(desc));
    if (low.find("cpp") != std::string::npos || low.find("c++") != std::string::npos ||
        low.find("win32") != std::string::npos || low.find("cmake") != std::string::npos) {
        return "native-cpp20";
    }
    if (low.find("graph") != std::string::npos || low.find("swarm") != std::string::npos ||
        low.find("peer") != std::string::npos || low.find("orchestrat") != std::string::npos) {
        return "graph-orchestration";
    }
    if (low.find("cors") != std::string::npos || low.find("security") != std::string::npos ||
        low.find("audit") != std::string::npos) {
        return "security-verification";
    }
    if (low.find("steer") != std::string::npos || low.find("session") != std::string::npos ||
        low.find("handoff") != std::string::npos || low.find("continuity") != std::string::npos) {
        return "continuity-governance";
    }
    if (low.find("ui") != std::string::npos || low.find("design") != std::string::npos) {
        return "studio-ui";
    }
    return "agent-engineering";
}

std::vector<std::string> tokenize_bm25(std::string_view text) {
    std::vector<std::string> out;
    std::string cur;
    const std::string low = to_lower_ascii(text);
    for (const char ch : low) {
        const auto uc = static_cast<unsigned char>(ch);
        if (uc >= 0x80U || std::isalnum(uc) != 0 || ch == '-') {
            cur.push_back(ch);
        } else {
            if (!cur.empty()) {
                out.push_back(cur);
                // Also split hyphenated words so "peer-mesh" indexes "peer" and "mesh"
                if (cur.find('-') != std::string::npos) {
                    std::size_t s = 0;
                    while (s < cur.size()) {
                        const std::size_t h = cur.find('-', s);
                        const std::string part = (h == std::string::npos)
                            ? cur.substr(s)
                            : cur.substr(s, h - s);
                        if (part.size() >= 2) {
                            out.push_back(part);
                        }
                        if (h == std::string::npos) break;
                        s = h + 1;
                    }
                }
                cur.clear();
            }
        }
    }
    if (!cur.empty()) {
        out.push_back(cur);
        if (cur.find('-') != std::string::npos) {
            std::size_t s = 0;
            while (s < cur.size()) {
                const std::size_t h = cur.find('-', s);
                const std::string part = (h == std::string::npos)
                    ? cur.substr(s)
                    : cur.substr(s, h - s);
                if (part.size() >= 2) {
                    out.push_back(part);
                }
                if (h == std::string::npos) break;
                s = h + 1;
            }
        }
    }
    return out;
}

} // namespace

std::pair<std::string, std::string> SkillRegistry::split_yaml_frontmatter(
    std::string_view content
) {
    // Strip UTF-8 BOM if present
    if (content.size() >= 3 &&
        static_cast<unsigned char>(content[0]) == 0xEFU &&
        static_cast<unsigned char>(content[1]) == 0xBBU &&
        static_cast<unsigned char>(content[2]) == 0xBFU) {
        content.remove_prefix(3);
    }

    const std::size_t first_nl = content.find('\n');
    if (first_nl == std::string_view::npos) {
        return {"", std::string(content)};
    }
    const std::string first_line = trim_ascii(content.substr(0, first_nl));
    if (first_line != "---") {
        return {"", std::string(content)};
    }

    std::size_t pos = first_nl + 1;
    std::string front;
    while (pos <= content.size()) {
        const std::size_t nl = content.find('\n', pos);
        const std::string_view line = (nl == std::string_view::npos)
            ? content.substr(pos)
            : content.substr(pos, nl - pos);
        if (trim_ascii(line) == "---") {
            const std::size_t body_start = (nl == std::string_view::npos)
                ? content.size()
                : (nl + 1);
            return {front, std::string(content.substr(body_start))};
        }
        front.append(line.data(), line.size());
        if (!front.empty() && front.back() == '\r') {
            front.pop_back();
        }
        front.push_back('\n');
        if (nl == std::string_view::npos) {
            break;
        }
        pos = nl + 1;
    }
    return {"", std::string(content)};
}

std::string SkillRegistry::parse_frontmatter_field(
    std::string_view frontmatter,
    std::string_view key
) {
    std::vector<std::string_view> lines;
    std::size_t pos = 0;
    while (pos < frontmatter.size()) {
        const std::size_t nl = frontmatter.find('\n', pos);
        if (nl == std::string_view::npos) {
            lines.push_back(frontmatter.substr(pos));
            break;
        }
        lines.push_back(frontmatter.substr(pos, nl - pos));
        pos = nl + 1;
    }

    const std::string prefix = std::string(key) + ":";
    for (std::size_t i = 0; i < lines.size(); ++i) {
        const std::string_view line = lines[i];
        if (line.substr(0, prefix.size()) != prefix) {
            continue;
        }
        const std::string rest = trim_ascii(line.substr(prefix.size()));
        std::vector<std::string> cont;
        for (std::size_t j = i + 1; j < lines.size(); ++j) {
            const std::string_view next = lines[j];
            if (trim_ascii(next).empty()) {
                cont.emplace_back("");
            } else if (!next.empty() && (next.front() == ' ' || next.front() == '\t')) {
                cont.push_back(trim_ascii(next));
            } else {
                break;
            }
        }
        while (!cont.empty() && cont.back().empty()) {
            cont.pop_back();
        }

        if (!rest.empty() && (rest.front() == '>' || rest.front() == '|')) {
            const char joiner = (rest.front() == '>') ? ' ' : '\n';
            std::string joined;
            for (std::size_t k = 0; k < cont.size(); ++k) {
                if (k > 0) joined.push_back(joiner);
                joined.append(cont[k]);
            }
            return trim_ascii(joined);
        }

        std::string val = unquote_scalar(rest);
        for (const auto& c : cont) {
            if (!c.empty()) {
                if (!val.empty()) val.push_back(' ');
                val.append(c);
            }
        }
        return val;
    }
    return {};
}

std::size_t SkillRegistry::load_from_directory(
    const std::filesystem::path& skills_root,
    std::string_view display_prefix
) {
    skills_.clear();
    std::error_code ec;
    if (!std::filesystem::exists(skills_root, ec) ||
        !std::filesystem::is_directory(skills_root, ec)) {
        return 0;
    }

    const std::filesystem::path canonical_root = std::filesystem::canonical(skills_root, ec);
    if (ec || canonical_root.empty()) {
        return 0;
    }

    std::vector<std::filesystem::path> candidate_dirs;
    std::size_t scanned_entries = 0;
    for (const auto& dir_entry : std::filesystem::directory_iterator(skills_root, ec)) {
        if (ec) break;
        ++scanned_entries;
        if (scanned_entries > 4096) {
            break;
        }
        candidate_dirs.push_back(dir_entry.path());
    }

    std::sort(
        candidate_dirs.begin(),
        candidate_dirs.end(),
        [](const std::filesystem::path& a, const std::filesystem::path& b) {
            return a.filename().generic_string() < b.filename().generic_string();
        }
    );

    std::set<std::string> seen_names;
    for (const auto& sub_dir : candidate_dirs) {
        if (skills_.size() >= kMaxSkillsPerRoot) {
            break;
        }
        std::error_code sub_ec;
        const auto canon_dir = std::filesystem::canonical(sub_dir, sub_ec);
        if (sub_ec || !std::filesystem::is_directory(canon_dir, sub_ec)) {
            continue;
        }
        // Symlink / junction escape guard: resolved directory must stay strictly inside canonical_root
        if (!is_path_contained(canonical_root, canon_dir) || canon_dir == canonical_root) {
            continue;
        }

        const std::filesystem::path skill_md_raw = sub_dir / "SKILL.md";
        if (!std::filesystem::exists(skill_md_raw, sub_ec)) {
            continue;
        }
        const auto canon_md = std::filesystem::canonical(skill_md_raw, sub_ec);
        if (sub_ec || !std::filesystem::is_regular_file(canon_md, sub_ec)) {
            continue;
        }
        if (!is_path_contained(canon_dir, canon_md)) {
            continue;
        }

        const auto fsize = std::filesystem::file_size(canon_md, sub_ec);
        if (sub_ec || fsize > kMaxSkillFileBytes) {
            continue;
        }

        std::ifstream ifs(canon_md, std::ios::binary);
        if (!ifs) {
            continue;
        }
        std::string content(static_cast<std::size_t>(fsize), '\0');
        if (fsize > 0) {
            ifs.read(content.data(), static_cast<std::streamsize>(fsize));
        }
        if (!core::is_valid_utf8(content)) {
            continue;
        }

        const auto [front, body] = split_yaml_frontmatter(content);
        (void)body;
        const std::string folder_name = sub_dir.filename().generic_string();
        std::string name = parse_frontmatter_field(front, "name");
        if (name.empty()) {
            name = folder_name;
        }
        if (!valid_skill_name(name) || !seen_names.insert(name).second) {
            continue;
        }

        const std::string raw_desc = parse_frontmatter_field(front, "description");
        const std::string safe_desc = core::truncate_utf8_codepoints(
            raw_desc,
            kMaxDescriptionCodepoints
        );
        const std::string rel = std::string(display_prefix) + "/" + folder_name + "/SKILL.md";
        const std::string cat = infer_skill_category(name, safe_desc);

        skills_.push_back(SkillEntry{
            std::move(name),
            std::move(safe_desc),
            rel,
            cat
        });
    }

    return skills_.size();
}

void SkillRegistry::register_skill(SkillEntry entry) {
    if (skills_.size() >= kMaxSkillsPerRoot || !valid_skill_name(entry.name)) {
        return;
    }
    entry.description = core::truncate_utf8_codepoints(
        entry.description,
        kMaxDescriptionCodepoints
    );
    if (entry.category.empty()) {
        entry.category = infer_skill_category(entry.name, entry.description);
    }
    skills_.push_back(std::move(entry));
}

std::vector<RankedSkill> SkillRegistry::search(
    std::string_view query,
    std::size_t limit
) const {
    const std::size_t max_out = limit == 0 ? 1 : limit;
    const std::string trimmed = trim_ascii(query);
    if (trimmed.empty()) {
        std::vector<RankedSkill> all_ranked;
        all_ranked.reserve(std::min(skills_.size(), max_out));
        for (std::size_t i = 0; i < skills_.size() && i < max_out; ++i) {
            const double base_score = std::max(8.5, 9.8 - static_cast<double>(i) * 0.1);
            all_ranked.push_back(RankedSkill{skills_[i], std::round(base_score * 10.0) / 10.0});
        }
        return all_ranked;
    }

    auto q_tokens = tokenize_bm25(trimmed);
    const std::string q_low = to_lower_ascii(trimmed);
    // Bilingual Vietnamese <-> English synonym expansion for curated skill discovery
    if (q_low.find("vi\u1EC7t") != std::string::npos ||
        q_low.find("ti\u1EBFng") != std::string::npos ||
        q_low.find("viet") != std::string::npos) {
        q_tokens.emplace_back("vietnamese");
        q_tokens.emplace_back("bilingual");
        q_tokens.emplace_back("telex");
    }
    if (q_low.find("c++") != std::string::npos || q_low.find("cpp") != std::string::npos) {
        q_tokens.emplace_back("cpp20");
        q_tokens.emplace_back("native");
        q_tokens.emplace_back("msvc");
    }
    if (q_tokens.empty()) {
        return {};
    }

    const std::size_t n_docs = skills_.size();
    if (n_docs == 0) {
        return {};
    }

    struct DocTokens {
        std::unordered_map<std::string, std::size_t> tf;
        std::size_t len = 0;
    };
    std::vector<DocTokens> docs(n_docs);
    std::unordered_map<std::string, std::size_t> df;
    double total_len = 0.0;

    for (std::size_t i = 0; i < n_docs; ++i) {
        const std::string combined =
            skills_[i].name + " " + skills_[i].name + " " +
            skills_[i].category + " " + skills_[i].description;
        const auto toks = tokenize_bm25(combined);
        docs[i].len = toks.size();
        total_len += static_cast<double>(toks.size());
        std::set<std::string> unique_in_doc;
        for (const auto& t : toks) {
            ++docs[i].tf[t];
            unique_in_doc.insert(t);
        }
        for (const auto& ut : unique_in_doc) {
            ++df[ut];
        }
    }

    const double avg_dl = total_len > 0.0
        ? (total_len / static_cast<double>(n_docs))
        : 1.0;
    constexpr double k1 = 1.2;
    constexpr double b = 0.75;

    std::vector<RankedSkill> matches;
    for (std::size_t i = 0; i < n_docs; ++i) {
        double score = 0.0;
        for (const auto& qt : q_tokens) {
            const auto tf_it = docs[i].tf.find(qt);
            if (tf_it == docs[i].tf.end()) {
                continue;
            }
            const double f = static_cast<double>(tf_it->second);
            const double n_q = static_cast<double>(df[qt]);
            const double idf = std::log(
                1.0 + (static_cast<double>(n_docs) - n_q + 0.5) / (n_q + 0.5)
            );
            const double dl = static_cast<double>(docs[i].len);
            const double denom = f + k1 * (1.0 - b + b * (dl / avg_dl));
            score += idf * ((f * (k1 + 1.0)) / denom);
        }

        const std::string name_low = to_lower_ascii(skills_[i].name);
        const std::string desc_low = to_lower_ascii(skills_[i].description);
        if (name_low == q_low) {
            score += 8.0;
        } else if (name_low.find(q_low) != std::string::npos) {
            score += 4.0;
        } else if (desc_low.find(q_low) != std::string::npos) {
            score += 1.5;
        }

        if (score > 0.0) {
            matches.push_back(RankedSkill{skills_[i], std::round(score * 100.0) / 100.0});
        }
    }

    std::sort(
        matches.begin(),
        matches.end(),
        [](const RankedSkill& a, const RankedSkill& b) {
            if (a.score != b.score) return a.score > b.score;
            return a.skill.name < b.skill.name;
        }
    );
    if (matches.size() > max_out) {
        matches.resize(max_out);
    }
    return matches;
}

} // namespace omnia::harness
