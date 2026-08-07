// NEXUS Procurement Compliance - Firebase client adapter
// Set window.NEXUS_FIREBASE_CONFIG before this module loads.
// No service-account credentials or private API keys belong in this file.

const CDN = 'https://www.gstatic.com/firebasejs/12.1.0';
let api = null;

export async function initFirebase() {
  if (api) return api;
  const config = window.NEXUS_FIREBASE_CONFIG;
  if (!config?.apiKey || !config?.projectId) {
    console.warn('NEXUS Firebase config is not set. App remains in local prototype mode.');
    return null;
  }

  const [{ initializeApp }, authMod, fsMod, storageMod, fnMod] = await Promise.all([
    import(`${CDN}/firebase-app.js`),
    import(`${CDN}/firebase-auth.js`),
    import(`${CDN}/firebase-firestore.js`),
    import(`${CDN}/firebase-storage.js`),
    import(`${CDN}/firebase-functions.js`)
  ]);

  const app = initializeApp(config);
  const auth = authMod.getAuth(app);
  const db = fsMod.getFirestore(app);
  const storage = storageMod.getStorage(app);
  const functions = fnMod.getFunctions(app, 'us-central1');

  api = { app, auth, db, storage, functions, authMod, fsMod, storageMod, fnMod };
  window.NexusFirebase = api;
  return api;
}

export async function requireUser() {
  const f = await initFirebase();
  if (!f) return null;
  return await new Promise(resolve => {
    const off = f.authMod.onAuthStateChanged(f.auth, user => { off(); resolve(user || null); });
  });
}

export async function listProjectsForCurrentUser() {
  const f = await initFirebase();
  const user = await requireUser();
  if (!f || !user) return [];
  // Project membership is stored at projects/{projectId}/members/{uid};
  // this collection-group query requires the corresponding Firestore index.
  const q = f.fsMod.query(f.fsMod.collectionGroup(f.db, 'members'), f.fsMod.where('__name__', '>=', ''));
  const snap = await f.fsMod.getDocs(q);
  return snap.docs.filter(d => d.id === user.uid).map(d => ({ projectId: d.ref.parent.parent.id, ...d.data() }));
}

export async function uploadProjectPdf(projectId, file) {
  const f = await initFirebase();
  const user = await requireUser();
  if (!f || !user) throw new Error('Authentication required.');
  if (!projectId || file?.type !== 'application/pdf') throw new Error('A PDF and projectId are required.');
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `projects/${projectId}/documents/${Date.now()}_${safeName}`;
  const ref = f.storageMod.ref(f.storage, path);
  await f.storageMod.uploadBytes(ref, file, { contentType: 'application/pdf', customMetadata: { uploadedBy: user.uid } });
  return { path };
}

export async function savePreferredVendor(projectId, vendor) {
  const f = await initFirebase();
  if (!f) throw new Error('Firebase is not configured.');
  const id = vendor.id || crypto.randomUUID();
  await f.fsMod.setDoc(f.fsMod.doc(f.db, `projects/${projectId}/preferredVendors/${id}`), { ...vendor, id, updatedAt: f.fsMod.serverTimestamp() }, { merge: true });
  return id;
}

export async function getPreferredVendors(projectId) {
  const f = await initFirebase();
  if (!f) return [];
  const snap = await f.fsMod.getDocs(f.fsMod.collection(f.db, `projects/${projectId}/preferredVendors`));
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => (a.priority || 99) - (b.priority || 99));
}

export async function callFunction(name, data) {
  const f = await initFirebase();
  if (!f) throw new Error('Firebase is not configured.');
  const callable = f.fnMod.httpsCallable(f.functions, name);
  return (await callable(data)).data;
}

export async function searchProjectPages(projectId, query, filters = {}) {
  return callFunction('searchProjectPages', { projectId, query, filters });
}

export async function saveStructuredCcr(projectId, ccr) {
  return callFunction('saveStructuredCcr', { projectId, ccr });
}

export async function evaluatePart(projectId, partFacts, ccrIds) {
  return callFunction('evaluatePartAgainstCcrs', { projectId, partFacts, ccrIds });
}

export async function requestConventionalOcr(projectId, documentId, pageNumbers) {
  return callFunction('requestConventionalOcr', { projectId, documentId, pageNumbers });
}

export async function searchPublicSuppliers(projectId, criteria) {
  return callFunction('searchPublicSuppliers', { projectId, criteria });
}
