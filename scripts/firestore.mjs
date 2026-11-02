// Reading the family calendar's Firebase database from GitHub Actions, as the service account
// (GOOGLE_SA_KEY, role "Cloud Datastore Viewer"). Service accounts read everything, including
// private events, notification sign-ups and the editors-only settings.
import { createSign } from 'node:crypto';

export const PROJECT = 'family-calendar-513401';
export const API_KEY = 'AIzaSyC6at88xRtF-1iWgzgA6LSmcbVpDu5zxU0';
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const b64url = (s) => Buffer.from(s).toString('base64url');
export async function accessToken(saKey, scope = 'https://www.googleapis.com/auth/datastore') {
  let key;
  try { key = JSON.parse(saKey); } catch { throw new Error('GOOGLE_SA_KEY isn’t valid JSON — paste the whole key file.'); }
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: key.client_email, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600, scope }));
  const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(key.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google sign-in failed: ${j.error_description || j.error || r.status}`);
  return j.access_token;
}

const val = (v) => v == null ? undefined
  : 'stringValue' in v ? v.stringValue : 'booleanValue' in v ? v.booleanValue
  : 'integerValue' in v ? +v.integerValue : 'doubleValue' in v ? v.doubleValue
  : 'nullValue' in v ? null : 'timestampValue' in v ? v.timestampValue
  : 'arrayValue' in v ? (v.arrayValue.values || []).map(val)
  : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, val(x)])) : undefined;
const docOf = (d) => val({ mapValue: { fields: d.fields || {} } });

export function db(token) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  return {
    /** Every document in /spaces/{space}/{name}, each with its id as `_id`. */
    async all(space, name) {
      const r = await fetch(`${FS}/spaces/${space}:runQuery`, { method: 'POST', headers, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: name }] } }) });
      if (!r.ok) throw new Error(`Couldn’t read ${name}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      return (await r.json()).filter((x) => x.document).map((x) => ({ ...docOf(x.document), _id: x.document.name.split('/').pop() }));
    },
    /** One document by path under /spaces/{space}, or null. */
    async get(path) {
      const r = await fetch(`${FS}/${path}`, { headers });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`Couldn’t read ${path}: HTTP ${r.status}`);
      return docOf(await r.json());
    },
  };
}
