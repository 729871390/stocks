// 标题相似度（字符二元组 Dice 系数）与最长连续公共子串，供聚类/强合并使用。

export function normalizeTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[「」『』【】《》〈〉（）()\[\]{}"'“”‘’!?！？。，、,.:：;；·…—\-|/\\]+/g, '');
}

function bigrams(s) {
  const set = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    set.set(g, (set.get(g) || 0) + 1);
  }
  return set;
}

export function titleSimilarity(a, b) {
  const na = normalizeTitle(a); const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ga = bigrams(na); const gb = bigrams(nb);
  let inter = 0; let total = 0;
  for (const [, c] of ga) total += c;
  for (const [, c] of gb) total += c;
  if (total === 0) return 0;
  for (const [g, c] of ga) if (gb.has(g)) inter += Math.min(c, gb.get(g));
  return (2 * inter) / total;
}

export function longestCommonSubstring(a, b) {
  const na = normalizeTitle(a); const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  let prev = new Array(nb.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= na.length; i++) {
    const cur = new Array(nb.length + 1).fill(0);
    for (let j = 1; j <= nb.length; j++) {
      if (na[i - 1] === nb[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}
