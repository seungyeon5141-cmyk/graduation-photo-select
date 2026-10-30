// Password hashing and signed session cookies. No secrets live in source: SESSION_SECRET and
// ADMIN_PASSWORD come from the environment.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const COOKIE = 'gps_session';
const MAX_AGE = 60 * 60 * 12; // 12 hours

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length);
  return timingSafeEqual(actual, expected);
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('SESSION_SECRET 환경 변수(16자 이상)가 필요해요.');
  return s;
}

const sign = (data) => createHmac('sha256', secret()).update(data).digest('base64url');

// `pw` ties a student session to the group's current password hash, so a teacher's reset
// logs that group out everywhere.
export function sessionCookie(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + MAX_AGE * 1000 })).toString('base64url');
  return `${COOKIE}=${body}.${sign(body)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readSession(request) {
  const raw = (request.headers.get('cookie') || '')
    .split(';').map((p) => p.trim()).find((p) => p.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [body, mac] = raw.slice(COOKIE.length + 1).split('.');
  if (!body || !mac || !safeEqual(mac, sign(body))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

export const pwTag = (hash) => String(hash).slice(-12);

// Simple per-instance brute-force guard: 8 wrong tries locks a key for 5 minutes.
const attempts = new Map();
export function tooManyAttempts(key) {
  const a = attempts.get(key);
  return Boolean(a && a.count >= 8 && Date.now() - a.at < 5 * 60 * 1000);
}
export function recordFailure(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.at > 5 * 60 * 1000) attempts.set(key, { count: 1, at: Date.now() });
  else a.count += 1;
}
export function clearFailures(key) {
  attempts.delete(key);
}
