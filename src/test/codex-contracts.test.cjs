'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const e=require('../engine.cjs');
const revision={model:'gpt-5.6-sol',reasoning_effort:'high',reason:'Retry a confirmed failure'};
function fixture(t,contract='collaboration'){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orch-contract-'));
  const filename=path.join(dir,'state.sqlite'),db=e.openDb(filename);
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const step=(id,depends_on=[])=>({id,task:'Read a result',model:'gpt-5.6-sol',reasoning_effort:'high',reason:'Review',depends_on,read_paths:[],write_paths:[],acceptance:['Parent checks result']});
  const plan={objective:'Host contracts',cwd:dir,steps:[step('first'),step('second',['first'])],...(contract?{codex_contract:contract}:{})};
  const run=e.createRun(db,plan,'parent');
  const hook=event=>{
    const result=spawnSync(process.execPath,[path.join(__dirname,'../hook.cjs')],{encoding:'utf8',input:JSON.stringify({session_id:'parent',...event}),env:{...process.env,CODEX_ORCH_DB:filename}});
    assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
  };
  const start=(call='call',agent='worker')=>{
    e.reserve(db,e.prepare(db,run.id,'first'),'parent',call,'codex',contract||'legacy');
    e.bind(db,run.id,'first',agent,call);
  };
  const report=(fields={})=>({agent_id:'worker',call_id:'call',summary:'Parent checked',verified:true,evidence:['Acceptance checked'],changed_files:[],execution_complete:true,completion_status:'completed',completion_evidence:'Native terminal notification for worker/call',observed_model:'gpt-5.6-sol',model_evidence:'Native execution metadata shows gpt-5.6-sol',...fields});
  return {db,run,plan,hook,start,report};
}

test('legacy remains the persisted default and old records prepare the legacy contract',t=>{
  const {db,run}=fixture(t,null);
  assert.equal(run.codex_contract,'legacy');
  const old={...run};delete old.codex_contract;
  db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(old),run.id);
  const input=e.prepare(db,run.id,'first');
  assert.equal(input.fork_context,false);assert.ok(!Object.hasOwn(input,'fork_turns'));
  assert.ok(!Object.hasOwn(input,'task_name'));
  e.reserve(db,input,'parent','call');
});

test('contract selection rejects unknown values and Claude plans cannot select it',t=>{
  const {db,plan}=fixture(t);
  for(const codex_contract of ['auto','',false,null]){
    assert.throws(()=>e.createRun(db,{...plan,codex_contract},'parent'),/contract/i);
  }
  assert.throws(()=>e.createRun(db,{...plan,runtime:'claude'},'parent'),/contract/i);
});

test('legacy execution_complete report fields cannot replace confirmed close_agent',t=>{
  const {db,run,start,report}=fixture(t,'legacy');start();
  e.report(db,run.id,'first',report());
  assert.throws(()=>e.prepare(db,run.id,'second'),/depend/i);
  e.markClosed(db,'worker');
  assert.equal(e.prepare(db,run.id,'second').fork_context,false);
});

test('collaboration preparation is fresh, unique, and strictly matched to the tool contract',t=>{
  const {db,run,hook}=fixture(t),input=e.prepare(db,run.id,'first');
  assert.equal(input.fork_turns,'none');assert.match(input.task_name,/^[a-z0-9_]+$/);
  assert.deepEqual(Object.keys(input).sort(),['fork_turns','message','model','reasoning_effort','task_name']);
  assert.throws(()=>e.reserve(db,input,'parent','wrong-tool'),/contract/i);
  for(const fields of [{task_name:'other'},{fork_turns:'all'},{fork_turns:undefined},{fork_context:false},{extra:true}])
    assert.throws(()=>e.reserve(db,{...input,...fields},'parent','bad','codex','collaboration'),/context|prepared|arguments/i);
  assert.equal(hook({hook_event_name:'PreToolUse',tool_name:'spawn_agent',tool_input:input,tool_use_id:'wrong'}).hookSpecificOutput.permissionDecision,'deny');
  assert.deepEqual(hook({hook_event_name:'PreToolUse',tool_name:'collaboration.spawn_agent',tool_input:input,tool_use_id:'call'}),{});
  const wrong=hook({hook_event_name:'PostToolUse',tool_name:'collaboration.spawn_agent',tool_input:input,tool_use_id:'call',tool_response:{task_name:'/root/other'}});
  assert.match(wrong.systemMessage,/canonical|task/i);
  const identity='/root/'+input.task_name;
  assert.deepEqual(hook({hook_event_name:'PostToolUse',tool_name:'collaboration.spawn_agent',tool_input:input,tool_use_id:'call',tool_response:{content:[{type:'text',text:JSON.stringify({task_name:identity})}]}}),{});
  assert.equal(e.getRun(db,run.id).steps[0].agent_id,identity);
});

