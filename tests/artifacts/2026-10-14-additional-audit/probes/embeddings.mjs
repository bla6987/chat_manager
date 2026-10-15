import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const root='/Users/macbookpro/projects/extensions/sillytavern/chat_manager';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const settings={enabled:true,provider:'ollama',model:'same-model',ollamaUrl:'http://synthetic-server-a',dimensions:null,embeddingLevels:{chat:false,message:true,query:true},scopeMode:'all',includeAlternateSwipes:true};
const store=new Map();
const context={characterId:0,characters:[{avatar:'synthetic.png'}],extensionSettings:{chat_manager:{embeddings:settings,metadata:{}}},saveSettingsDebounced(){}};
globalThis.SillyTavern={getContext:()=>context,libs:{localforage:{createInstance:()=>({getItem:async k=>store.get(k)??null,setItem:async(k,v)=>{store.set(k,v);return v;},clear:async()=>store.clear()})}}};
globalThis.window={confirm:()=>false};
const service=await import(`${root}/src/embedding-service.js`);
let calls=[];
globalThis.fetch=async(url,opts)=>{calls.push(url);return {ok:true,text:async()=>JSON.stringify({embeddings:JSON.parse(opts.body).input.map(()=>[1,0])})};};
const a=await service.embedText('same synthetic text',{level:'message'});
settings.ollamaUrl='http://synthetic-server-b';
const b=await service.embedText('same synthetic text',{level:'message'});
assert.deepEqual(b,a); assert.equal(calls.length,1);
console.log('NEW endpoint identity: changing Ollama server reused A vector; provider calls =',calls.length);

await service.clearEmbeddingCache(); settings.dimensions=null;
let release=deferred(), entered=deferred();
settings.model='model-a';
globalThis.fetch=async(url,opts)=>{calls.push(JSON.parse(opts.body).model);entered.resolve();await release.promise;return {ok:true,text:async()=>JSON.stringify({embeddings:[[1,0]]})};};
const pending=service.embedText('in flight synthetic',{level:'message'}); await entered.promise;
settings.model='model-b';await service.clearEmbeddingCache();release.resolve();await pending;
assert.equal(store.get(service.hashEmbeddingText('in flight synthetic')).model,'model-b');
console.log('PRIOR-KNOWN recipe race: model-a response persisted as model-b after clear.');

// UI module uses its actual orchestration functions with rendering replaced.
const reader=await import(`${root}/src/chat-reader.js`);
const source=(await readFile(`${root}/src/ui-controller.js`,'utf8')).replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/^export /gm,'');
let index={}, rendered=[], queryGate=null;
const doc={getElementById:id=>id==='chat-manager-content'?{}:null};
const deps={...reader,...service,getIndex:()=>index,getEmbeddingSettings:()=>settings,getSelectedEmbeddingChats:()=>[],getRepresentativeEmbeddingText:()=>'',getCachedEmbeddingsForTexts:async texts=>texts.map(()=>null),isEmbeddingConfigured:()=>true,embedText:async()=>queryGate?queryGate.promise:[1,0],getSearchableMessages:()=>Object.values(index).flatMap(e=>e.messages),cosineSimilarity:(x,y)=>x.reduce((n,v,i)=>n+v*y[i],0),document:doc};
const ui=new Function(...Object.keys(deps),`${source}
renderThreadCards=()=>{rendered.push('cards')};
renderSearchState=()=>{rendered.push(searchState.query)};
setSearchModeBadge=()=>{};
return {runEmbeddingGeneration,performSearch,performSemanticSearch,renderSearchPage,
snap:()=>({searchState,latestSearchRequestId,pending:pendingBackgroundSwipeCandidates.size}),threadNeedsEmbeddings};`)(...Object.values(deps));
// Function's renderer needs synthetic output array as global binding.
globalThis.rendered=rendered;
const msg={filename:'a.jsonl',index:0,role:'assistant',text:'active unrelated answer',swipes:['active unrelated answer','alternate treasure answer'],swipeId:0};
const entry={fileName:'a.jsonl',isLoaded:true,messages:[msg],chatEmbedding:null,messageEmbeddings:new Map([['m:0:s:0',[0,1]]])};
index={'a.jsonl':entry};
const result=await ui.runEmbeddingGeneration(null,{rerender:false});
assert.equal(result.skipped,true);assert.equal(ui.snap().pending,0);assert.equal(ui.threadNeedsEmbeddings('a.jsonl'),false);
console.log('NEW alternate-only work: missing alternate vector, run skipped, queue size 0, threadNeedsEmbeddings false.');

index['b.jsonl']={fileName:'b.jsonl',isLoaded:true,messages:[{filename:'b.jsonl',index:0,role:'user',text:'treasure exact match'}],messageEmbeddings:null};
await ui.performSearch('treasure');
assert.equal(ui.snap().searchState.mode,'semantic');
assert.equal(ui.snap().searchState.results.some(r=>r.item.filename==='b.jsonl'),false);
console.log('NEW partial-embedding hybrid search: exact keyword match in b.jsonl excluded; mode = semantic.');

queryGate=deferred();const search=ui.performSearch('pending treasure');await Promise.resolve();
await ui.performSearch('');assert.equal(rendered.at(-1),'cards');
queryGate.resolve([1,0]);await search;
assert.equal(rendered.at(-1),'pending treasure');
console.log('NEW clear-search race: cleared query rendered cards, old semantic request then rendered pending treasure.');

// Response points to an alternate, while result.item remains the active text.
queryGate=null; index={'a.jsonl':entry};settings.showAlternateSwipesInResults=true;
reader.setMessageEmbedding(entry,0,1,[1,0]);await ui.performSearch('treasure');
const hit=ui.snap().searchState.results[0];assert.equal(hit.matchedSwipeIndex,1);assert.equal(hit.item.text,'active unrelated answer');
console.log('NEW alternate excerpt mismatch: matched swipe 1; displayed item.text =',hit.item.text);

// Batch support is turned off permanently even for a transient server error.
await service.clearEmbeddingCache();settings.dimensions=null;settings.model='transient-model';calls=[];
globalThis.fetch=async(url,opts)=>{calls.push(url);if(url.endsWith('/api/embed'))return {ok:false,status:503,statusText:'Unavailable',text:async()=>''};return {ok:true,text:async()=>JSON.stringify({embedding:[1,0]})};};
await service.embedTexts(['t1','t2','t3'],{level:'message'});
globalThis.fetch=async(url,opts)=>{calls.push(url);return {ok:true,text:async()=>JSON.stringify(url.endsWith('/api/embed')?{embeddings:JSON.parse(opts.body).input.map(()=>[1,0])}:{embedding:[1,0]})};};
await service.embedTexts(['t4','t5','t6'],{level:'message'});
assert.equal(calls.filter(x=>x.endsWith('/api/embed')).length,1);assert.equal(calls.length,7);
console.log('NEW transient fallback: one HTTP 503 caused 6 single calls; healthy second batch never retried /api/embed.');
