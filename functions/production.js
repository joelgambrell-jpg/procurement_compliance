'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

const db = admin.firestore();
const OCR_ENDPOINT = defineSecret('OCR_ENDPOINT');
const OCR_API_KEY = defineSecret('OCR_API_KEY');
const SEARCH_ENDPOINT = defineSecret('SEARCH_ENDPOINT');
const SEARCH_API_KEY = defineSecret('SEARCH_API_KEY');
const MALWARE_ENDPOINT = defineSecret('MALWARE_ENDPOINT');
const MALWARE_API_KEY = defineSecret('MALWARE_API_KEY');

const ROLES = ['admin','engineer','procurement','reviewer','viewer'];
const WRITE_ROLES = ['admin','engineer'];
const APPROVE_ROLES = ['admin','engineer','reviewer'];

async function member(uid, projectId, allowed = null) {
  if (!uid) throw new HttpsError('unauthenticated','Authentication required.');
  const snap = await db.doc(`projects/${projectId}/members/${uid}`).get();
  if (!snap.exists) throw new HttpsError('permission-denied','Project access denied.');
  const role = snap.data().role;
  if (allowed && !allowed.includes(role)) throw new HttpsError('permission-denied','Insufficient project role.');
  return role;
}

async function audit(projectId, uid, action, details = {}) {
  await db.collection(`projects/${projectId}/audit`).add({
    action, actorUid: uid || 'system', details,
    createdAt: admin.firestore.FieldValue.serverTimestamp(), immutable: true
  });
}

function text(v, max = 5000) { return String(v ?? '').trim().slice(0,max); }
function httpUrl(v) { try { const u = new URL(v); return ['http:','https:'].includes(u.protocol); } catch { return false; } }
function required(v, name) { if (!text(v)) throw new HttpsError('invalid-argument',`${name} is required.`); }

function validateCcr(input) {
  const c = input || {};
  ['requirement','partCategory','documentId','documentName','section','pdfPage','sourceText','applicability'].forEach(k => required(c[k],k));
  if (!Number.isInteger(Number(c.pdfPage)) || Number(c.pdfPage) < 1) throw new HttpsError('invalid-argument','pdfPage must be a positive integer.');
  if (text(c.sourceText).length < 10) throw new HttpsError('invalid-argument','Source text is too short to verify.');
  return {
    requirement:text(c.requirement), partCategory:text(c.partCategory,200), application:text(c.application,200), environment:text(c.environment,200),
    applicability:text(c.applicability,500), operator:text(c.operator || 'EXISTS',30), requiredValue:c.requiredValue ?? null, unit:text(c.unit,50),
    documentId:text(c.documentId,200), documentName:text(c.documentName,500), documentRevision:text(c.documentRevision,100),
    section:text(c.section,200), paragraph:text(c.paragraph,200), pdfPage:Number(c.pdfPage), printedPage:text(c.printedPage,100),
    sourceText:text(c.sourceText,8000), sourceStart:Number(c.sourceStart || 0), sourceEnd:Number(c.sourceEnd || 0),
    status:'CURRENT', verificationStatus:'VERIFIED', aiUsed:false
  };
}

function compare(operator, actual, requiredValue) {
  if (actual === undefined || actual === null || actual === '') return {status:'REVIEW_REQUIRED', reason:'Product evidence missing'};
  switch (operator) {
    case 'EQ': return String(actual).toLowerCase() === String(requiredValue).toLowerCase() ? {status:'PASS'} : {status:'FAIL'};
    case 'IN': {
      const list = Array.isArray(requiredValue) ? requiredValue : String(requiredValue).split(',').map(s=>s.trim());
      return list.map(String).map(s=>s.toLowerCase()).includes(String(actual).toLowerCase()) ? {status:'PASS'} : {status:'FAIL'};
    }
    case 'GTE': return Number(actual) >= Number(requiredValue) ? {status:'PASS'} : {status:'FAIL'};
    case 'LTE': return Number(actual) <= Number(requiredValue) ? {status:'PASS'} : {status:'FAIL'};
    case 'CONTAINS': return String(actual).toLowerCase().includes(String(requiredValue).toLowerCase()) ? {status:'PASS'} : {status:'FAIL'};
    case 'EXISTS': return text(actual) ? {status:'PASS'} : {status:'REVIEW_REQUIRED',reason:'Evidence required'};
    default: return {status:'REVIEW_REQUIRED',reason:'Unsupported comparison operator'};
  }
}

exports.saveVerifiedCcr = onCall({region:'us-central1'}, async request => {
  const {projectId, ccr, ccrId} = request.data || {};
  await member(request.auth?.uid, projectId, WRITE_ROLES);
  const data = validateCcr(ccr);
  const ref = ccrId ? db.doc(`projects/${projectId}/requirements/${ccrId}`) : db.collection(`projects/${projectId}/requirements`).doc();
  const old = await ref.get();
  const version = old.exists ? Number(old.data().version || 1)+1 : 1;
  if (old.exists) await db.collection(`projects/${projectId}/requirementVersions`).add({...old.data(), requirementId:ref.id, archivedAt:admin.firestore.FieldValue.serverTimestamp()});
  await ref.set({...data, version, verifiedBy:request.auth.uid, verifiedAt:admin.firestore.FieldValue.serverTimestamp(), updatedAt:admin.firestore.FieldValue.serverTimestamp()});
  await audit(projectId,request.auth.uid,old.exists?'CCR_UPDATED':'CCR_CREATED',{ccrId:ref.id,version,documentId:data.documentId,pdfPage:data.pdfPage});
  return {ccrId:ref.id,version};
});

