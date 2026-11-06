import test from 'node:test';
import assert from 'node:assert/strict';
import {generateTitleForChat} from '../src/ai-features.js';
function setup(){
 const state={api:'custom',url:'https://original.invalid',model:'original-model',secret:'original-secret',calls:0};
 const context={characterId:0,characters:[{avatar:'test.png'}],onlineStatus:'connected',saveSettingsDebounced(){},
  extensionSettings:{chat_manager:{aiConnectionProfile:'ai'},connectionManager:{selectedProfile:null,profiles:[{id:'ai',name:'AI'}]}}};
 const fields={api:'api','api-url':'url',model:'model','secret-id':'secret'};
 context.SlashCommandParser={commands:Object.fromEntries(Object.entries(fields).map(([name,key])=>[name,{callback:async(_args,value)=>{if(value)state[key]=value;return state[key];}}]))};
 context.SlashCommandParser.commands.profile={callback:async(_args,name)=>{context.extensionSettings.connectionManager.selectedProfile=name==='<None>'?null:'ai';if(name!=='<None>'){state.url='https://temporary.invalid';state.model='temporary-model';state.secret='temporary-secret';}return name;}};
 context.generateRaw=async()=>{state.calls++;return 'Title';};
 globalThis.SillyTavern={getContext:()=>context};globalThis.window={};return {state,context};
}
test('AI profile restores a manual endpoint, model and credential together',async()=>{
 const r=setup();await generateTitleForChat([{role:'user',text:'story'}],'Character');
 assert.equal(r.state.calls,1);assert.equal(r.state.url,'https://original.invalid');assert.equal(r.state.model,'original-model');assert.equal(r.state.secret,'original-secret');
 assert.equal(r.context.extensionSettings.connectionManager.selectedProfile,null);
});
test('identical independent AI requests each record their usage',async()=>{
 const r=setup();r.context.extensionSettings.chat_manager.aiConnectionProfile='';let records=0;
 window.TokenUsageTracker={countTokens:async()=>10,getCurrentModelId:()=>r.state.model,getCurrentSourceId:()=>r.state.api,recordUsage(){records++;}};
 for(let i=0;i<2;i++) await generateTitleForChat([{role:'user',text:'same story'}],'Character');
 assert.equal(r.state.calls,2);assert.equal(records,2);
});
