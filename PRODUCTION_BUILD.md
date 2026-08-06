# Procurement Compliance Production Build

Customer documents remain non-AI. OCR, search, rules, evidence validation, and approvals are deterministic services.

## Implemented Firebase functions

- `saveVerifiedCcr` — validates mandatory citations and versions every CCR change.
- `setDocumentRevision` — records revision/precedence and places affected CCRs into review when a document is superseded.
- `evaluatePart` — deterministic PASS/FAIL/REVIEW comparison.
- `saveEvidencePackage` / `verifyEvidencePackage` — requires technical and purchase sources.
- `assignProjectRole` — admin-controlled project roles.
- `requestConventionalOcr` — calls a conventional OCR worker with `aiUsed:false`.
- `indexPageToSearch` / `searchProjectIndex` — isolated external full-text search adapter.
- `scanUploadedDocument` — malware scanner adapter.
- Existing `searchPublicSuppliers` — isolated public supplier research with source and purchase-link enforcement.

## Required secrets

```bash
firebase functions:secrets:set OCR_ENDPOINT
firebase functions:secrets:set OCR_API_KEY
firebase functions:secrets:set SEARCH_ENDPOINT
firebase functions:secrets:set SEARCH_API_KEY
firebase functions:secrets:set MALWARE_ENDPOINT
firebase functions:secrets:set MALWARE_API_KEY
firebase functions:secrets:set SUPPLIER_AI_ENDPOINT
firebase functions:secrets:set SUPPLIER_AI_KEY
```

## Conventional OCR worker contract

Request:

```json
{
  "projectId": "internal-id",
  "documentId": "document-id",
  "storagePath": "projects/.../documents/file.pdf",
  "pages": [2, 4],
  "mode": "CONVENTIONAL_OCR",
  "aiUsed": false
}
```

The worker must use a conventional engine such as Tesseract/OCRmyPDF and write page text back through an authenticated service account. It must return page number, text, word confidence, and bounding boxes. Do not configure a generative document service.

## Search service contract

The adapter supports Typesense, Meilisearch, OpenSearch, or a custom PostgreSQL full-text gateway.

- `PUT /documents/{pageId}` indexes one page.
- `DELETE /documents/{pageId}` removes it.
- `POST /search` accepts `{projectId, query, filters, limit}`.

The search service must enforce `projectId` as a mandatory server-side filter. Never rely only on a client filter.

## Supplier provider contract

The provider must return exact manufacturer part numbers, official technical evidence URLs, and at least one real purchase source URL. Price and availability must include a checked date. Results remain `CANDIDATE_VERIFY` until evidence review.

## Malware service contract

Request:

```json
{"storagePath":"projects/.../documents/file.pdf","sha256":"optional hash"}
```

Response:

```json
{"clean":true,"engine":"ClamAV","signatureVersion":"..."}
```

Production upload workflow must quarantine new files until this result is `clean:true`. The existing PDF trigger should not be enabled on production documents until the quarantine gate is wired into the upload path.

## Roles

- `admin` — users, policy, projects, all approvals.
- `engineer` — documents, verified CCRs, technical approval.
- `procurement` — vendors, sourcing, evidence entry.
- `reviewer` — evidence and compliance review.
- `viewer` — read-only.

## Required deployment sequence

1. Configure Firebase project and secrets.
2. Deploy Firestore and Storage rules.
3. Deploy conventional OCR, search, and malware workers.
4. Deploy Firebase Functions.
5. Add the client Firebase callable-function integration.
6. Upload a controlled test package with known answers.
7. Verify exact citations, superseded-document review, deterministic failures, and immutable audit history.

## Production gate

Do not authorize real purchasing until all of these pass:

- Uploaded file malware status is `CLEAN`.
- Every searchable page is `INDEXED` or reviewed OCR output.
- Every CCR has document, revision, section, page, and exact source text.
- Every product fact used for approval has verified evidence.
- Every applicable CCR is PASS.
- No source is superseded or under review.
- Final approval is performed by an authorized role.