exports.setDocumentRevision = onCall({region:'us-central1'}, async request => {
  const {projectId, documentId, revision, effectiveDate, supersedesDocumentId, precedenceRank} = request.data || {};
  await member(request.auth?.uid, projectId, WRITE_ROLES);
  required(documentId,'documentId'); required(revision,'revision');
  const ref = db.doc(`projects/${projectId}/documents/${documentId}`);
  await ref.set({revision:text(revision,100),effectiveDate:text(effectiveDate,50),precedenceRank:Number(precedenceRank||0),status:'CURRENT',updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
  if (supersedesDocumentId) {
    await db.doc(`projects/${projectId}/documents/${supersedesDocumentId}`).set({status:'SUPERSEDED',supersededBy:documentId,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    const q = await db.collection(`projects/${projectId}/requirements`).where('documentId','==',supersedesDocumentId).get();
    const batch = db.batch(); q.forEach(d=>batch.update(d.ref,{status:'REVIEW_REQUIRED',reviewReason:'Source document superseded',supersededByDocumentId:documentId})); await batch.commit();
  }
  await audit(projectId,request.auth.uid,'DOCUMENT_REVISION_SET',{documentId,revision,supersedesDocumentId: supersedesDocumentId||null});
  return {ok:true};
});

exports.evaluatePart = onCall({region:'us-central1'}, async request => {
  const {projectId, part, requirementIds} = request.data || {};
  await member(request.auth?.uid, projectId);
  required(part?.partCategory,'part.partCategory');
  let query = db.collection(`projects/${projectId}/requirements`).where('status','==','CURRENT');
  const snap = await query.get();
  const selected = snap.docs.filter(d=>!Array.isArray(requirementIds)||requirementIds.length===0||requirementIds.includes(d.id));
  const facts = part.facts || {};
  const results = selected.map(d=>{ const r=d.data(); const actual=facts[r.factKey || r.partCategory] ?? facts[r.requirement] ?? null; const outcome=compare(r.operator||'EXISTS',actual,r.requiredValue); return {ccrId:d.id,requirement:r.requirement,documentName:r.documentName,section:r.section,pdfPage:r.pdfPage,sourceText:r.sourceText,actual,requiredValue:r.requiredValue,operator:r.operator||'EXISTS',...outcome}; });
  const finalStatus = results.some(r=>r.status==='FAIL')?'NOT_COMPLIANT':results.some(r=>r.status==='REVIEW_REQUIRED')?'REVIEW_REQUIRED':results.length?'VERIFIED_COMPLIANT':'NOT_EVALUATED';
  const ref = await db.collection(`projects/${projectId}/partChecks`).add({part,results,finalStatus,createdBy:request.auth.uid,createdAt:admin.firestore.FieldValue.serverTimestamp(),aiUsed:false});
  await audit(projectId,request.auth.uid,'PART_EVALUATED',{checkId:ref.id,finalStatus,resultCount:results.length});
  return {checkId:ref.id,finalStatus,results};
});

exports.saveEvidencePackage = onCall({region:'us-central1'}, async request => {
  const {projectId, evidence} = request.data || {};
  await member(request.auth?.uid, projectId, ['admin','engineer','procurement','reviewer']);
  required(evidence?.manufacturer,'manufacturer'); required(evidence?.partNumber,'partNumber');
  if (!Array.isArray(evidence.technicalSources) || !evidence.technicalSources.some(s=>httpUrl(s.url))) throw new HttpsError('invalid-argument','At least one technical source URL is required.');
  if (!Array.isArray(evidence.purchaseSources) || !evidence.purchaseSources.some(s=>httpUrl(s.url))) throw new HttpsError('invalid-argument','At least one purchase source URL is required.');
  const ref = db.collection(`projects/${projectId}/evidencePackages`).doc();
  await ref.set({...evidence,status:'UNVERIFIED',createdBy:request.auth.uid,createdAt:admin.firestore.FieldValue.serverTimestamp(),revalidateAfter:evidence.revalidateAfter||null});
  await audit(projectId,request.auth.uid,'EVIDENCE_PACKAGE_CREATED',{evidenceId:ref.id,manufacturer:evidence.manufacturer,partNumber:evidence.partNumber});
  return {evidenceId:ref.id};
});

exports.verifyEvidencePackage = onCall({region:'us-central1'}, async request => {
  const {projectId,evidenceId,status,notes} = request.data || {};
  await member(request.auth?.uid, projectId, APPROVE_ROLES);
  if (!['VERIFIED','REJECTED','REVIEW_REQUIRED'].includes(status)) throw new HttpsError('invalid-argument','Invalid evidence status.');
  await db.doc(`projects/${projectId}/evidencePackages/${evidenceId}`).update({status,reviewNotes:text(notes,2000),verifiedBy:request.auth.uid,verifiedAt:admin.firestore.FieldValue.serverTimestamp()});
  await audit(projectId,request.auth.uid,'EVIDENCE_PACKAGE_REVIEWED',{evidenceId,status});
  return {ok:true};
});

exports.assignProjectRole = onCall({region:'us-central1'}, async request => {
  const {projectId,uid,role} = request.data || {};
  await member(request.auth?.uid, projectId, ['admin']);
  if (!ROLES.includes(role)) throw new HttpsError('invalid-argument','Invalid role.');
  await db.doc(`projects/${projectId}/members/${uid}`).set({role,updatedBy:request.auth.uid,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
  await audit(projectId,request.auth.uid,'PROJECT_ROLE_ASSIGNED',{uid,role});
  return {ok:true};
});

exports.requestConventionalOcr = onCall({region:'us-central1',secrets:[OCR_ENDPOINT,OCR_API_KEY],timeoutSeconds:300}, async request => {
  const {projectId,documentId,pages} = request.data || {};
  await member(request.auth?.uid, projectId, WRITE_ROLES);
  const doc = await db.doc(`projects/${projectId}/documents/${documentId}`).get();
  if (!doc.exists) throw new HttpsError('not-found','Document not found.');
  const endpoint=OCR_ENDPOINT.value(), key=OCR_API_KEY.value();
  if (!endpoint||!key) throw new HttpsError('failed-precondition','Conventional OCR worker is not configured.');
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify({projectId,documentId,storagePath:doc.data().storagePath,pages:Array.isArray(pages)?pages:[],mode:'CONVENTIONAL_OCR',aiUsed:false})});
  if(!response.ok) throw new HttpsError('internal',`OCR worker returned ${response.status}.`);
  await audit(projectId,request.auth.uid,'OCR_REQUESTED',{documentId,pages:pages||[]});
  return {queued:true,aiUsed:false};
});

exports.scanUploadedDocument = onCall({region:'us-central1',secrets:[MALWARE_ENDPOINT,MALWARE_API_KEY],timeoutSeconds:120}, async request => {
  const {projectId,documentId}=request.data||{};
  await member(request.auth?.uid,projectId,WRITE_ROLES);
  const doc=await db.doc(`projects/${projectId}/documents/${documentId}`).get();
  if(!doc.exists) throw new HttpsError('not-found','Document not found.');
  const endpoint=MALWARE_ENDPOINT.value(), key=MALWARE_API_KEY.value();
  if(!endpoint||!key) throw new HttpsError('failed-precondition','Malware scanner is not configured.');
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify({storagePath:doc.data().storagePath,sha256:doc.data().sha256||null})});
  if(!response.ok) throw new HttpsError('internal',`Scanner returned ${response.status}.`);
  const result=await response.json();
  await doc.ref.set({malwareStatus:result.clean?'CLEAN':'QUARANTINED',malwareScanAt:admin.firestore.FieldValue.serverTimestamp(),malwareEngine:text(result.engine,100)},{merge:true});
  await audit(projectId,request.auth.uid,'DOCUMENT_MALWARE_SCANNED',{documentId,clean:!!result.clean});
  return {clean:!!result.clean};
});

exports.indexPageToSearch = onDocumentWritten({document:'projects/{projectId}/pages/{pageId}',region:'us-central1',secrets:[SEARCH_ENDPOINT,SEARCH_API_KEY]}, async event => {
  const endpoint=SEARCH_ENDPOINT.value(), key=SEARCH_API_KEY.value();
  if(!endpoint||!key) return;
  const after=event.data.after.exists?event.data.after.data():null;
  const method=after?'PUT':'DELETE';
  const body=after?JSON.stringify({id:event.params.pageId,projectId:event.params.projectId,...after}):undefined;
  await fetch(`${endpoint.replace(/\/$/,'')}/documents/${encodeURIComponent(event.params.pageId)}`,{method,headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body});
});

exports.searchProjectIndex = onCall({region:'us-central1',secrets:[SEARCH_ENDPOINT,SEARCH_API_KEY],timeoutSeconds:30}, async request => {
  const {projectId,query,filters}=request.data||{};
  await member(request.auth?.uid,projectId);
  required(query,'query');
  const endpoint=SEARCH_ENDPOINT.value(), key=SEARCH_API_KEY.value();
  if(!endpoint||!key) throw new HttpsError('failed-precondition','Search service is not configured.');
  const response=await fetch(`${endpoint.replace(/\/$/,'')}/search`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify({projectId,query:text(query,500),filters:filters||{},limit:50})});
  if(!response.ok) throw new HttpsError('internal',`Search service returned ${response.status}.`);
  const result=await response.json();
  await audit(projectId,request.auth.uid,'DOCUMENT_SEARCHED',{query:text(query,500),resultCount:Array.isArray(result.hits)?result.hits.length:0});
  return result;
});
