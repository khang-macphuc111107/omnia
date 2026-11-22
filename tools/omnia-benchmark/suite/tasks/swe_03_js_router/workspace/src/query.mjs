/**
 * URL path segmentation, percent-decoding, and query string parsing.
 */

/**
 * Parse a query string (without leading '?') into a plain key->value object.
 * Repeated keys become arrays of strings.
 *
 * @param {string} rawQuery
 * @returns {Record<string, string | string[]>}
 */
export function parseQuery(rawQuery) {
  const result = {};
  if (!rawQuery) {
    return result;
  }
  const pairs = rawQuery.split('&');
  for (const pair of pairs) {
    if (!pair) continue;
    const eqIdx = pair.indexOf('=');
    const rawKey = eqIdx === -1 ? pair : pair.slice(0, eqIdx);
    const rawVal = eqIdx === -1 ? '' : pair.slice(eqIdx + 1);
    const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    const val = decodeURIComponent(rawVal.replace(/\+/g, ' '));
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      if (Array.isArray(result[key])) {
        result[key].push(val);
      } else {
        result[key] = [result[key], val];
      }
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Parse a raw request URL (e.g. "/files/a%2Fb/meta?v=1") into decoded path segments
 * and parsed query parameters.
 *
 * @param {string} rawUrl
 * @returns {{ pathname: string, segments: string[], query: Record<string, string | string[]> }}
 */
export function parseRequestUrl(rawUrl) {
  const qIdx = rawUrl.indexOf('?');
  const rawPath = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
  const rawQuery = qIdx === -1 ? '' : rawUrl.slice(qIdx + 1);

  const decodedPath = decodeURIComponent(rawPath);
  const segments = decodedPath.split('/').filter((seg) => seg.length > 0);

  return {
    pathname: rawPath || '/',
    segments,
    query: parseQuery(rawQuery),
  };
}
