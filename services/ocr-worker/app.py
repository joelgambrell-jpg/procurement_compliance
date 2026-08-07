import os, tempfile, subprocess, requests
from flask import Flask, request, jsonify

app = Flask(__name__)
API_KEY = os.environ.get('OCR_KEY','')

def auth_ok(req):
    return bool(API_KEY) and req.headers.get('Authorization','') == f'Bearer {API_KEY}'

@app.post('/ocr')
def ocr():
    if not auth_ok(request):
        return jsonify({'error':'unauthorized'}), 401
    data = request.get_json(force=True) or {}
    if data.get('mode') != 'CONVENTIONAL_OCR' or data.get('aiUsed') is not False:
        return jsonify({'error':'invalid mode'}), 400
    url = data.get('pdfUrl')
    pages = data.get('pageNumbers') or []
    if not url or not pages or len(pages) > 50:
        return jsonify({'error':'pdfUrl and 1-50 pageNumbers required'}), 400

    with tempfile.TemporaryDirectory() as td:
        pdf_path = os.path.join(td,'input.pdf')
        r = requests.get(url, timeout=60)
        r.raise_for_status()
        with open(pdf_path,'wb') as f: f.write(r.content)
        results=[]
        for page_no in pages:
            base=os.path.join(td,f'page_{int(page_no)}')
            # pdftoppm is conventional PDF rasterization; page numbers are 1-based.
            subprocess.run(['pdftoppm','-f',str(page_no),'-singlefile','-r','300','-png',pdf_path,base],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            img=base+'.png'
            tsv=base+'.tsv'
            subprocess.run(['tesseract',img,base,'-l','eng','tsv'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            subprocess.run(['tesseract',img,base+'_txt','-l','eng'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            with open(base+'_txt.txt','r',encoding='utf-8',errors='ignore') as f: text=' '.join(f.read().split())
            conf=[]
            with open(tsv,'r',encoding='utf-8',errors='ignore') as f:
                next(f,None)
                for line in f:
                    parts=line.rstrip('\n').split('\t')
                    if len(parts)>10:
                        try:
                            c=float(parts[10])
                            if c>=0: conf.append(c)
                        except: pass
            confidence=round(sum(conf)/len(conf),2) if conf else 0
            results.append({'pageNumber':int(page_no),'text':text,'confidence':confidence,'processingMethod':'TESSERACT_OCR','aiUsed':False})
        return jsonify({'pages':results,'aiUsed':False})

@app.get('/health')
def health():
    return jsonify({'ok':True,'engine':'tesseract','aiUsed':False})
