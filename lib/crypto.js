// AES-GCM encryption keyed by the family passcode (PBKDF2). Works in browsers
// and Node 20+, so the app and the GitHub Action read the same files.
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const keyCache = new Map();
async function deriveKey(pass, salt) {
  const id = pass + '|' + b64(salt);
  if (keyCache.has(id)) return keyCache.get(id);
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  keyCache.set(id, key);
  return key;
}

export async function encryptJSON(obj, pass, saltB64) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(pass, salt), enc.encode(JSON.stringify(obj)));
  return JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
}

export async function decryptJSON(text, pass) {
  const o = JSON.parse(text);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, await deriveKey(pass, unb64(o.salt)), unb64(o.ct));
  return JSON.parse(dec.decode(pt));
}

export const saltOf = (text) => JSON.parse(text).salt;

/* Attachments (PDFs, photos): each file gets its own random key. The key lives inside
   the event, which is itself encrypted, so anyone who can see the event can open its file. */
export async function encryptBytes(bytes) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return { data: out, key: b64(raw) };
}
export async function decryptBytes(data, keyB64) {
  const u = new Uint8Array(data);
  const key = await crypto.subtle.importKey('raw', unb64(keyB64), 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, key, u.slice(12)));
}
export const bytesToB64 = b64;
