# NEXUS Procurement Compliance

A project-specific electrical parts compliance system with citation-first CCR results.

## Security boundary

- Customer documents are never processed by AI.
- Digital PDFs are parsed with conventional PDF text extraction.
- Image-only pages are marked `OCR_REQUIRED`; connect a self-hosted Tesseract/Cloud Run OCR service if needed.
- Every CCR must retain document name, section/paragraph, PDF page, and source passage.
- Optional AI is restricted to public supplier/manufacturer research using sanitized technical criteria.
- The supplier function has no code path to retrieve document/page collections.

## Firebase setup

1. Run `firebase use --add` and choose the existing Firebase project.
2. From `functions/`, run `npm install`.
3. Deploy rules and functions with `firebase deploy --only firestore:rules,storage,functions`.
4. Set approved supplier provider secrets:
   - `firebase functions:secrets:set SUPPLIER_AI_ENDPOINT`
   - `firebase functions:secrets:set SUPPLIER_AI_KEY`
5. Set each project field `supplierAiPolicy` to either `disabled` or `public_only`.

## Storage path

Upload PDFs to `projects/{projectId}/documents/{filename}.pdf`.

## Current limitation

The browser page still uses local storage until the existing Firebase web configuration and collection naming are connected. The backend files establish the non-AI processing boundary and isolated supplier-search service without placing secrets in GitHub.
