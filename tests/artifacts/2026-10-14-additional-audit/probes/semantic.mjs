import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root='/Users/macbookpro/projects/extensions/sillytavern/chat_manager/';
function load(file,tail,globals={}) {
 const src=fs.readFileSync(root+file,'utf8').replace(/^import .*;$/gm,'').replace(/^export /gm,'');
 const context=vm.createContext({console,Float32Array,Float64Array,Uint16Array,Uint32Array,ArrayBuffer,Map,Set,Math,Number,requestAnimationFrame:()=>1,cancelAnimationFrame(){},setTimeout,clearTimeout,...globals});
 vm.runInContext(src+'\n'+tail,context,{filename:file});return context;
}
// Actual worker projection, without live worker/provider.
const outputs=[];
const w=load('src/semantic-map-worker.js','',{self:{postMessage:m=>outputs.push(m)}});
function project(rows) { const data=new Float32Array(rows.flat()); w.self.onmessage({data:{type:'buildMapData',jobId:1,vectorsFlatBuffer:data.buffer,dims:rows[0].length,fixedK:2}});return Array.from(new Float32Array(outputs.at(-1).points2dBuffer)); }
const collapsed=project([[0,-2,-1],[0,-2,1],[0,2,-1],[0,2,1]]);
assert(collapsed.every(x=>x===0));
const duplicateAxes=project([[-2,-1],[-2,1],[2,-1],[2,1]]);
assert(duplicateAxes.every((x,i)=> i%2 || x===duplicateAxes[i+1]));
console.log('PCA constant e0 ->',collapsed,'diagonal covariance ->',duplicateAxes);
// Instrument setup/render boundaries only; production mount/update/query/event handlers intact.
const stubs=`
let calls={bind:0,resize:0,observer:0};
createCanvas=()=>{canvas={};}; createOverlay=()=>{}; showLoading=hideLoading=showEmpty=hideEmpty=setInfo=queueRender=rebuildRenderBuffers=()=>{};

bindEvents=()=>calls.bind++; resizeCanvas=()=>calls.resize++; collectMessageVectors=()=>({count:fixtureCount,dims:2,vectorsFlat:new Float32Array(fixtureCount*2),refs:[],lookup:new Map()});
globalThis.api={mountSemanticMap,updateSemanticMapData,runSemanticQuery,bindOverlayEvents,handleQueryScoresReady,get:()=>({calls,scoreValues,queryText,workerScoreJobId}),setup:()=>{mounted=true;ensureWorker();},clear:()=>{let handler;clearBtnEl={addEventListener:(type,fn)=>handler=fn};bindOverlayEvents();handler();},deliver:m=>worker.onmessage({data:m})};`;
const sent=[];
const s=load('src/semantic-map-view.js',stubs,{fixtureCount:0,sent,Worker:class{postMessage(m){sent.push(m)}},getIndex:()=>({}),getEmbeddingSettings:()=>({}),isEmbeddingConfigured:()=>true,embedText:async()=>[1,0]});
await s.api.mountSemanticMap({innerHTML:'',style:{}});
s.fixtureCount=2; await s.api.updateSemanticMapData();
assert.equal(s.api.get().calls.bind,0);assert.equal(s.api.get().calls.resize,0);
console.log('Semantic mount empty then update:',JSON.stringify(s.api.get().calls));
s.api.setup();await s.api.runSemanticQuery('first');const id=sent.at(-1).jobId;s.api.clear();assert.equal(s.api.get().workerScoreJobId,id);
// Actual worker callback acceptance condition is msg.jobId === workerScoreJobId.
s.api.deliver({type:'queryScoresReady',jobId:id,scoresBuffer:new Float32Array([0.8,0.1]).buffer,min:0.1,max:0.8});
assert.equal(s.api.get().queryText,'');assert.equal(s.api.get().scoreValues.length,2);
console.log('Clear kept score job id',id,'and late result restored',Array.from(s.api.get().scoreValues));
// Graph actual async insertion, collection, pins and simulation building.
const deferred=[];
const g=load('src/graph-view.js',`
let calls={bind:0,resize:0,observer:0};
createCanvas=()=>{canvas={};};createOverlay=()=>{};
showLoading=hideLoading=showEmpty=hideEmpty=setInfo=queueRender=autoFitCamera=()=>{};
bindEvents=()=>calls.bind++;resizeCanvas=()=>calls.resize++;bindResizeObserver=()=>calls.observer++;
startSimulation=()=>{simRunning=true;};
globalThis.api={mountGraphView,updateGraphViewData,addSearchTermPin,addMessagePin,clearAllPins,setGraphScope,get:()=>({calls,pins,simNodes,messageRefs,simRunning}),settle:()=>simRunning=false};`,{getIndex:()=>gIndex,getEmbeddingSettings:()=>({}),getDisplayName:x=>x,getMessageActiveSwipeIndex:()=>0,getMessageEmbedding:(entry,msg)=>entry.messageEmbeddings.get(msg.index),isEmbeddingConfigured:()=>true,embedText:()=>new Promise(resolve=>deferred.push(resolve)),clusterColor:()=>'',selectTopStable:(items,k)=>items.sort((a,b)=>b.similarity-a.similarity).slice(0,k)});
let gIndex={};await g.api.mountGraphView({innerHTML:'',style:{}});
function entry(name,vector) {return {isLoaded:true,messages:[{index:0,text:name,role:'assistant'}],messageEmbeddings:new Map([[0,vector]])};}
gIndex={a:entry('Alpha',[1,0]),b:entry('Beta',[0,1]),c:entry('Gamma',[1,1])};g.api.updateGraphViewData();
assert.equal(g.api.get().calls.bind,0);assert.equal(g.api.get().calls.resize,0);assert.equal(g.api.get().calls.observer,0);
console.log('Graph mount empty then update:',JSON.stringify(g.api.get().calls));
const pending=g.api.addSearchTermPin('pending');g.api.clearAllPins();deferred.shift()([1,0]);await pending;assert.equal(g.api.get().pins.length,1);
console.log('Clear while embedding -> late pins',g.api.get().pins.length);
g.api.clearAllPins();g.api.addMessagePin(1);assert.equal(g.api.get().pins[0].label,'Beta');
g.api.setGraphScope(()=>new Set(['b','c']));g.api.updateGraphViewData();
const state=g.api.get();assert.equal(state.pins[0].label,'Beta');assert.equal(state.messageRefs[state.pins[0].msgRefIndex].text,'Gamma');
assert(state.simNodes.some(n=>!n.isPin&&state.messageRefs[n.msgRefIndex].text==='Beta'));
assert(!state.simNodes.some(n=>!n.isPin&&state.messageRefs[n.msgRefIndex].text==='Gamma'));
console.log('Pin Beta index after scope ->',state.messageRefs[state.pins[0].msgRefIndex].text,'neighbors',state.simNodes.filter(n=>!n.isPin).map(n=>state.messageRefs[n.msgRefIndex].text));
g.api.settle();g.api.updateGraphViewData();assert.equal(g.api.get().simRunning,false);assert(g.api.get().simNodes.length>1);
console.log('Settled graph after rebuild simRunning:',g.api.get().simRunning,'nodes:',g.api.get().simNodes.length);
g.api.clearAllPins();const many=Array.from({length:10},()=>g.api.addSearchTermPin('same term'));assert.equal(deferred.length,10);for(const resolve of deferred.splice(0))resolve([1,0]);await Promise.all(many);assert.equal(g.api.get().pins.length,10);
console.log('10 duplicate concurrent pin requests ->',g.api.get().pins.length,'pins (MAX_PINS=8)');

