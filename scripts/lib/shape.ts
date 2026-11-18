// Turns an API response into something safe to print and to commit:
// the structure and the enumerated values stay, everything personal goes.

const SAFE_KEYS = new Set([
  'status',
  'environment',
  'event',
  'code',
  'error',
  'message',
  'mode',
  'payoutPath',
  'method',
  'ready',
  'type',
  'feeType',
  'currency',
  'payToTarget',
  'subjectType',
]);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const OBJECT_ID = /\b[0-9a-f]{24}\b/g;
const ADDRESS = /\b0x[0-9a-fA-F]{40}\b/g;
const LONG_HEX = /\b(0x)?[0-9a-fA-F]{32,}\b/g;
const API_KEY = /oncade_platform_(test|live)_[0-9a-f]+/g;

/** Removes anything that identifies a person, an account or a secret. */
export function scrubText(text: string): string {
  return text
    .replace(API_KEY, '<key>')
    .replace(EMAIL, '<email>')
    .replace(ADDRESS, '<address>')
    .replace(OBJECT_ID, '<id>')
    .replace(LONG_HEX, '<hex>');
}

function describe(value: string): string {
  if (/^[0-9a-f]{24}$/.test(value)) return '<id>';
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return '<address>';
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return '<tx-hash>';
  if (EMAIL.test(value)) {
    EMAIL.lastIndex = 0;
    return '<email>';
  }
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(value)) return '<date>';
  if (/^https?:\/\//.test(value)) {
    try {
      const url = new URL(value);
      return `<url ${url.host}${url.pathname.replace(/[0-9a-zA-Z_-]{12,}/g, '…')}>`;
    } catch {
      return '<url>';
    }
  }
  return `<string ${value.length}>`;
}

/** The shape of a value: keys, types and enumerated values, no personal data. */
export function shape(value: unknown, key = ''): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (SAFE_KEYS.has(key) || /scope/i.test(key)) return scrubText(value);
    return describe(value);
  }
  if (Array.isArray(value)) {
    const shown = value.slice(0, 3).map((item) => shape(item, key));
    return value.length > 3 ? [...shown, `… ${value.length} items`] : shown;
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, k)]));
  }
  return `<${typeof value}>`;
}
