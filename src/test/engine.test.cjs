const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const enginePath = path.join(__dirname, '../engine.cjs');
function setup(t, overrides = {}) {
  assert.ok(fs.existsSync(enginePath), 'persistent orchestration engine must exist');
  const e = require(enginePath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-orch-test-'));
  const db = e.openDb(path.join(dir, 'state.sqlite'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const step = (id, fields = {}) => ({ id, task: 'Return a checked result', model: 'gpt-5.6-terra',
    reasoning_effort: 'medium', reason: 'Ordinary implementation', depends_on: [],
    read_paths: [], write_paths: [], acceptance: ['Result is verified'], ...fields });
  const plan = {objective:'테스트 작업', context:'Relevant context only', cwd:dir, max_parallel:1,
    steps:[step('first'),step('second',{depends_on:['first']})], ...overrides};
  const run = e.createRun(db,plan,'parent');
  return {e,db,run,step,dir};
}
test('rejects missing or different model/effort and accepts the planned pair', t => {
  const {e,db,run} = setup(t); const input=e.prepare(db,run.id,'first');
  for (const patch of [{model:undefined},{model:'gpt-6-astra'},{reasoning_effort:undefined},{reasoning_effort:'high'},{fork_context:true}])
    assert.throws(()=>e.reserve(db,{...input,...patch},'parent','bad'), /model|effort|context/i);
  e.reserve(db,input,'parent','call-1');
  assert.equal(e.getRun(db,run.id).steps[0].status,'dispatching');
});
test('rejects another session and duplicate dispatch', t => {
  const {e,db,run} = setup(t); const input=e.prepare(db,run.id,'first');
  assert.throws(()=>e.reserve(db,input,'other','call-1'),/owner|session/i);
  e.reserve(db,input,'parent','call-1');
  assert.throws(()=>e.reserve(db,input,'parent','call-2'),/pending|already|dispatch/i);
});

test('Codex rejects extra dispatch keys and omitted fresh-context flag', t => {
  const {e,db,run}=setup(t),input=e.prepare(db,run.id,'first');
  assert.throws(()=>e.reserve(db,{...input,extra:'not planned'},'parent','extra'),/prepared|arguments/i);
  const missing={...input};delete missing.fork_context;
  assert.throws(()=>e.reserve(db,missing,'parent','missing'),/prepared|context|arguments/i);
  assert.equal(e.getRun(db,run.id).steps[0].status,'pending');
});
test('dependent work waits for verified evidence and agent closure', t => {
  const {e,db,run}=setup(t);
  assert.throws(()=>e.prepare(db,run.id,'second'),/depend/i);
  e.reserve(db,e.prepare(db,run.id,'first'),'parent','a'); e.bind(db,run.id,'first','worker-1','a');
  assert.throws(()=>e.report(db,run.id,'first',{summary:'done',verified:true,evidence:[],changed_files:[]}),/evidence/i);
  e.report(db,run.id,'first',{agent_id:'worker-1',call_id:'a',summary:'checked',verified:true,evidence:['Native output checked'],changed_files:[]});
  assert.throws(()=>e.prepare(db,run.id,'second'),/depend/i);
  e.markClosed(db,'worker-1');
  assert.equal(e.prepare(db,run.id,'second').model,'gpt-5.6-terra');
});
test('failure cannot satisfy dependencies and retry preserves history', t => {
  const {e,db,run}=setup(t);
  e.reserve(db,e.prepare(db,run.id,'first'),'parent','a'); e.bind(db,run.id,'first','worker-1','a');
  e.report(db,run.id,'first',{agent_id:'worker-1',call_id:'a',summary:'test failed',verified:false,evidence:['exit 1'],changed_files:[]});
  assert.throws(()=>e.retry(db,run.id,'first',{model:'gpt-5.6-sol',reasoning_effort:'high',reason:'Needs deeper analysis'}),/clos/i);
  e.markClosed(db,'worker-1');
  e.retry(db,run.id,'first',{model:'gpt-5.6-sol',reasoning_effort:'high',reason:'Needs deeper analysis'});
  assert.equal(e.prepare(db,run.id,'first').model,'gpt-5.6-sol');
  assert.ok(e.getRun(db,run.id).events.some(x=>x.type==='report'&&x.result.verified===false));
});
test('parallelism checks overlapping read/write paths and default sequential execution', t => {
  const {e,db,run,step,dir}=setup(t);
  const r=e.createRun(db,{objective:'parallel',context:'',cwd:dir,max_parallel:3,steps:[
    step('write',{write_paths:['src']}),step('read',{read_paths:['src/a.js']}),step('independent',{write_paths:['docs']})]},'parallel-parent');
  e.reserve(db,e.prepare(db,r.id,'write'),'parallel-parent','a');
  assert.throws(()=>e.prepare(db,r.id,'read'),/conflict|overlap/i);
  e.reserve(db,e.prepare(db,r.id,'independent'),'parallel-parent','b');
  assert.equal(e.getRun(db,r.id).steps.filter(s=>s.status==='dispatching').length,2);
  const s=e.createRun(db,{objective:'sequential',context:'',cwd:dir,steps:[step('a'),step('b')]},'sequential-parent');
  e.reserve(db,e.prepare(db,s.id,'a'),'sequential-parent','c');
  assert.throws(()=>e.prepare(db,s.id,'b'),/parallel|limit/i);
});
test('cycles, invalid effort, unsupported model, and repeated ids cannot form a plan', t => {
  const {e,db,step,dir}=setup(t);
  for (const steps of [[step('a',{depends_on:['b']}),step('b',{depends_on:['a']})],
    [step('a',{reasoning_effort:'extra high 또는 max'})], [step('a',{model:'invented-model'})], [step('a'),step('a')]])
    assert.throws(()=>e.createRun(db,{objective:'invalid',context:'',cwd:dir,steps},'parent'));
});
test('global write conflicts are rejected across different plans', t => {
  const {e,db,step,dir}=setup(t);
  const plan={objective:'cross-run',cwd:dir,context:'',steps:[step('a',{write_paths:['shared.txt']})]};
  const a=e.createRun(db,plan,'one'), b=e.createRun(db,plan,'two');
  e.reserve(db,e.prepare(db,a.id,'a'),'one','a');
  assert.throws(()=>e.prepare(db,b.id,'a'),/overlap|conflict/i);
});
test('read-only steps can run together; unknown write scope is exclusive', t => {
  const {e,db,step,dir}=setup(t);
  const run=e.createRun(db,{objective:'reads',cwd:dir,max_parallel:3,steps:[step('a',{read_paths:['.']}),step('b',{read_paths:['.']}),step('c',{write_paths:['**']})]},'reader');
  e.reserve(db,e.prepare(db,run.id,'a'),'reader','a');
  e.reserve(db,e.prepare(db,run.id,'b'),'reader','b');
  assert.throws(()=>e.prepare(db,run.id,'c'),/overlap|conflict/i);
});
test('failed spawn releases only an unbound reservation and retries are bounded', t => {
  const {e,db,run}=setup(t);
  for(let i=0;i<2;i++) {
    e.reserve(db,e.prepare(db,run.id,'first'),'parent','call-'+i);
    e.fail(db,run.id,'first','Spawn returned an error, no worker created','call-'+i);
    if(i===0)e.retry(db,run.id,'first',{model:'gpt-5.6-terra',reasoning_effort:'medium',reason:'Transient failure'});
  }
  assert.throws(()=>e.retry(db,run.id,'first',{model:'gpt-5.6-terra',reasoning_effort:'medium',reason:'Try again'}),/attempt|retry/i);
});
test('pending steps can be revised with validated dependencies and audit history',t=>{
  const {e,db,run}=setup(t);
  e.revise(db,run.id,'first',{model:'gpt-5.6-sol',reasoning_effort:'high',change_reason:'User added review requirements'});
  assert.equal(e.prepare(db,run.id,'first').model,'gpt-5.6-sol');
  assert.throws(()=>e.revise(db,run.id,'first',{depends_on:['second'],change_reason:'Invalid cycle'}),/cycle/i);
  assert.throws(()=>e.revise(db,run.id,'first',{status:'completed',change_reason:'Invalid mutation'}),/field/i);
  e.reserve(db,e.prepare(db,run.id,'first'),'parent','a');
  assert.throws(()=>e.revise(db,run.id,'first',{task:'Different work',change_reason:'Too late'}),/pending/i);
  assert.ok(e.getRun(db,run.id).events.some(x=>x.type==='revised'));
});
test('dispatch rejects task text different from the prepared assignment',t=>{
  const {e,db,run}=setup(t);const input=e.prepare(db,run.id,'first');
  assert.throws(()=>e.reserve(db,{...input,message:input.message+'\nDo other work'},'parent','a'),/assignment|prepared/i);
});
test('path aliases cannot bypass write conflicts',t=>{
  const {e,db,step,dir}=setup(t);
  const target=path.join(dir,'real');fs.mkdirSync(target);fs.symlinkSync(target,path.join(dir,'alias'),'junction');
  const run=e.createRun(db,{objective:'alias',cwd:dir,max_parallel:3,steps:[step('a',{write_paths:['real']}),step('b',{write_paths:['alias/new.txt']})]},'alias');
  e.reserve(db,e.prepare(db,run.id,'a'),'alias','a');
  assert.throws(()=>e.prepare(db,run.id,'b'),/conflict/i);
});
test('unknown write scope conflicts even with an undeclared empty scope',t=>{
  const {e,db,step,dir}=setup(t);
  const run=e.createRun(db,{objective:'exclusive',cwd:dir,max_parallel:3,steps:[step('a'),step('b',{write_paths:['**']})]},'exclusive');
  e.reserve(db,e.prepare(db,run.id,'a'),'exclusive','a');
  assert.throws(()=>e.prepare(db,run.id,'b'),/conflict/i);
});
test('parallel limit also applies across runs',t=>{
  const {e,db,step,dir}=setup(t);
  for(let i=0;i<3;i++){
    const run=e.createRun(db,{objective:'parallel',cwd:dir,steps:[step('a')]},'p'+i);
    e.reserve(db,e.prepare(db,run.id,'a'),'p'+i,'c'+i);
  }
  const run=e.createRun(db,{objective:'fourth',cwd:dir,steps:[step('a')]},'p4');
  assert.throws(()=>e.prepare(db,run.id,'a'),/global|limit/i);
});
