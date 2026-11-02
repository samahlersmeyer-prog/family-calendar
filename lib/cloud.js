// Firebase (Google sign-in + Firestore). Everything the app stores lives under
// /spaces/{spaceId}. The space id is a long random secret: relatives get it in their
// link; editors (Sam & Emily) find it after signing in via /editors/{email}.
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyC6at88xRtF-1iWgzgA6LSmcbVpDu5zxU0',
  authDomain: 'family-calendar-513401.firebaseapp.com',
  projectId: 'family-calendar-513401',
  storageBucket: 'family-calendar-513401.firebasestorage.app',
  messagingSenderId: '854962669636',
  appId: '1:854962669636:web:7abb3b663f580e8b1d9411',
};
const V = '10.12.2';
const CHUNK = 700000; // characters of base64 per Firestore document (limit is 1 MiB)

/** Family codes are stored hashed, so the list of codes can't be read back. */
export async function codeHash(code) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('family-calendar:' + code.trim().toLowerCase()));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function initCloud() {
  if (globalThis.__CLOUD_MOCK__) return globalThis.__CLOUD_MOCK__;
  const [{ initializeApp }, A, F] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`),
  ]);
  const app = initializeApp(FIREBASE_CONFIG);
  const auth = A.getAuth(app);
  // Keep a copy on the phone so the calendar opens with no signal.
  let db;
  try { db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) }); }
  catch { db = F.getFirestore(app); }
  const ev = (s) => F.collection(db, 'spaces', s, 'events');
  const clean = (o) => JSON.parse(JSON.stringify(o)); // drop undefined

  return {
    onUser: (cb) => A.onAuthStateChanged(auth, (u) => cb(u ? { email: (u.email || '').toLowerCase(), name: u.displayName || '' } : null)),
    async signIn() {
      const p = new A.GoogleAuthProvider();
      p.setCustomParameters({ prompt: 'select_account' });
      try { await A.signInWithPopup(auth, p); }
      catch (e) {
        if (/popup-blocked|operation-not-supported/.test(e.code || '')) return A.signInWithRedirect(auth, p);
        if (/popup-closed|cancelled-popup/.test(e.code || '')) return;
        throw e;
      }
    },
    signOut: () => A.signOut(auth),
    async editorSpace(email) {
      const s = await F.getDoc(F.doc(db, 'editors', email));
      return s.exists() ? s.data().space : null;
    },
    async getSpace(id) {
      const s = await F.getDoc(F.doc(db, 'spaces', id));
      return s.exists() ? s.data() : null;
    },
    createSpace: (id, data) => F.setDoc(F.doc(db, 'spaces', id), clean(data)),
    updateSpace: (id, data) => F.updateDoc(F.doc(db, 'spaces', id), clean(data)),
    setEditor: (email, space) => F.setDoc(F.doc(db, 'editors', email.toLowerCase()), { space }),
    removeEditor: (email) => F.deleteDoc(F.doc(db, 'editors', email.toLowerCase())),
    watchSpace: (id, cb, onErr) => F.onSnapshot(F.doc(db, 'spaces', id), (s) => cb(s.exists() ? s.data() : null, s.metadata.fromCache), onErr),
    watchEvents(space, sharedOnly, cb, onErr) {
      const q = sharedOnly ? F.query(ev(space), F.where('shared', '==', true)) : ev(space);
      return F.onSnapshot(q, (snap) => cb(snap.docs.map((d) => d.data())), onErr);
    },
    async writeEvents(space, puts = [], dels = []) {
      const ops = [...puts.map((e) => ['set', e]), ...dels.map((id) => ['del', id])];
      for (let i = 0; i < ops.length; i += 450) {
        const b = F.writeBatch(db);
        for (const [k, v] of ops.slice(i, i + 450)) {
          if (k === 'set') b.set(F.doc(ev(space), v.id), clean(v));
          else b.delete(F.doc(ev(space), v));
        }
        await b.commit();
      }
    },
    watchRides: (space, cb) => F.onSnapshot(F.collection(db, 'spaces', space, 'rides'),
      (snap) => { const o = {}; snap.docs.forEach((d) => { o[d.id] = d.data(); }); cb(o); }, () => cb({})),
    setRide: (space, id, data) => (data ? F.setDoc(F.doc(db, 'spaces', space, 'rides', id), data) : F.deleteDoc(F.doc(db, 'spaces', space, 'rides', id))),
    async lookupCode(code) {
      const s = await F.getDoc(F.doc(db, 'codes', await codeHash(code)));
      return s.exists() ? s.data().space : null;
    },
    setCode: async (code, space) => F.setDoc(F.doc(db, 'codes', await codeHash(code)), { space }),
    addFamilyEvent: (space, e) => F.setDoc(F.doc(ev(space), e.id), clean(e)),
    async putFile(space, id, meta, b64) {
      const parts = Math.ceil(b64.length / CHUNK) || 1;
      for (let i = 0; i < parts; i++) await F.setDoc(F.doc(db, 'spaces', space, 'files', id, 'chunks', String(i)), { d: b64.slice(i * CHUNK, (i + 1) * CHUNK) });
      await F.setDoc(F.doc(db, 'spaces', space, 'files', id), { ...meta, parts });
    },
    async getFile(space, id) {
      const m = await F.getDoc(F.doc(db, 'spaces', space, 'files', id));
      if (!m.exists()) throw new Error('File not found');
      let b64 = '';
      for (let i = 0; i < m.data().parts; i++) b64 += (await F.getDoc(F.doc(db, 'spaces', space, 'files', id, 'chunks', String(i)))).data().d;
      return b64;
    },
  };
}