const neg=load('src/graph-view.js',`
messageRefs=[{fileName:'opposite',msgIndex:0,text:'Opposite'}];messageVectors=[[-1,0]];messageNorms=[1];messageDims=2;
pins=[{kind:'term',label:'Opposed',vector:[1,0],vectorNorm:1,colorIndex:0,x:0,y:0,msgRefIndex:null}];
queueRender=()=>{};rebuildSimulation();camera.zoom=0.5;
ctx={beginPath(){},arc(x,y,r){if(r<0)throw new Error('IndexSizeError: negative radius '+r)},fill(){}};
globalThis.probe=()=>drawNeighborNodes();globalThis.sim=simNodes[1].similarity;
`,{selectTopStable:(x,k)=>x.slice(0,k)});
assert.equal(neg.sim,-1);assert.throws(neg.probe,/negative radius -1/);
console.log('Opposed vectors -> similarity',neg.sim,'-> negative Canvas arc radius -1 (render throws)');
const hit=load('src/semantic-map-view.js',`
points2d=new Float32Array([0.4999,0.5]);messageRefs=[{}];bounds={minX:0,maxX:1,minY:0,maxY:1};
canvasWidth=500;canvasHeight=500;camera.x=0;camera.y=0;camera.w=1;camera.h=1;buildGridIndex();
globalThis.probe=()=>hitTestPoint(259.5,250);
`);
assert.equal(hit.probe(),-1);
console.log('Map hit-test at point 9.55px away (inside 10px threshold) ->',hit.probe(),'due to fixed adjacent-cell scan');
