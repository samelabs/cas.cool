/**
 * CAS Registry Number validation — format + check digit.
 *
 * Format (shared with the post-attach path's CAS_FORMAT in
 * src/lib/chemistry/post-chemicals.ts): 2-7 digits, hyphen, 2 digits,
 * hyphen, 1 check digit — e.g. "50-00-0", "7732-18-5".
 *
 * Check digit (only enforced on the SEARCH DIRECT path, not on post
 * attach): starting from the digit LEFT of the check digit and moving
 * left, multiply each digit by 1, 2, 3, …; the sum mod 10 must equal the
 * check digit. This is what stops auto-created Chemical rows from garbage
 * — a random well-formed string like "12-34-5" fails
 * (1×4 + 2×3 + 3×2 + 4×1 = 20 → check 0, not 5).
 *
 * Example passes: 50-00-0 (formaldehyde), 64-17-5 (ethanol),
 * 7732-18-5 (water), 9002-86-2 (PVC).
 */

export const CAS_FORMAT = /^\d{2,7}-\d{2}-\d$/

export function isValidCasFormat(value: string): boolean {
  return CAS_FORMAT.test(value.trim())
}

/** Check-digit validation. Input must already pass format validation. */
export function isValidCasChecksum(value: string): boolean {
  const digits = value.replace(/-/g, '')
  const check = Number(digits[digits.length - 1])
  let weight = 1
  let sum = 0
  for (let i = digits.length - 2; i >= 0; i--) {
    sum += Number(digits[i]) * weight
    weight++
  }
  return sum % 10 === check
}

/** Format AND checksum — the gate for search-direct auto-creation. */
export function isValidCasNumber(value: string): boolean {
  const trimmed = value.trim()
  return isValidCasFormat(trimmed) && isValidCasChecksum(trimmed)
}

/** HGS compound page URL for the HCID badge — a plain external link.
 *  cas.cool imports HGS stock data once; it never calls HGS at runtime. */
export function hgsChemicalUrl(hcid: number): string {
  return `https://huagongshe.com/chemical/${hcid}`
}
