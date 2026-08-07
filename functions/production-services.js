'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

const db = admin.firestore();
const OCR_ENDPOINT = defineSecret('OCR_ENDPOINT');
const OCR_KEY = defineSecret('OCR_KEY');
const SEARCH_ENDPOINT = defineSecret('SEARCH_ENDPOINT');
const SEARCH_KEY = defineSecret('SEARCH_KEY');

async function member(uid, projectId, allowedRoles = null) {
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const snap = await db.doc(`projects/${projectId}/members/${uid}`).get();
  if (!snap.exists) throw new HttpsError('permission-denied', 'Project access denied.');
  const role = snap.data().role;
  if (allowedRoles && !allowedRoles.includes(role)) throw new HttpsError('permission-denied', 'Insufficient project role.');
  return role;
}

function validateCcr(input) {
  const c = { ...input };
  const required = ['requirement','partCategory','applicability','documentId','documentName','section','pdfPage','sourceText','operator'];
  const missing = required.filter(k => c[k] === undefined || c[k] === null || String(c[k]).trim() === '');
  if (missing.length) throw new HttpsError('invalid-argument', `Missing CCR fields: ${missing.join(', ')}`);
  const operators = ['equals','min','max','contains','in_list','evidence_exists'];
  if (!operators.includes(c.operator)) throw new HttpsError('invalid-argument', 'Unsupported CCR operator.');
  if (!Number.isInteger(Number(c.pdfPage)) || Number(c.pdfPage) < 1) throw new HttpsError('invalid-argument', 'pdfPage must be a positive integer.');
  if (c.operator !== 'evidence_exists' && (c.requiredValue === undefined || c.requiredValue === null || String(c.requiredValue).trim() === '')) {
    throw new HttpsError('invalid-argument', 'requiredValue is required for this CCR operator.');
  }
  return {
    requirement: String(c.requirement).trim(),
    partCategory: String(c.partCategory).trim(),
    application: String(c.application || '').trim(),
    environment: String(c.environment || '').trim(),
    applicability: String(c.applicability).trim(),
    documentId: String(c.documentId),
    documentName: String(c.documentName),
    documentRevision: String(c.documentRevision || 'Current'),
    section: String(c.section),
    paragraph: String(c.paragraph || ''),
    pdfPage: Number(c.pdfPage),
    printedPage: String(c.printedPage || ''),
    sourceText: String(c.sourceText),
    sourceStart: Number.isFinite(Number(c.sourceStart)) ? Number(c.sourceStart) : null,
    sourceEnd: Number.isFinite(Number(c.sourceEnd)) ? Number(c.sourceEnd) : null,
    operator: c.operator,
    requiredValue: c.requiredValue ?? null,
    unit: String(c.unit || ''),
    evidenceType: String(c.evidenceType || ''),
    status: 'VERIFIED',
    sourceCurrent: true
  };
}

