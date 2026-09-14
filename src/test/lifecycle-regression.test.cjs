const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const e=require('../engine.cjs');
const revision={model:'gpt-5.6-sol',reasoning_effort:'high',reason:'Fresh retry after confirmed failure'};
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-orch-regression-'));
  const db=e.openDb(path.join(dir,'state.sqlite'));
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const run=e.createRun(db,{objective:'Lifecycle regression',cwd:dir,steps:[{id:'step',task:'Read only',model:'gpt-5.6-sol',reasoning_effort:'high',reason:'Review',depends_on:[],read_paths:[],write_paths:[],acceptance:['Checked']}]},'parent');
  const start=(call,agent)=>{e.reserve(db,e.prepare(db,run.id,'step'),'parent',call);e.bind(db,run.id,'step',agent,call);};
  const result=(call,agent,verified=true)=>({call_id:call,agent_id:agent,summary:'Checked result',verified,evidence:['Parent checked'],changed_files:[]});
  return {db,run,start,result};
}
test('a stale report cannot settle a newer attempt',t=>{
  const {db,run,start,result}=fixture(t);
  start('call-1','old-agent');e.report(db,run.id,'step',result('call-1','old-agent',false));e.markClosed(db,'old-agent');
  e.retry(db,run.id,'step',revision);start('call-2','new-agent');
  assert.throws(()=>e.report(db,run.id,'step',result('call-1','old-agent')),/attempt|agent|call/i);
  assert.equal(e.getRun(db,run.id).steps[0].status,'running');
});
test('a reported failure cannot be overwritten as success',t=>{
  const {db,run,start,result}=fixture(t);start('call','agent');
  e.report(db,run.id,'step',result('call','agent',false));
  assert.throws(()=>e.report(db,run.id,'step',result('call','agent')),/running|terminal|open/i);
});
test('a closed attempt cannot accept a late report',t=>{
  const {db,run,start,result}=fixture(t);start('call','agent');e.markClosed(db,'agent');
  assert.throws(()=>e.report(db,run.id,'step',result('call','agent')),/running|terminal|open/i);
});
test('bind rejects a spawn response with a different tool call ID',t=>{
  const {db,run}=fixture(t);e.reserve(db,e.prepare(db,run.id,'step'),'parent','reserved');
  assert.throws(()=>e.bind(db,run.id,'step','wrong-agent','different'),/call|reservation/i);
  assert.equal(e.getRun(db,run.id).steps[0].agent_id,null);
});
test('retry rejects extra fields instead of corrupting event metadata',t=>{
  const {db,run,start,result}=fixture(t);start('call','agent');
  e.report(db,run.id,'step',result('call','agent',false));e.markClosed(db,'agent');
  assert.throws(()=>e.retry(db,run.id,'step',{...revision,type:'forged',step:'wrong'}),/field/i);
});
test('a stale failure cannot fail the current attempt',t=>{
  const {db,run,start,result}=fixture(t);start('old-call','old-agent');
  e.report(db,run.id,'step',result('old-call','old-agent',false));e.markClosed(db,'old-agent');
  e.retry(db,run.id,'step',revision);start('new-call','new-agent');
  assert.throws(()=>e.fail(db,run.id,'step','Late failure','old-call'),/call|attempt/i);
  assert.equal(e.getRun(db,run.id).steps[0].status,'running');
});
test('retry cannot reuse an earlier call ID',t=>{
  const {db,run,start,result}=fixture(t);start('old-call','old-agent');
  e.report(db,run.id,'step',result('old-call','old-agent',false));e.markClosed(db,'old-agent');
  e.retry(db,run.id,'step',revision);
  assert.throws(()=>e.reserve(db,e.prepare(db,run.id,'step'),'parent','old-call'),/call|used/i);
});
test('retry cannot bind an earlier agent ID',t=>{
  const {db,run,start,result}=fixture(t);start('old-call','old-agent');
  e.report(db,run.id,'step',result('old-call','old-agent',false));e.markClosed(db,'old-agent');
  e.retry(db,run.id,'step',revision);e.reserve(db,e.prepare(db,run.id,'step'),'parent','new-call');
  assert.throws(()=>e.bind(db,run.id,'step','old-agent','new-call'),/agent|bound/i);
});
