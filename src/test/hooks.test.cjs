const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync,spawn}=require('node:child_process');
const e=require('../engine.cjs');
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-orch-hooks-'));
  const filename=path.join(dir,'state.sqlite');
  const env={...process.env,CODEX_ORCH_DB:filename};
  const db=e.openDb(filename);
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const plan={objective:'한글 작업 검증',cwd:dir,steps:[{id:'review',task:'Check the result',model:'gpt-5.6-sol',reasoning_effort:'high',reason:'Review edge cases',depends_on:[],read_paths:['.'],write_paths:[],acceptance:['Evidence checked']}]};
  const run=e.createRun(db,plan,'parent');
  function call(file,args,input){const p=spawnSync(process.execPath,[path.join(__dirname,'..',file),...args],{env,input:JSON.stringify(input),encoding:'utf8'});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);}
  const hook=event=>call('hook.cjs',[],{session_id:'parent',...event});
  return {db,dir,env,run,plan,call,hook};
}
test('prompt policy preserves Korean and bypasses worker prompts',t=>{
  const {hook}=fixture(t);
  const result=hook({hook_event_name:'UserPromptSubmit',prompt:'진행 상황 알려줘'});
  assert.equal(result.hookSpecificOutput.hookEventName,'UserPromptSubmit');
  assert.match(result.hookSpecificOutput.additionalContext,/simple questions|status/i);
  assert.match(result.hookSpecificOutput.additionalContext,/parent/);
  const worker=hook({hook_event_name:'UserPromptSubmit',prompt:'ORCH_TASK 00000000-0000-0000-0000-000000000000 review\n검토'});
  assert.match(worker.hookSpecificOutput.additionalContext,/worker/i);
  assert.doesNotMatch(worker.hookSpecificOutput.additionalContext,/create SESSION/);
});
test('unrelated tool is inert',t=>{
  const {hook}=fixture(t);
  assert.deepEqual(hook({hook_event_name:'PreToolUse',tool_name:'exec_command',tool_input:{}}),{});
});
test('an unplanned spawn passes through without touching the plan',t=>{
  const {hook,run,db}=fixture(t);
  assert.deepEqual(hook({hook_event_name:'PreToolUse',tool_name:'spawn_agent',tool_input:{message:'unplanned'}}),{});
  assert.deepEqual(hook({hook_event_name:'PreToolUse',tool_name:'Agent',tool_use_id:'x',
    tool_input:JSON.stringify({message:'still unplanned'})}),{});
  assert.equal(e.getRun(db,run.id).steps[0].attempts,0);
});
test('spawn pre/post and close record lifecycle while preserving permission defaults',t=>{
  const {hook,run,db,call}=fixture(t);const input=e.prepare(db,run.id,'review');
  assert.deepEqual(hook({hook_event_name:'PreToolUse',tool_name:'multi_agent_v1__spawn_agent',tool_input:input,tool_use_id:'call'}),{});
  assert.deepEqual(hook({hook_event_name:'PostToolUse',tool_name:'spawn_agent',tool_input:input,tool_use_id:'call',tool_response:{content:[{type:'text',text:JSON.stringify({agent_id:'native-1',nickname:'Reviewer'})}]}}),{});
  assert.equal(e.getRun(db,run.id).steps[0].agent_id,'native-1');
  call('cli.cjs',['report',run.id,'review'],{agent_id:'native-1',call_id:'call',summary:'한글 결과',verified:true,evidence:['확인 완료'],changed_files:[]});
  hook({hook_event_name:'PostToolUse',tool_name:'close_agent',tool_input:{target:'native-1'},tool_response:{previous_status:{completed:'checked'}}});
  const final=e.getRun(db,run.id).steps[0];assert.equal(final.closed,true);assert.equal(final.result.summary,'한글 결과');
});
test('unrecognized spawn response leaves reservation blocked and reports reconciliation',t=>{
  const {hook,run,db}=fixture(t);const input=e.prepare(db,run.id,'review');
  hook({hook_event_name:'PreToolUse',tool_name:'spawn_agent',tool_input:input,tool_use_id:'call'});
  const output=hook({hook_event_name:'PostToolUse',tool_name:'spawn_agent',tool_input:input,tool_response:'unknown output'});
  assert.match(output.systemMessage,/reconcil/i);assert.equal(e.getRun(db,run.id).steps[0].closed,false);
});
test('closing a still-running worker does not prematurely release its reservation',t=>{
  const {hook,run,db}=fixture(t);const input=e.prepare(db,run.id,'review');
  e.reserve(db,input,'parent','call');e.bind(db,run.id,'review','native-2','call');
  const output=hook({hook_event_name:'PostToolUse',tool_name:'close_agent',tool_input:{target:'native-2'},tool_response:{previous_status:'running'}});
  assert.match(output.systemMessage,/confirm|reconcil/i);assert.equal(e.getRun(db,run.id).steps[0].closed,false);
});
test('CLI create and list round-trip Unicode through stdin',t=>{
  const {call,plan}=fixture(t);const created=call('cli.cjs',['create','korean'],plan);
  assert.equal(created.objective,plan.objective);assert.equal(call('cli.cjs',['list','korean'],{}).length,1);
});
test('concurrent hook processes reserve one step exactly once',async t=>{
  const {env,run,db}=fixture(t);const input=e.prepare(db,run.id,'review');
  const invoke=id=>new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,[path.join(__dirname,'../hook.cjs')],{env});let out='',err='';
    p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);
    p.on('close',code=>{try{assert.equal(code,0,err);resolve(JSON.parse(out));}catch(error){reject(error);}});
    p.stdin.end(JSON.stringify({session_id:'parent',hook_event_name:'PreToolUse',tool_name:'spawn_agent',tool_use_id:id,tool_input:input}));
  });
  const results=await Promise.all([invoke('one'),invoke('two')]);
  assert.equal(results.filter(r=>r.hookSpecificOutput?.permissionDecision==='deny').length,1);
  assert.equal(e.getRun(db,run.id).steps[0].attempts,1);
});
test('Codex PostToolUse stays silent for an unplanned spawn',t=>{
  const {hook}=fixture(t);
  assert.deepEqual(hook({hook_event_name:'PostToolUse',tool_name:'spawn_agent',tool_use_id:'free',
    tool_input:{message:'unplanned'},tool_response:{agent_id:'native-free'}}),{});
});