test('completion requires native evidence and actual observed model evidence',t=>{
  const {db,run,start,report}=fixture(t);start();
  for(const fields of [{execution_complete:false},{execution_complete:'true'},{completion_status:'idle'},{completion_status:'interrupted'},{completion_status:'unknown'},{completion_evidence:''},{observed_model:undefined},{observed_model:'gpt-6-astra'},{model_evidence:''},{observed_effort:'low'},{completion_status:'errored'}])
    assert.throws(()=>e.report(db,run.id,'first',report(fields)),/complete|completion|terminal|model|effort|verified/i);
  assert.equal(e.getRun(db,run.id).steps[0].status,'running');
});

test('native terminal observation alone stays reserved; verified completion unlocks dependency without shutdown',t=>{
  const {db,run,start,report,hook}=fixture(t);start();
  const observe=status=>hook({hook_event_name:'PostToolUse',tool_name:'collaboration.list_agents',tool_input:{},tool_response:{agents:[{agent_name:'worker',agent_status:status}]}});
  assert.deepEqual(observe('idle'),{});
  assert.equal(e.getRun(db,run.id).steps[0].completion_observed,null);
  assert.deepEqual(hook({hook_event_name:'PostToolUse',tool_name:'collaboration.interrupt_agent',tool_input:{target:'worker'},tool_response:{previous_status:'running'}}),{});
  assert.throws(()=>e.prepare(db,run.id,'second'),/depend/i);
  assert.match(observe('unknown').systemMessage,/unknown/i);
  assert.deepEqual(observe('completed'),{});
  assert.throws(()=>e.prepare(db,run.id,'second'),/depend/i);
  assert.throws(()=>e.report(db,run.id,'first',report({verified:false,completion_status:'errored'})),/observed/i);
  e.report(db,run.id,'first',report());
  const final=e.getRun(db,run.id).steps[0];
  assert.equal(final.closed,false);assert.equal(final.execution_complete,true);
  assert.equal(e.prepare(db,run.id,'second').model,'gpt-5.6-sol');
  assert.throws(()=>e.markClosed(db,'worker'),/shutdown/i);
  assert.throws(()=>e.report(db,run.id,'first',report()),/terminal|running/i);
});

test('an unrecognized wait response keeps reservation and asks for parent reconciliation',t=>{
  const {db,run,start,hook}=fixture(t);start();
  const output=hook({hook_event_name:'PostToolUse',tool_name:'collaboration.wait_agent',tool_input:{},tool_response:'Mailbox update available'});
  assert.match(output.systemMessage,/terminal|completion/i);
  assert.equal(e.getRun(db,run.id).steps[0].execution_complete,false);
  assert.throws(()=>e.prepare(db,run.id,'second'),/depend/i);
});

test('flattened native collaboration names reserve, bind and observe completion',t=>{
  const {db,run,hook}=fixture(t),input=e.prepare(db,run.id,'first');
  assert.deepEqual(hook({hook_event_name:'PreToolUse',tool_name:'collaborationspawn_agent',tool_input:input,tool_use_id:'flat-call'}),{});
  assert.equal(e.getRun(db,run.id).steps[0].status,'dispatching');
  const identity='/root/'+input.task_name;
  assert.deepEqual(hook({hook_event_name:'PostToolUse',tool_name:'collaborationspawn_agent',tool_input:input,tool_use_id:'flat-call',tool_response:{task_name:identity}}),{});
  assert.equal(e.getRun(db,run.id).steps[0].agent_id,identity);
  assert.deepEqual(hook({hook_event_name:'PostToolUse',tool_name:'collaborationlist_agents',tool_input:{},tool_response:{agents:[{agent_name:identity,agent_status:'completed'}]}}),{});
  assert.equal(e.getRun(db,run.id).steps[0].completion_observed.status,'completed');
  assert.equal(e.getRun(db,run.id).steps[0].closed,false);
});

