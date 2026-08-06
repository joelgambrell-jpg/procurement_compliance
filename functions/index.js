'use strict';

const { onObjectFinalized } = require('firebase-functions/v2/storage');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const SUPPLIER_AI_ENDPOINT = defineSecret('SUPPLIER_AI_ENDPOINT');
const SUPPLIER_AI_KEY = defineSecret('SUPPLIER_AI_KEY');

function assertProjectPath(path) {
  const match = /^projects\/([^/]+)\/documents\/([^/]+\.pdf)$/i.exec(path || '');
  if (!match) return null;
  return { projectId: match[1], fileName: match[2] };
}

async function assertMember(uid, projectId, roles = null) {
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const snap = await db.doc(`projects/${projectId}/members/${uid}`).get();
  if (!snap.exists) throw new HttpsError('permission-denied', 'Project access denied.');
  const role = snap.data().role;
  if (roles && !roles.includes(role)) throw new HttpsError('permission-denied', 'Insufficient project role.');
  return role;
}

function sectionClue(text = '') {
  const patterns = [/\b\d{2}\s\d{2}\s\d{2}(?:\.\d+)?\b/, /\b(?:section|paragraph|article)\s+[a-z0-9.\-]+/i, /\b\d+\.\d+(?:\.\d+)*\b/];
  for (const p of patterns) { const m = text.match(p); if (m) return m[0]; }
  return 'Section not automatically identified';
}

// NON-AI document processing. Digital PDF text extraction only.
// Scanned/image-only pages are flagged OCR_REQUIRED and are never sent to an AI service.
exports.processProjectPdf = onObjectFinalized({ region: 'us-central1', timeoutSeconds: 540, memory: '2GiB' }, async event => {
  const object = event.data;
  const parsed = assertProjectPath(object.name);
  if (!parsed || object.contentType !== 'application/pdf') return;
  const { projectId, fileName } = parsed;
  const documentId = Buffer.from(fileName).toString('base64url').slice(0, 80);
  const docRef = db.doc(`projects/${projectId}/documents/${documentId}`);
  await docRef.set({ fileName, storagePath: object.name, processingStatus: 'PROCESSING', processingMethod: 'CONVENTIONAL_PDF_TEXT_EXTRACTION', aiUsed: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  try {
    const [bytes] = await admin.storage().bucket(object.bucket).file(object.name).download();
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
    let ocrRequired = 0;
    const writer = db.bulkWriter();
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const text = textContent.items.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim();
      const status = text.length < 40 ? 'OCR_REQUIRED' : 'INDEXED';
      if (status === 'OCR_REQUIRED') ocrRequired++;
      writer.set(db.doc(`projects/${projectId}/pages/${documentId}_${pageNumber}`), { documentId, pageNumber, text, section: sectionClue(text), status, aiUsed: false });
    }
    await writer.close();
    await docRef.set({ pageCount: pdf.numPages, ocrRequiredPages: ocrRequired, processingStatus: ocrRequired ? 'PARTIAL_OCR_REQUIRED' : 'INDEXED', aiUsed: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  } catch (error) {
    await docRef.set({ processingStatus: 'FAILED', processingError: String(error.message || error), aiUsed: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    throw error;
  }
});

const ALLOWED_KEYS = new Set(['partCategory','application','environment','approvedManufacturers','technicalCriteria']);
const BLOCKED_PATTERNS = [/customer/i,/client/i,/project\s*(name|id)/i,/document/i,/specification\s*(section|number)/i,/drawing/i,/page\s*\d+/i,/excerpt/i,/address/i,/site\s*name/i,/quantity/i];

function sanitizeSupplierPayload(input) {
  const clean = {};
  for (const [key, value] of Object.entries(input || {})) if (ALLOWED_KEYS.has(key)) clean[key] = value;
  const serialized = JSON.stringify(clean);
  const blocked = BLOCKED_PATTERNS.filter(p => p.test(serialized)).map(p => p.source);
  if (blocked.length) throw new HttpsError('invalid-argument', 'Prohibited project or document information detected in supplier search.');
  if (!clean.partCategory || typeof clean.partCategory !== 'string') throw new HttpsError('invalid-argument', 'Part category is required.');
  return clean;
}

exports.searchPublicSuppliers = onCall({ region: 'us-central1', secrets: [SUPPLIER_AI_ENDPOINT, SUPPLIER_AI_KEY], timeoutSeconds: 120 }, async request => {
  const { projectId, criteria } = request.data || {};
  await assertMember(request.auth?.uid, projectId);
  const project = await db.doc(`projects/${projectId}`).get();
  if (!project.exists || project.data().supplierAiPolicy !== 'public_only') throw new HttpsError('failed-precondition', 'Public supplier AI is disabled for this project.');
  const sanitized = sanitizeSupplierPayload(criteria);

  // This function has no code path or IAM requirement to read project documents/pages.
  // Configure an approved public-web research provider through Secret Manager.
  const endpoint = SUPPLIER_AI_ENDPOINT.value();
  const apiKey = SUPPLIER_AI_KEY.value();
  if (!endpoint || !apiKey) throw new HttpsError('failed-precondition', 'Supplier search provider is not configured.');

  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ criteria: sanitized, sources: ['manufacturer','approved_distributor','public_catalog'], requireEvidence: true }) });
  if (!response.ok) throw new HttpsError('internal', `Supplier provider returned ${response.status}.`);
  const result = await response.json();
  await db.collection(`projects/${projectId}/supplierSearches`).add({ requestedBy: request.auth.uid, sanitizedCriteria: sanitized, result, customerDocumentsSent: false, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  return { sanitizedCriteria: sanitized, candidates: result.candidates || [], customerDocumentsSent: false };
});
