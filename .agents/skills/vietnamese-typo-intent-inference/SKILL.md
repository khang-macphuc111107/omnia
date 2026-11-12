---
name: vietnamese-typo-intent-inference
description: Infer user intent across bilingual Vietnamese-English prompts containing VNI digit-tone slips, Telex modifier artifacts, physical QWERTY key-adjacency typos, or Vietnamese developer chat shorthand without silently mutating code, paths, identifiers, or high-risk commands.
metadata:
  short-description: Infer Vietnamese-English VNI, Telex, QWERTY, and dev-shorthand typos
---

# Vietnamese Typo & Intent Inference

Decode fast, unedited bilingual Vietnamese-English prompts by combining VNI and Telex input-method mechanics, physical QWERTY finger geometry, syntactic context, and developer chat shorthand. Apply this skill to understand user intent accurately without lecturing the user on spelling and without silently altering verbatim technical identifiers.

## Core Inference Workflow

1. **Preserve verbatim literals first**: Keep file paths, URLs, repository slugs, git refs, CLI flags, model IDs, usernames, credentials, and code identifiers untouched unless the user explicitly asks to fix a typo in them or an obvious Vietnamese IME mutation corrupted a known ASCII command/term in prose (for example, `tẻminal` for `terminal`).
2. **Infer IME + hand state across the clause**: Corroborate whether the user is typing in VNI, Telex, raw ASCII Vietnamese, or English-mode IME across neighboring words rather than guessing from a single character.
3. **Resolve low-risk prose silently**: When only one plausible reading fits grammar and task context, act on it directly instead of interrupting.
4. **Gate high-risk ambiguity**: If two plausible readings point to different files, branches, accounts, or destructive operations, stop before mutating state and ask a brief clarification naming the candidate interpretations.

## 1. VNI Number-Tone & Modifier Slip Mechanics