test('failed collaboration execution retries fresh and stale reports/events cannot settle the retry',t=>{
  const {db,run,start,report}=fixture(t);const first=e.prepare(db,run.id,'first');start();
  e.report(db,run.id,'first',report({verified:false,completion_status:'errored'}));
  assert.throws(()=>e.prepare(db,run.id,'second'),/depend/i);
  e.retry(db,run.id,'first',revision);
  const next=e.prepare(db,run.id,'first');assert.notEqual(next.task_name,first.task_name);assert.equal(next.fork_turns,'none');
  start('new-call','new-worker');
  assert.throws(()=>e.report(db,run.id,'first',report()),/agent|attempt|call/i);
  assert.equal(e.observeCodexCompletion(db,'parent','worker','completed'),null);
  assert.equal(e.observeCodexCompletion(db,'other','new-worker','completed'),null);
  assert.throws(()=>e.fail(db,run.id,'first','Old failure','call'),/call/i);
  assert.equal(e.getRun(db,run.id).steps[0].status,'running');
  e.report(db,run.id,'first',report({agent_id:'new-worker',call_id:'new-call'}));
  assert.equal(e.prepare(db,run.id,'second').fork_turns,'none');
});

test('early failure stays reserved until native terminal observation and parent confirms failure',t=>{
  const {db,run,start}=fixture(t);start();
  e.fail(db,run.id,'first','Confirmed acceptance failure','call');
  assert.throws(()=>e.retry(db,run.id,'first',revision),/closed|complete/i);
  e.observeCodexCompletion(db,'parent','worker','errored');
  assert.throws(()=>e.retry(db,run.id,'first',revision),/closed|complete/i);
  e.fail(db,run.id,'first','Confirmed native failure and ended execution','call');
  assert.equal(e.getRun(db,run.id).steps[0].closed,false);
  assert.equal(e.getRun(db,run.id).steps[0].execution_complete,true);
  e.retry(db,run.id,'first',revision);
});

test('cross-run file reservation releases only on verified native completion',t=>{
  const {db,run,plan,start,report}=fixture(t);
  e.revise(db,run.id,'first',{write_paths:['shared'],change_reason:'Declare shared output'});
  const other=e.createRun(db,{...plan,steps:[{...plan.steps[0],read_paths:['shared/file']}]},'other');
  start();
  e.observeCodexCompletion(db,'parent','worker','completed');
  assert.throws(()=>e.prepare(db,other.id,'first'),/conflict/i);
  e.report(db,run.id,'first',report());
  assert.equal(e.prepare(db,other.id,'first').fork_turns,'none');
});

test('each host assignment references validated current memory without injecting its contents',t=>{
  const memory=require('../memory.cjs');
  for(const contract of ['legacy','collaboration']){
    const {db,run,plan}=fixture(t,contract);
    const claude=e.createRun(db,{...plan,runtime:'claude',codex_contract:undefined,steps:plan.steps.map(s=>({...s,model:'sonnet',reasoning_effort:'medium'}))},'parent');
    for(const current of [run,claude]){
      const assignment=()=>{const input=e.prepare(db,current.id,'first');return input.message||input.prompt;};
      assert.ok(!Object.hasOwn(JSON.parse(assignment().split('\n').at(-1)),'context_memory'));
      const state=Object.fromEntries(['goals','decisions','constraints','facts','evidence','assumptions','questions','next_actions','detail_references'].map(key=>[key,[]]));
      state.goals=['Private current-state content'];
      const saved=memory.write(db,current.id,'parent',{expected_revision:null,state});
      const input=assignment();
      assert.deepEqual(JSON.parse(input.split('\n').at(-1)).context_memory,{path:saved.path});
      assert.ok(!input.includes(state.goals[0]));
      assert.match(input,/Do not edit context memory/);
      fs.writeFileSync(saved.path,'invalid record');
      assert.throws(assignment,/invalid memory/i);
    }
  }
});
