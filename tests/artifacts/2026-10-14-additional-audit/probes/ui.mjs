import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root='/Users/macbookpro/projects/extensions/sillytavern/chat_manager';
const meta=await import(root+'/src/metadata-store.js');
const reader=await import(root+'/src/chat-reader.js');
const stats=await import(root+'/src/stats-engine.js');
const context={characterId:0,characters:[{avatar:'alpha.png'}],extensionSettings:{},saveSettingsDebounced(){},openCharacterChat:async()=>{opens++;}};
let opens=0;
globalThis.SillyTavern={getContext:()=>context};
class El {
  constructor(tag='div'){this.tag=tag;this.className='';this.dataset={};this.children=[];this.listeners={};this.style={};this.value='';}
  addEventListener(k,f){(this.listeners[k]??=[]).push(f);}
  appendChild(el){el.parent=this;this.children.push(el);return el;}
  matches(s){return s[0]==='.'&&this.className.split(' ').includes(s.slice(1));}
  closest(s){return this.matches(s)?this:this.parent?.closest(s)||null;}
  querySelector(s){for(const c of this.children){if(c.matches(s))return c;const nested=c.querySelector(s);if(nested)return nested;}return null;}
  replaceWith(el){const p=this.parent;const i=p.children.indexOf(this);p.children[i]=el;el.parent=p;this.parent=null;}
  focus(){} select(){}
  blur(){this.dispatch('blur',false);}
  dispatch(k,bubble=true){let stop=false;const e={target:this,currentTarget:this,stopPropagation(){stop=true;},preventDefault(){}};for(let p=this;p;p=bubble&&!stop?p.parent:null){e.currentTarget=p;for(const f of p.listeners[k]||[])f(e);}}
}
const nodes=new Map([['chat-manager-content',new El()],['chat-manager-status',new El()]]);
const sandbox={console,Map,Set,WeakMap,WeakSet,Promise,setTimeout,clearTimeout,SillyTavern:globalThis.SillyTavern,document:{createElement:t=>new El(t),getElementById:id=>nodes.get(id)||null},getDisplayName:meta.getDisplayName,setDisplayName:meta.setDisplayName,getDisplayMode:meta.getDisplayMode};
vm.createContext(sandbox);
let source=fs.readFileSync(root+'/src/ui-controller.js','utf8').replace(/^import[\s\S]*?;\n/gm,'').replace(/^export /gm,'');
vm.runInContext(source,sandbox);
vm.runInContext("getActiveFilename=()=> 'active.jsonl';",sandbox);
const container=new El();sandbox.bindCardEvents(container);
const card=container.appendChild(new El());card.className='chat-manager-card';
let name=card.appendChild(new El('span'));name.className='chat-manager-display-name';name.dataset.filename='target.jsonl';
const button=card.appendChild(new El('i'));button.dataset.filename='target.jsonl';
meta.setDisplayName('target.jsonl','Old title');
sandbox.handleEditDisplayName({currentTarget:button,stopPropagation(){}});
card.children[0].value='';card.children[0].blur();
assert.equal(meta.getDisplayName('target.jsonl'),'Old title');
assert.equal(card.children[0].textContent,'target.jsonl');
console.log('TITLE CLEAR: visible title=target.jsonl; saved title=Old title');
card.children[0].dispatch('click');
assert.equal(opens,2);
console.log('EDITED TITLE CLICK: one bubbling click called openCharacterChat twice');

let release;
sandbox.pendingEmbedding=new Promise(r=>release=r);
sandbox.paint=[];
vm.runInContext("shouldUseSemanticSearch=()=>true; getSemanticQueryEmbedding=()=>pendingEmbedding; getSearchableMessages=()=>[]; getIndex=()=>({}); getEmbeddingSettings=()=>({}); renderSearchState=()=>paint.push('semantic-results'); renderThreadCards=()=>paint.push('thread-list'); setSearchModeBadge=()=>{}; _getFilterToolbar=()=>null;",sandbox);
const pending=sandbox.performSearch('swords');
sandbox.onSearchInput('');
assert.deepEqual(sandbox.paint,['thread-list']);
release([1]);await pending;
assert.deepEqual(sandbox.paint,['thread-list','semantic-results']);
console.log('SEARCH CLEAR RACE: thread-list was overwritten by stale semantic-results');

reader.clearIndex();
for(const [f,ts] of [['previous-evening','2026-10-13T21:00:00-04:00'],['selected-morning','2026-10-14T09:00:00-04:00'],['selected-evening','2026-10-14T21:00:00-04:00']]){
  reader.getIndex()[f]={fileName:f,lastTimestampMs:new Date(ts).getTime(),sortTimestamp:new Date(ts).getTime(),messageCount:1};
}
const matches=reader.getFilteredSortedEntries({tags:[],dateFrom:'2026-10-14',dateTo:'2026-10-14'},{field:'recency',direction:'asc'},()=>({})).map(e=>e.fileName);
assert.deepEqual(matches,['previous-evening','selected-morning']);
console.log('LOCAL DATE FILTER: Oct 14 matches='+JSON.stringify(matches)+'; excludes selected-evening');

stats.clearStatsCache();
const legacy=stats.computeHeatmapData({legacy:{fileName:'legacy',isLoaded:true,messages:[{timestamp:'2024-07-12@01h31m37s123ms',role:'assistant'}]}},1);
assert.equal(legacy.dayCounts.size,0);
assert.equal(legacy.isComplete,true);
console.log('LEGACY TIMESTAMP: fully loaded chat with host-supported humanized timestamp produces empty heatmap');

let renames=0;
context.Popup=class{async show(){return 1;}};
context.POPUP_TYPE={CONFIRM:1};context.POPUP_RESULT={AFFIRMATIVE:1};context.renameChat=async()=>renames++;
sandbox.toastr={info(){},error(){},warning(){},success(){}};
await sandbox.handleRenameFile({stopPropagation(){},currentTarget:{dataset:{filename:'target.jsonl'}}});
assert.equal(renames,0);
console.log('KNOWN RENAME BUG: affirmative confirmation with removed dialog calls renameChat zero times');