Standard VNI maps top-row digits to diacritics:
- **Tones**: `1` = sắc (`´`), `2` = huyền (`` ` ``), `3` = hỏi (`ả`), `4` = ngã (`ã`), `5` = nặng (`.`), `0` = strip diacritic.
- **Vowel/consonant shapes**: `6` = circumflex (`â`, `ê`, `ô`), `7` = horn (`ơ`, `ư`), `8` = breve (`ă`), `9` = crossbar (`đ`).

Common VNI failure patterns in rapid typing:
- **Top-row vertical finger slip (`buỏi8` to `buổi`)**: On QWERTY, `8` sits directly above `i` while `6` sits above `y`. After typing `buo` + `3` (`buỏ`) + `i` (`buỏi`), reaching up from `i` to add circumflex `6` (`ô`) often hits `8` (`ă`). Because `o` and `i` cannot take a breve, the VNI engine leaves `8` as a literal digit (`buỏi8` = `buổi`).
- **Dropped vowel before modifier (`ti6p1` to `tiếp`)**: Intended keystrokes `t-i-e-6-p-1`. When `e` drops during fast rollover, `i` rejects circumflex `6`, breaking composition so `6` and `1` emit literally (`ti6p1` = `tiếp`; similarly `n5oo` = `nọ` when `5` lands mid-rollover).
- **Deferred modifier burst + dropped nasal (`dog961` to `đống`)**: VNI allows word-final modifier clusters (`d-o-n-g-9-6-1` -> `9`=`đ`, `6`=`ô`, `1`=sắc -> `đống`). Dropping `n` in rapid `o-n-g` rollover or typing while the OS IME momentarily drops to English leaves raw digits attached (`dog961` = `đống`).

## 2. Telex Double-Key & Mode-Collision Mechanics

Standard Telex maps ASCII letters to diacritics:
- **Tones**: `s` = sắc, `f` = huyền, `r` = hỏi, `x` = ngã, `j` = nặng, `z` = strip tone.
- **Shapes**: `aa` = `â`, `aw` = `ă`, `ee` = `ê`, `oo` = `ô`, `ow` or bare `w` = `ơ`/`ư`, `dd` = `đ` (doubled modifier keys escape back to literal ASCII).

Two opposite Telex failure modes occur constantly in bilingual dev chat:
- **English-mode Telex leakage**: Typing Telex while the OS IME is in English leaves trailing/doubled modifier letters (`lamf tieeps` = `làm tiếp`, `ddoongs` = `đống`, `hieeur` = `hiểu`, `chuwaco` = `chưa có`, `xuar lys` = `xử lý`).
- **Active Telex corrupting English technical terms**: Typing English words while Telex IME stays enabled converts `w` into `ư` and `s/f/r/x/j` after vowels into Vietnamese tones:
  - `ưorktree` / `ưindows` -> `worktree` / `windows`
  - `tẻminal` -> `terminal`, `sẻver` -> `server`, `mẻge` -> `merge`
  - `fỉle` -> `file`, `bủild` -> `build`, `pổt` -> `port`, `cỏde` -> `code`, `tét` -> `test`, `dỉty` -> `dirty`

## 3. Physical QWERTY Adjacency & Rollover Geometry

Use standard ANSI QWERTY spatial proximity to decode non-IME typos:
- **Vertical column neighbors**: `1-q-a-z`, `2-w-s-x`, `3-e-d-c`, `4-r-f-v`, `5-t-g-b`, `6-y-h-n`, `7-u-j-m`, `8-i-k`, `9-o-l`, `0-p`.
- **Horizontal row neighbors**: `r-t-y`, `u-i-o-p`, `d-f-g`, `j-k-l`, `c-v-b-n-m`.
- **Fast-rollover artifacts**:
  - **Transposition + neighbor hit**: `ptompy` -> `prompt` (`r/o/m/p/t` rollover + `y` next to `t`), `herdr` -> `herd`/`header`.
  - **Missing space boundary**: `tôikhi` -> `tôi khi`, `cđặt` -> `cài đặt`.
  - **Dropped lead/medial letter or doubled tail**: `ự thêm` -> `tự thêm`, `lop tiếp` -> `loop tiếp`, `videoo` -> `video`, `wrting` -> `writing`.

## 4. Bilingual Code-Switching & Homograph Disambiguation

Vietnamese technical requests embed English nouns, verbs, and flags inside Vietnamese syntax (`"bạn xem lại repo r merge xog chạy test lun nhé"`). Disambiguate short tokens by grammatical slot:

| Token | Vietnamese chat meaning | Technical / English meaning | Disambiguation cue |
| :--- | :--- | :--- | :--- |
| `r` | `rồi` (already / then) | R language, `-r` flag | Clause-final or before next verb (`vừa r`, `xong r làm tiếp`) vs CLI/lang context |
| `th` | `thì` (then) or `thôi` (only/just) | ordinal `-th`, HTML `<th>` | Conditional link (`cần th gọi`) or sentence-final particle (`chỉ v th`) |
| `ms` | `mới` (only then / just) | milliseconds (`500ms`) | Precedes verb (`phải focus ms xài dc`, `ms tạo`) vs attached/adjacent to a number |
| `vs` | `với` / `và` (with / and) | *versus* (comparison) | Joins co-actions or interaction target (`dọn vs tái cấu trúc`, `interactive vs process`) vs explicit contrast (`native vs tauri`) |
| `dc` | `được` (can / able / ok) | datacenter, `dc` tool | Modal post-verb or pre-verb (`làm dc ko`, `thêm gì dc`) |

## 5. Vietnamese Developer Chat-Shorthand Reference

| Shorthand | Full Vietnamese | Meaning / Usage Note |
| :--- | :--- | :--- |
| `ko` (also `k`, `kh`, `hong`) | `không` | no / not (`hiểu ko`, `ko conflict`) |
| `dc` / `đc` | `được` | can / able / passive marker (`xài dc`, `dc build`) |
| `cx` | `cũng` | also / too (`cái gì cx làm`, `ảnh cx v`) |
| `ms` | `mới` | just / newly / only then (`focus ms xài dc`) |
| `nhx` (also `nhg`, `nhma`) | `nhưng` (`nhưng mà`) | but / however (`mở ra nhx ko lên trên cùng`) |
| `trg` | `trong` | in / inside / among (`ở trg các prompt`) |
| `htai` | `hiện tại` | currently / existing (`mấy cái use htai`) |
| `dko` (also `đko`, `pk`) | `đúng không` (`phải không`) | right? / isn't it? (`hiểu ý tôi r dko`) |
| `vde` | `vấn đề` | issue / problem / topic |
| `nckh` | `nghiên cứu khoa học` | scientific / academic research |
| `bth` (also `bt`) | `bình thường` (`bt` also `biết`) | normal / as usual (`chạy bth`) |
| `vs` | `với` (often used as `và`) | with / to / and (`kết hợp vs`, `dọn vs cấu trúc`) |
| `r` | `rồi` | already / done / and then (`có hết r`, `xem xong r làm`) |
| `th` | `thì` / `thôi` | then / just (`chỉ v th`) |
| `lun` | `luôn` | right away / all the way / too (`thêm lun đi nhé`) |
| `nx` | `nữa` | more / again / additionally (`thêm cái này nx`) |
| `ch` / `chs` | `chưa` (`chưa sao` / `chả hiểu sao`) | not yet (`cái nào ch có skill`); `chs` in slang = `chả hiểu sao` |
| `v` / `z` | `vậy` | so / like that (`chỉ v thôi`) |
| `ntn` | `như thế nào` | how / in what structure (`cần file ntn`) |
| `xog` | `xong` | finished / after completing (`tải về xog merge`) |
| `trc` / `bh` / `ng` / `sd` | `trước` / `bây giờ` / `người` / `sử dụng` | before / now (or when) / person / use |

## Relationship to Neighboring Skills

- Use this skill directly for linguistic/keyboard decoding of Vietnamese-English user prompts.
- Pair with `deep-typo-input-normalization` when an explicit side-by-side normalization audit table is requested for ambiguous or high-risk inputs.
- Route prose polishing to `humanizer` and full document translation to `deep-translation`.
