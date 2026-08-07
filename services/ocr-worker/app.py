import os, tempfile, subprocess, requests
from flask import Flask, request, jsonify
from google.cloud import storage, firestore

app = Flask(__name__)
API_KEY = os.environ.get('OCR_KEY','')
BUCKET = os.environ.get('FIREBASE_BUCKET','')
storage_client = storage.Client()
firestore_client = firestore.Client()

def auth_ok(req):
    return bool(API_KEY) and req.headers.get('Authorization','') == f'Bearer {API_KEY}'

def download_pdf(data, pdf_path):
    if data.get('pdfUrl'):
        r=requests.get(data['pdfUrl'],timeout=60);r.raise_for_status()
        with open(pdf_path,'wb') as f:f.write(r.content)
        return
    path=data.get('storagePath')
    if not path or not BUCKET: raise ValueError('storagePath and FIREBASE_BUCKET are required')
    storage_client.bucket(BUCKET).blob(path).download_to_filename(pdf_path)

def ocr_page(pdf_path, td, page_no):
    base=os.path.join(td,f'page_{int(page_no)}')
    subprocess.run(['pdftoppm','-f',str(page_no),'-singlefile','-r','300','-png',pdf_path,base],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    img=base+'.png'; tsv=base+'.tsv'
    subprocess.run(['tesseract',img,base,'-l','eng','tsv'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    subprocess.run(['tesseract',img,base+'_txt','-l','eng'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    with open(base+'_txt.txt','r',encoding='utf-8',errors='ignore') as f:text=' '.join(f.read().split())
    conf=[]
    with open(tsv,'r',encoding='utf-8',errors='ignore') as f:
        next(f,None)
        for line in f:
            parts=line.rstrip('\n').split('\t')
            if len(parts)>10:
                try:
                    c=float(parts[10])
                    if c>=0:conf.append(c)
                except:pass
    return {'pageNumber':int(page_no),'text':text,'confidence':round(sum(conf)/len(conf),2) if conf else 0,'processingMethod':'TESSERACT_OCR','aiUsed':False}

@app.post('/ocr')
def ocr():
    if not auth_ok(request): return jsonify({'error':'unauthorized'}),401
    data=request.get_json(force=True) or {}
    if data.get('mode')!='CONVENTIONAL_OCR' or data.get('aiUsed') is not False:return jsonify({'error':'invalid mode'}),400
    pages=data.get('pages') or data.get('pageNumbers') or []
    project_id=str(data.get('projectId') or '')
    document_id=str(data.get('documentId') or '')
    if not pages or len(pages)>50:return jsonify({'error':'1-50 pages required'}),400
    try:
        with tempfile.TemporaryDirectory() as td:
            pdf_path=os.path.join(td,'input.pdf');download_pdf(data,pdf_path)
            results=[ocr_page(pdf_path,td,p) for p in pages]
        # When invoked with project/document IDs, write conventional OCR output directly back to Firestore.
        if project_id and document_id:
            batch=firestore_client.batch()
            for p in results:
                ref=firestore_client.document(f'projects/{project_id}/pages/{document_id}_{p["pageNumber"]}')
                batch.set(ref,{**p,'documentId':document_id,'status':'INDEXED_OCR'},merge=True)
            batch.commit()
            firestore_client.document(f'projects/{project_id}/documents/{document_id}').set({'lastOcrMethod':'TESSERACT_OCR','aiUsed':False},merge=True)
        return jsonify({'pages':results,'aiUsed':False})
    except Exception as e:
        return jsonify({'error':str(e),'aiUsed':False}),500

@app.get('/health')
def health():return jsonify({'ok':True,'engine':'tesseract','aiUsed':False})
