// Omnia Studio UI — formula template helpers (pure).
//
// Templates come from GET /api/composer/templates (English titles). The UI adds Vietnamese
// titles for the known ids so Vietnamese search ("tích phân") works; unknown ids fall back to
// the server title.

import { fold } from '../../core/i18n.js';
import { TEMPLATE_CATEGORIES } from '../../api.js';

const VI_TITLES = {
  'math-fraction': 'Phân số',
  'math-sum': 'Tổng hữu hạn',
  'math-summation': 'Tổng hữu hạn',
  'math-integral': 'Tích phân suy rộng',
  'math-partial': 'Đạo hàm riêng',
  'math-nabla': 'Độ phân kỳ của trường vectơ',
  'math-matrix-2x2': 'Ma trận vuông 2×2',
  'math-limit': 'Giới hạn của dãy số',
  'phys-schrodinger': 'Phương trình Schrödinger phụ thuộc thời gian',
  'phys-maxwell-curl': 'Cảm ứng Maxwell–Faraday',
  'phys-lorentz': 'Lực Lorentz',
  'phys-einstein-energy': 'Hệ thức năng lượng–động lượng',
  'phys-boltzmann': 'Entropy Boltzmann',
  'phys-photon-energy': 'Năng lượng photon Planck–Einstein',
  'phys-braket': 'Kỳ vọng Bra-Ket của Dirac',
  'phys-maxwell-flux': 'Từ thông qua mặt kín',
  'chem-equilibrium': 'Cân bằng hoá học thuận nghịch',
  'chem-reaction-eq': 'Phản ứng thuận nghịch',
  'chem-catalytic-arrow': 'Phản ứng nhiệt có xúc tác',
  'chem-pka': 'Hằng số phân li axit (pKa)',
  'chem-gibbs': 'Năng lượng tự do Gibbs'
};

const CATEGORY_VI = { Mathematics: 'Toán', Physics: 'Vật lý', Chemistry: 'Hoá học' };

export const CATEGORY_IDS = ['all', ...TEMPLATE_CATEGORIES];

export function templateTitle(template, lang) {
  return lang === 'vi' && VI_TITLES[template.id] ? VI_TITLES[template.id] : template.title;
}

function haystack(template) {
  return fold(
    [
      template.title,
      VI_TITLES[template.id] || '',
      template.description,
      template.symbol,
      template.latex,
      template.id,
      template.category,
      CATEGORY_VI[template.category] || ''
    ].join(' ')
  );
}

/** category: 'all' or an API category; query: accent-insensitive, every word must match. */
export function filterTemplates(templates, { category = 'all', query = '' } = {}) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return templates.filter((template) => {
    if (category !== 'all' && template.category !== category) return false;
    if (!words.length) return true;
    const text = haystack(template);
    return words.every((word) => text.includes(word));
  });
}

export function categoryCounts(templates) {
  const counts = { all: templates.length };
  for (const category of TEMPLATE_CATEGORIES) counts[category] = templates.filter((t) => t.category === category).length;
  return counts;
}

/** Text inserted at the caret. */
export function insertionText(template) {
  return `$${template.latex}$`;
}

/** Next index for arrow-key movement in a grid with `columns` columns; null to leave the grid. */
export function gridStep(index, key, columns, total) {
  if (total <= 0) return null;
  if (key === 'ArrowRight') return Math.min(total - 1, index + 1);
  if (key === 'ArrowLeft') return Math.max(0, index - 1);
  if (key === 'ArrowDown') return index + columns < total ? index + columns : index;
  if (key === 'ArrowUp') return index - columns >= 0 ? index - columns : null;
  if (key === 'Home') return 0;
  if (key === 'End') return total - 1;
  return index;
}
