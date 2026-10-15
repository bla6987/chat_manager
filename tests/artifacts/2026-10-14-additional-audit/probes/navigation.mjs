import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {buildIcicleData,reLayoutSubtree} from '/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/icicle-data.js';
import {resolveActiveChatFilename} from '/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/active-chat.js';
const base='/Users/macbookpro/projects/extensions/sillytavern/chat_manager/';
const viewSource=await readFile(base+'src/icicle-view.js','utf8');
const uiSource=await readFile(base+'src/ui-controller.js','utf8');
const raw=viewSource.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/^export /gm,'');
function entry(prefix,length=20){return {isLoaded:true,messages:Array.from({length},(_,i)=>({role:i%2?'user':'assistant',text:prefix+i,timestamp:null}))};}
let active='a.jsonl',index={};
const deps={buildIcicleData,reLayoutSubtree,getIndex:()=>index,getEmbeddingSettings:()=>({}),getDisplayName:x=>x,window:{removeEventListener(){}},document:{},console,setTimeout,clearTimeout,requestAnimationFrame:()=>1,cancelAnimationFrame(){},performance};
const api=new Function(...Object.keys(deps),raw+`;return {mountIcicle,updateIcicleData,focusMessageInIcicle,seed(data){mounted=true; canvas={}; canvasWidth=600;canvasHeight=400;icicleRoot=data.root;flatNodes=data.flatNodes;maxDepth=data.maxDepth;getActiveChatFile=()=>active;},setActiveGetter(fn){getActiveChatFile=fn;},snapshot(){return {mounted,canvas,pendingFocusRequest,flatNodes,container};}};`)(...Object.values(deps));
api.setActiveGetter(()=>active);
const container={innerHTML:'Loading…'};
await api.mountIcicle(container,'mini');
assert.equal(api.snapshot().mounted,false);
index['a.jsonl']=entry('alpha');
await api.updateIcicleData();
assert.equal(api.snapshot().flatNodes.length,0);
console.log('EMPTY HYDRATION:',JSON.stringify({mounted:api.snapshot().mounted,flatNodes:api.snapshot().flatNodes.length,html:container.innerHTML}));
index['b.jsonl']=entry('beta');
const focused=await buildIcicleData(index,active,{threadFocus:true});
api.seed(focused);
const focusedResult=api.focusMessageInIcicle('b.jsonl',5,{openPopup:false,persistIfMissing:false});
assert.equal(focusedResult,false);assert.equal(api.snapshot().pendingFocusRequest,null);
console.log('FILTERED FOCUS:',JSON.stringify({focusedResult,pending:api.snapshot().pendingFocusRequest,nodes:api.snapshot().flatNodes.length}));
const switchStart=uiSource.indexOf('async function safeSwitchChatFromJump(');
const switchSource=uiSource.slice(switchStart,uiSource.indexOf('\n/**\n * Parse an advanced',switchStart));
let opens=0,saveErrorToast=0;
const context={chatId:'old',saveChat:async()=>{try{throw Error('HTTP 500');}catch(err){saveErrorToast++;}},openCharacterChat:async target=>{opens++;context.chatId=target;}};
const safeSwitch=new Function('SillyTavern','resolveActiveChatFilename','toastr','console',`const MODULE_NAME='test';${switchSource};return safeSwitchChatFromJump;`)({getContext:()=>context},resolveActiveChatFilename,{warning(){}},console);
const switched=await safeSwitch('new.jsonl');assert.equal(switched,true);assert.equal(opens,1);assert.equal(saveErrorToast,1);
console.log('SWALLOWED SAVE FAILURE:',JSON.stringify({switched,opens,saveErrorToast}));
for(const n of [1000,2000,3000,4000,6000,8000]){
  const started=performance.now();
  try{const data=await buildIcicleData({'deep.jsonl':entry('m',n)},'deep.jsonl');console.log('DEEP',n,'OK',data.flatNodes.length,Math.round(performance.now()-started)+'ms');}
  catch(e){console.log('DEEP',n,e.name,e.message,e.stack.split('\n').slice(0,4).join(' | '));}
}
