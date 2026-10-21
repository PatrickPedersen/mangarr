/**
 * Chapter order as readers and BookOrbit's natural sort see it: the part after the dot is a
 * sub-chapter number, not a fraction, so 175.2 < 175.9 < 175.11. Plain number order would put
 * 175.11 before 175.2. No imports: the client uses this too.
 */
export function compareChapters(a: number, b: number) {
  const [ai, af = '0'] = String(a).split('.')
  const [bi, bf = '0'] = String(b).split('.')
  return Number(ai) - Number(bi) || Number(af) - Number(bf)
}

export const lastChapter = (numbers: number[]) => numbers.reduce((m, n) => (compareChapters(n, m) > 0 ? n : m))
export const firstChapter = (numbers: number[]) => numbers.reduce((m, n) => (compareChapters(n, m) < 0 ? n : m))
