const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const e=require('../engine.cjs');
function setup(t,patch={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-orch-test-'));
  const dbFile=path.join(dir,'state.sqlite'),db=e.openDb(dbFile);
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const step=(id,fields={})=>({id,task:'Check a bounded result',model:'sonnet',reasoning_effort:'medium',reason:'Ordinary code',depends_on:[],read_paths:[],write_paths:[],acceptance:['Parent checks evidence'],...fields});
  const plan={runtime:'claude',objective:'Claude compatibility',cwd:dir,steps:[step('first'),step('second',{depends_on:['first']})],...patch};
  const run=e.createRun(db,plan,'claude-parent');
  const profileDir=path.join(dir,'agents');fs.mkdirSync(profileDir);
  const adapter=require('../claude-adapter.cjs');
  for(const [name,body] of Object.entries(adapter.profiles()))fs.writeFileSync(path.join(profileDir,name+'.md'),body);
  const hook=event=>{
    const p=spawnSync(process.execPath,[path.join(__dirname,'../claude-hook.cjs')],{encoding:'utf8',input:JSON.stringify({session_id:'claude-parent',cwd:dir,...event}),env:{...process.env,CODEX_ORCH_DB:dbFile,CLAUDE_ORCH_AGENT_DIR:profileDir}});
    assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);
  };
  return {db,run,step,dir,hook,profileDir};
}
test('Claude prepares explicit native model and effort-bearing non-fork profile',t=>{
  const {db,run,hook}=setup(t);const input=e.prepare(db,run.id,'first');
  assert.equal(input.model,'sonnet');assert.match(input.subagent_type,/^native-agent-orchestrator:orch-sonnet-medium-/);
  assert.match(input.prompt,/^ORCH_TASK /);assert.ok(!('reasoning_effort' in input));
  assert.deepEqual(hook({hook_event_name:'PreToolUse',tool_name:'Agent',tool_use_id:'call',tool_input:input}),{});
  assert.equal(e.getRun(db,run.id).steps[0].status,'dispatching');
});
test('a Claude plan cannot be dispatched through Codex and model families cannot mix',t=>{
  const {db,run,step,dir}=setup(t);
  assert.throws(()=>e.reserve(db,e.prepare(db,run.id,'first'),'claude-parent','call'),/runtime/i);
  assert.throws(()=>e.createRun(db,{runtime:'claude',objective:'wrong',cwd:dir,steps:[step('a',{model:'gpt-6-astra',reasoning_effort:'high'})]},'p'),/model/i);
  assert.throws(()=>e.createRun(db,{objective:'wrong',cwd:dir,steps:[step('a')]},'p'),/model/i);
});
test('Claude stop observation alone does not release work; parent confirmation closes it',t=>{
  const {db,run,hook}=setup(t);const input=e.prepare(db,run.id,'first');
  hook({hook_event_name:'PreToolUse',tool_name:'Agent',tool_use_id:'call',tool_input:input});
  hook({hook_event_name:'SubagentStart',agent_id:'worker',agent_type:input.subagent_type});
  hook({hook_event_name:'SubagentStop',agent_id:'worker',agent_type:input.subagent_type,effort:{level:'medium'},last_assistant_message:'Self reported done'});
  assert.equal(e.getRun(db,run.id).steps[0].closed,false);
  assert.throws(()=>e.prepare(db,run.id,'second'),/depend/i);
  const result={agent_id:'worker',call_id:'call',summary:'Parent checked',verified:true,evidence:['Acceptance checked'],changed_files:[],observed_model:'claude-sonnet-5',observed_effort:'medium'};
  assert.throws(()=>e.report(db,run.id,'first',result),/completion/i);
  e.report(db,run.id,'first',{...result,execution_complete:true,completion_evidence:'Native completed notification received'});
  assert.equal(e.getRun(db,run.id).steps[0].closed,true);
  assert.equal(e.prepare(db,run.id,'second').model,'sonnet');
});
test('parallel same-model Claude workers get different start-correlation slots',t=>{
  const {db,step,dir,hook}=setup(t);
  const run=e.createRun(db,{runtime:'claude',objective:'parallel',cwd:dir,max_parallel:3,steps:[step('a'),step('b')]},'claude-parent');
  const a=e.prepare(db,run.id,'a');hook({hook_event_name:'PreToolUse',tool_name:'Agent',tool_use_id:'a',tool_input:a});
  const b=e.prepare(db,run.id,'b');assert.notEqual(a.subagent_type,b.subagent_type);
  hook({hook_event_name:'PreToolUse',tool_name:'Agent',tool_use_id:'b',tool_input:b});
  hook({hook_event_name:'SubagentStart',agent_type:b.subagent_type,agent_id:'worker-b'});
  hook({hook_event_name:'SubagentStart',agent_type:a.subagent_type,agent_id:'worker-a'});
  assert.deepEqual(e.getRun(db,run.id).steps.map(s=>s.agent_id),['worker-a','worker-b']);
});
test('Claude async spawn text binds by exact call ID',t=>{
  const {db,run,hook}=setup(t);const input=e.prepare(db,run.id,'first');
  hook({hook_event_name:'PreToolUse',tool_name:'Agent',tool_use_id:'call',tool_input:input});
  const response={content:[{type:'text',text:'Async agent launched successfully.\nagentId: native-agent\nThe agent is working in the background.'}]};
  const denied=hook({hook_event_name:'PostToolUse',tool_name:'Agent',tool_use_id:'wrong',tool_input:input,tool_response:response});
  assert.match(denied.systemMessage,/call|reservation/i);
  hook({hook_event_name:'PostToolUse',tool_name:'Agent',tool_use_id:'call',tool_input:input,tool_response:response});
  assert.equal(e.getRun(db,run.id).steps[0].agent_id,'native-agent');
});
test('Claude worker cannot recursively delegate and profile tampering blocks dispatch',t=>{
  const {db,run,hook,profileDir}=setup(t);const input=e.prepare(db,run.id,'first');
  assert.equal(hook({hook_event_name:'PreToolUse',agent_id:'child',tool_name:'Agent',tool_use_id:'call',tool_input:input}).hookSpecificOutput.permissionDecision,'deny');
  fs.appendFileSync(path.join(profileDir,input.subagent_type.split(':')[1]+'.md'),'Changed profile');
  assert.equal(hook({hook_event_name:'PreToolUse',tool_name:'Agent',tool_use_id:'call',tool_input:input}).hookSpecificOutput.permissionDecision,'deny');
});
test('Claude rejects actual model or effort that differs from the plan',t=>{
  const {db,run,hook}=setup(t);const input=e.prepare(db,run.id,'first');
  hook({hook_event_name:'PreToolUse',tool_name:'Agent',tool_use_id:'call',tool_input:input});
  hook({hook_event_name:'SubagentStart',agent_id:'worker',agent_type:input.subagent_type});
  const result={agent_id:'worker',call_id:'call',summary:'Checked',verified:true,evidence:['Checked'],changed_files:[],execution_complete:true,completion_evidence:'Native completed',observed_model:'claude-haiku-4-5',observed_effort:'medium'};
  assert.throws(()=>e.report(db,run.id,'first',result),/model/i);
  assert.throws(()=>e.report(db,run.id,'first',{...result,observed_model:'claude-sonnet-5',observed_effort:'low'}),/effort/i);
});
test('Claude prompt questions have direct-answer policy and Haiku has no fake effort',t=>{
  const {hook}=setup(t);
  assert.match(hook({hook_event_name:'UserPromptSubmit',prompt:'진행 상황?'}).hookSpecificOutput.additionalContext,/simple questions|status/i);
  const profiles=require('../claude-adapter.cjs').profiles();
  assert.match(profiles['orch-haiku-default-one'],/model: haiku/);
  assert.doesNotMatch(profiles['orch-haiku-default-one'],/^effort:/m);
});
test('Codex and Claude reservations share the same file conflict checks',t=>{
  const {db,step,dir}=setup(t);
  const codex=e.createRun(db,{objective:'Codex write',cwd:dir,steps:[step('write',{model:'gpt-5.6-terra',reasoning_effort:'medium',write_paths:['shared']})]},'codex-parent');
  e.reserve(db,e.prepare(db,codex.id,'write'),'codex-parent','codex-call');
  const claude=e.createRun(db,{runtime:'claude',objective:'Claude read',cwd:dir,steps:[step('read',{read_paths:['shared/file.txt']})]},'claude-parent');
  assert.throws(()=>e.prepare(db,claude.id,'read'),/conflict/i);
});
test('Claude lets an unplanned dispatch through but still blocks recursion and profile tampering',t=>{
  const {db,run,hook,profileDir}=setup(t);
  assert.deepEqual(hook({hook_event_name:'PreToolUse',tool_name:'Agent',tool_use_id:'free',
    tool_input:{subagent_type:'general-purpose',prompt:'find the config loader'}}),{});
  assert.deepEqual(hook({hook_event_name:'PreToolUse',tool_name:'Task',tool_use_id:'free2',
    tool_input:{subagent_type:'Explore',description:'d',prompt:'unplanned'}}),{});
  assert.equal(e.getRun(db,run.id).steps[0].attempts,0);
  assert.equal(hook({hook_event_name:'PreToolUse',agent_id:'child',tool_name:'Agent',tool_use_id:'nested',
    tool_input:{subagent_type:'general-purpose',prompt:'unplanned'}}).hookSpecificOutput.permissionDecision,'deny');
  const input=e.prepare(db,run.id,'first');
  fs.appendFileSync(path.join(profileDir,input.subagent_type.split(':')[1]+'.md'),'Changed profile');
  assert.equal(hook({hook_event_name:'PreToolUse',tool_name:'Agent',tool_use_id:'call',tool_input:input})
    .hookSpecificOutput.permissionDecision,'deny');
});
test('Claude PostToolUse stays silent for an unplanned dispatch',t=>{
  const {hook}=setup(t);
  assert.deepEqual(hook({hook_event_name:'PostToolUse',tool_name:'Agent',tool_use_id:'free',
    tool_input:{subagent_type:'general-purpose',prompt:'unplanned'},
    tool_response:{content:[{type:'text',text:'agentId: someagent'}]}}),{});
});
test('Claude PostToolUseFailure reports only for planned dispatches',t=>{
  const {db,run,hook}=setup(t);
  assert.deepEqual(hook({hook_event_name:'PostToolUseFailure',tool_name:'Agent',tool_use_id:'free',
    tool_input:{subagent_type:'general-purpose',prompt:'unplanned'}}),{});
  const input=e.prepare(db,run.id,'first');
  assert.match(hook({hook_event_name:'PostToolUseFailure',tool_name:'Agent',tool_use_id:'call',
    tool_input:input}).systemMessage,/Agent tool failed/);
});
