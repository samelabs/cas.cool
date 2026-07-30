// Tiny zero-dependency className combiner.
// Accepts strings, numbers, arrays, and falsy values (which are skipped).
export type ClassValue = string | number | null | undefined | false | ClassValue[]

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = []
  for (const v of inputs) {
    if (!v && v !== 0) continue
    if (Array.isArray(v)) {
      const s = cn(...v)
      if (s) out.push(s)
    } else {
      out.push(String(v))
    }
  }
  return out.join(' ')
}
