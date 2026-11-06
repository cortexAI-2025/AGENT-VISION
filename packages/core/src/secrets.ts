/**
 * Détection / masquage de secrets dans du TEXTE (sorties de modèle, titres de fenêtre,
 * métadonnées). Ce module ne lit pas les pixels : le masquage d'image repose sur des
 * régions explicites (voir image.ts).
 */
export interface SecretMatch {
  kind: string;
  start: number;
  end: number;
}

const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { kind: "api_key", re: /\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi },
  {
    kind: "password_assignment",
    re: /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\b\s*[:=]\s*["']?[^\s"']{6,}/gi,
  },
  { kind: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: "iban", re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b/g },
];

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function detectSecrets(text: string): SecretMatch[] {
  const found: SecretMatch[] = [];
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      found.push({ kind, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    }
  }
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      found.push({ kind: "credit_card", start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

export function redactText(text: string): { text: string; kinds: string[] } {
  const matches = detectSecrets(text);
  if (matches.length === 0) return { text, kinds: [] };
  let out = "";
  let cursor = 0;
  const kinds = new Set<string>();
  for (const m of matches) {
    if (m.end <= cursor) continue; // chevauchement déjà masqué
    const start = Math.max(m.start, cursor);
    out += text.slice(cursor, start) + `[REDACTED:${m.kind}]`;
    cursor = m.end;
    kinds.add(m.kind);
  }
  out += text.slice(cursor);
  return { text: out, kinds: [...kinds] };
}

/** Applique redactText récursivement à toutes les chaînes d'une valeur JSON. */
export function redactDeep<T>(value: T): { value: T; kinds: string[] } {
  const kinds = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactText(v);
      r.kinds.forEach((k) => kinds.add(k));
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return { value: walk(value) as T, kinds: [...kinds] };
}