exports.saveStructuredCcr = onCall({ region: 'us-central1' }, async request => {
  const { projectId, ccr } = request.data || {};
  await member(request.auth?.uid, projectId, ['admin','engineer']);
  const normalized = validateCcr(ccr || {});
  const ref = ccr?.id ? db.doc(`projects/${projectId}/requirements/${ccr.id}`) : db.collection(`projects/${projectId}/requirements`).doc();
  const existing = await ref.get();
  if (existing.exists) {
    await db.collection(`projects/${projectId}/requirementVersions`).add({ requirementId: ref.id, previous: existing.data(), replacedAt: admin.firestore.FieldValue.serverTimestamp(), replacedBy: request.auth.uid });
  }
  await ref.set({ ...normalized, id: ref.id, verifiedBy: request.auth.uid, verifiedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  await db.collection(`projects/${projectId}/audit`).add({ action: existing.exists ? 'CCR_UPDATED' : 'CCR_CREATED', requirementId: ref.id, by: request.auth.uid, at: admin.firestore.FieldValue.serverTimestamp() });
  return { id: ref.id, ...normalized };
});

function compare(operator, requiredValue, actualValue) {
  if (operator === 'evidence_exists') return actualValue ? 'PASS' : 'REVIEW';
  if (actualValue === undefined || actualValue === null || actualValue === '') return 'REVIEW';
  switch (operator) {
    case 'equals': return String(actualValue).trim().toLowerCase() === String(requiredValue).trim().toLowerCase() ? 'PASS' : 'FAIL';
    case 'contains': return String(actualValue).toLowerCase().includes(String(requiredValue).toLowerCase()) ? 'PASS' : 'FAIL';
    case 'in_list': {
      const allowed = Array.isArray(requiredValue) ? requiredValue : String(requiredValue).split(',').map(s => s.trim());
      return allowed.map(v => String(v).toLowerCase()).includes(String(actualValue).toLowerCase()) ? 'PASS' : 'FAIL';
    }
    case 'min': return Number(actualValue) >= Number(requiredValue) ? 'PASS' : 'FAIL';
    case 'max': return Number(actualValue) <= Number(requiredValue) ? 'PASS' : 'FAIL';
    default: return 'REVIEW';
  }
}

exports.evaluatePartAgainstCcrs = onCall({ region: 'us-central1' }, async request => {
  const { projectId, partFacts = {}, ccrIds = [] } = request.data || {};
  await member(request.auth?.uid, projectId);
  if (!Array.isArray(ccrIds) || !ccrIds.length) throw new HttpsError('invalid-argument', 'At least one CCR is required.');
  const snaps = await Promise.all(ccrIds.map(id => db.doc(`projects/${projectId}/requirements/${id}`).get()));
  const rows = snaps.filter(s => s.exists).map(s => {
    const c = s.data();
    const key = c.factKey || c.partField || c.partCategory;
    const actual = partFacts[key] ?? partFacts[c.factKey] ?? null;
    const result = c.sourceCurrent === false || c.status !== 'VERIFIED' ? 'REVIEW' : compare(c.operator, c.requiredValue, actual);
    return { ccrId: s.id, requirement: c.requirement, operator: c.operator, requiredValue: c.requiredValue, actualValue: actual, result, citation: { documentName: c.documentName, revision: c.documentRevision, section: c.section, paragraph: c.paragraph, pdfPage: c.pdfPage, printedPage: c.printedPage, sourceText: c.sourceText } };
  });
  const status = rows.some(r => r.result === 'FAIL') ? 'NOT_COMPLIANT' : rows.some(r => r.result === 'REVIEW') ? 'REVIEW_REQUIRED' : 'VERIFIED_COMPLIANT';
  const ref = await db.collection(`projects/${projectId}/partChecks`).add({ partFacts, ccrIds, rows, status, checkedBy: request.auth.uid, checkedAt: admin.firestore.FieldValue.serverTimestamp() });
  await db.collection(`projects/${projectId}/audit`).add({ action: 'PART_EVALUATED', checkId: ref.id, status, by: request.auth.uid, at: admin.firestore.FieldValue.serverTimestamp() });
  return { checkId: ref.id, status, rows };
});

exports.requestConventionalOcr = onCall({ region: 'us-central1', secrets: [OCR_ENDPOINT, OCR_KEY], timeoutSeconds: 300, memory: '1GiB' }, async request => {
  const { projectId, documentId, pageNumbers = [] } = request.data || {};
  await member(request.auth?.uid, projectId, ['admin','engineer','reviewer']);
  if (!Array.isArray(pageNumbers) || !pageNumbers.length || pageNumbers.length > 50) throw new HttpsError('invalid-argument', 'Provide 1-50 page numbers.');
  const doc = await db.doc(`projects/${projectId}/documents/${documentId}`).get();
  if (!doc.exists) throw new HttpsError('not-found', 'Document not found.');
  const storagePath = doc.data().storagePath;
  const [signedUrl] = await admin.storage().bucket().file(storagePath).getSignedUrl({ action: 'read', expires: Date.now() + 10 * 60 * 1000 });
  const response = await fetch(OCR_ENDPOINT.value(), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${OCR_KEY.value()}` }, body: JSON.stringify({ mode: 'CONVENTIONAL_OCR', aiUsed: false, pdfUrl: signedUrl, pageNumbers }) });
  if (!response.ok) throw new HttpsError('internal', `OCR worker returned ${response.status}.`);
  const data = await response.json();
  const writer = db.bulkWriter();
  for (const p of data.pages || []) {
    writer.set(db.doc(`projects/${projectId}/pages/${documentId}_${p.pageNumber}`), { documentId, pageNumber: p.pageNumber, text: String(p.text || ''), ocrConfidence: Number(p.confidence || 0), status: 'INDEXED_OCR', processingMethod: 'TESSERACT_OCR', aiUsed: false }, { merge: true });
  }
  await writer.close();
  await db.collection(`projects/${projectId}/audit`).add({ action: 'CONVENTIONAL_OCR_COMPLETED', documentId, pages: pageNumbers, by: request.auth.uid, at: admin.firestore.FieldValue.serverTimestamp(), aiUsed: false });
  return { pages: data.pages || [], aiUsed: false };
});

async function searchRequest(path, body) {
  const endpoint = SEARCH_ENDPOINT.value().replace(/\/$/, '');
  const response = await fetch(`${endpoint}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SEARCH_KEY.value()}` }, body: JSON.stringify(body) });
  if (!response.ok) throw new HttpsError('internal', `Search service returned ${response.status}.`);
  return response.json();
}

exports.searchProjectPages = onCall({ region: 'us-central1', secrets: [SEARCH_ENDPOINT, SEARCH_KEY], timeoutSeconds: 60 }, async request => {
  const { projectId, query, filters = {} } = request.data || {};
  await member(request.auth?.uid, projectId);
  if (!query || String(query).trim().length < 2) throw new HttpsError('invalid-argument', 'Search query is required.');
  const result = await searchRequest('/search', { projectId, query: String(query).trim(), filters, limit: 50 });
  await db.collection(`projects/${projectId}/audit`).add({ action: 'DOCUMENT_SEARCH', query: String(query).slice(0,200), by: request.auth.uid, at: admin.firestore.FieldValue.serverTimestamp() });
  return result;
});

exports.reindexProjectPages = onCall({ region: 'us-central1', secrets: [SEARCH_ENDPOINT, SEARCH_KEY], timeoutSeconds: 300 }, async request => {
  const { projectId } = request.data || {};
  await member(request.auth?.uid, projectId, ['admin','engineer']);
  const pages = await db.collection(`projects/${projectId}/pages`).get();
  const documents = {};
  const docsSnap = await db.collection(`projects/${projectId}/documents`).get();
  docsSnap.forEach(d => documents[d.id] = d.data());
  const records = pages.docs.map(p => { const x = p.data(); const d = documents[x.documentId] || {}; return { id: p.id, projectId, documentId: x.documentId, documentName: d.fileName || d.documentName || x.documentId, revision: d.revision || 'Current', current: d.current !== false, pageNumber: x.pageNumber, section: x.section || '', text: x.text || '', status: x.status || '' }; });
  const result = await searchRequest('/index', { projectId, records });
  return { indexed: records.length, result };
});

module.exports._validateCcr = validateCcr;
module.exports._compare = compare;
