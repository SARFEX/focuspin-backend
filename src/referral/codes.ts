/**
 * Реферальные коды: 16 символов алфавита Crockford base32 = 80 бит энтропии из CSPRNG.
 * В алфавите нет I, L, O, U (путаются с 1/0 и друг с другом, U — ради нецензурных слов).
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 16;
const CODE_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}$/;

/** 10 случайных байт (80 бит) → 16 символов по 5 бит. */
export function generateReferralCode(random: (bytes: Uint8Array) => Uint8Array = crypto.getRandomValues.bind(crypto)): string {
  const bytes = random(new Uint8Array(10));
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}

/**
 * Приведение пользовательского ввода к каноническому коду (регистр, Crockford-замены
 * O→0, I/L→1). null — если после нормализации это не валидный код.
 */
export function normalizeReferralCode(raw: string): string | null {
  const value = raw.trim().toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE_RE.test(value) ? value : null;
}
