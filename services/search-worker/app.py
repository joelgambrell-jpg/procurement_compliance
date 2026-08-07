import os, re
from flask import Flask, request, jsonify
from meilisearch import Client

app=Flask(__name__)
API_KEY=os.environ.get('SEARCH_GATEWAY_KEY','')
MEILI_URL=os.environ.get('MEILI_URL','http://meilisearch:7700')
MEILI_KEY=os.environ.get('MEILI_MASTER_KEY','')
client=Client(MEILI_URL,MEILI_KEY)
INDEX='project_pages'

def auth_ok(req):
    return bool(API_KEY) and req.headers.get('Authorization','')==f'Bearer {API_KEY}'

def ensure_index():
    try: client.get_index(INDEX)
    except: client.create_index(INDEX,{'primaryKey':'id'})
    idx=client.index(INDEX)
    idx.update_filterable_attributes(['projectId','documentId','documentName','revision','current','status','pageNumber','section'])
    idx.update_searchable_attributes(['text','section','documentName'])
    return idx

@app.post('/index')
def index_records():
    if not auth_ok(request): return jsonify({'error':'unauthorized'}),401
    data=request.get_json(force=True) or {}
    project_id=str(data.get('projectId') or '')
    records=data.get('records') or []
    if not project_id: return jsonify({'error':'projectId required'}),400
    safe=[]
    for r in records:
        if str(r.get('projectId'))!=project_id: continue
        safe.append({k:r.get(k) for k in ['id','projectId','documentId','documentName','revision','current','pageNumber','section','text','status']})
    task=ensure_index().add_documents(safe)
    return jsonify({'accepted':len(safe),'taskUid':getattr(task,'task_uid',None) or task.get('taskUid')})

@app.post('/search')
def search():
    if not auth_ok(request): return jsonify({'error':'unauthorized'}),401
    data=request.get_json(force=True) or {}
    project_id=str(data.get('projectId') or '')
    query=str(data.get('query') or '').strip()
    filters=data.get('filters') or {}
    if not project_id or len(query)<2: return jsonify({'error':'projectId and query required'}),400
    clauses=[f'projectId = "{project_id.replace(chr(34),"")}"']
    if filters.get('currentOnly',True): clauses.append('current = true')
    if filters.get('documentId'): clauses.append(f'documentId = "{str(filters["documentId"]).replace(chr(34),"")}"')
    if filters.get('status'): clauses.append(f'status = "{str(filters["status"]).replace(chr(34),"")}"')
    result=ensure_index().search(query,{'filter':' AND '.join(clauses),'limit':min(int(data.get('limit') or 50),50),'attributesToHighlight':['text'],'highlightPreTag':'<mark>','highlightPostTag':'</mark>'})
    hits=[]
    for h in result.get('hits',[]):
        hits.append({k:h.get(k) for k in ['id','documentId','documentName','revision','pageNumber','section','text','status']})
    return jsonify({'query':query,'hits':hits,'estimatedTotalHits':result.get('estimatedTotalHits',len(hits))})

@app.get('/health')
def health(): return jsonify({'ok':True,'engine':'meilisearch','aiUsed':False})
