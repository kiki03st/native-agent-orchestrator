'use strict';
const fs=require('node:fs');
const path=require('node:path');
const isCollaboration=(name,tool)=>name==='collaboration.'+tool||name==='collaboration__'+tool||name==='collaboration'+tool;
const isTool=(name,tool)=>name===tool||name==='multi_agent_v1__'+tool||name==='multi_agent_v1.'+tool||isCollaboration(name,tool)||(tool==='spawn_agent'&&name==='Agent');
const worker='You are a scoped worker, NOT the orchestrator. Follow your ORCH_TASK assignment. Do not create plans or spawn child agents. Do not change orchestration settings or the plan ledger. Return a concise result with evidence, changed files and remaining issues. A worker report is not parent verification.';
function object(value){return typeof value==='string'?JSON.parse(value):value;}
function response(value){
  if(typeof value==='string'){try{return response(JSON.parse(value));}catch{return null;}}
  if(!value||typeof value!=='object')return null;
  if(value.agent_id||value.task_name||Array.isArray(value.agents)||Object.hasOwn(value,'previous_status'))return value;
  if(value.structuredContent){const v=response(value.structuredContent);if(v)return v;}
  if(Array.isArray(value.content))for(const block of value.content){if(block.type==='text'){const v=response(block.text);if(v)return v;}}
  return null;
}
function handle(event){
  const type=event.hook_event_name;
  if(type==='UserPromptSubmit'||type==='SubagentStart'){
    const isWorker=type==='SubagentStart'||/^ORCH_TASK [a-f0-9-]{36} /.test(event.prompt||'');
    const context=isWorker?worker:fs.readFileSync(path.join(__dirname,'coordinator.md'),'utf8')+
      '\nOwner session ID: '+JSON.stringify(event.session_id)+'. CLI path: '+JSON.stringify(path.join(__dirname,'cli.cjs'))+'.';
    return {hookSpecificOutput:{hookEventName:type,additionalContext:context}};
  }
  const spawn=isTool(event.tool_name,'spawn_agent'),close=isTool(event.tool_name,'close_agent');
  const observe=['list_agents','wait_agent'].some(tool=>isCollaboration(event.tool_name,tool));
  if(!['PreToolUse','PostToolUse'].includes(type)||(!spawn&&!close&&!observe))return {};
  if(type==='PreToolUse'&&!spawn)return {};
  const e=require('./engine.cjs');let db;
  try{
    const input=object(event.tool_input);db=e.openDb();
    if(type==='PreToolUse'){
      e.reserve(db,input,event.session_id,event.tool_use_id,'codex',isCollaboration(event.tool_name,'spawn_agent')?'collaboration':'legacy');return {};
    }
    const output=response(event.tool_response);
    if(spawn){
      const {runId,stepId}=e.parseTask(input);
      const run=e.getRun(db,runId),contract=isCollaboration(event.tool_name,'spawn_agent')?'collaboration':'legacy';
      if(run.session!==event.session_id||(run.codex_contract||'legacy')!==contract||run.runtime==='claude')throw new Error('Spawn response runtime/session/contract differs from reservation');
      const agentId=output?.agent_id||(contract==='collaboration'?output?.task_name:null);
      if(!agentId)throw new Error('Spawn response has no recognizable native identity; confirm whether a worker exists before bind/fail');
      if(contract==='collaboration'&&output.task_name&&(typeof output.task_name!=='string'||output.task_name.split('/').at(-1)!==input.task_name))throw new Error('Returned canonical task name differs from dispatched task');
      e.bind(db,runId,stepId,agentId,event.tool_use_id);
    }else if(observe){
      const managed=e.listRuns(db,event.session_id).filter(r=>r.codex_contract==='collaboration').flatMap(r=>r.steps);
      if(!managed.some(s=>s.agent_id&&!s.execution_complete&&!s.closed))return {};
      if(!Array.isArray(output?.agents))throw new Error('Unrecognized native completion response; confirm terminal state in parent report');
      for(const agent of output.agents){
        if(!managed.some(s=>s.agent_id===agent.agent_name))continue;
        if(['completed','errored'].includes(agent.agent_status))e.observeCodexCompletion(db,event.session_id,agent.agent_name,agent.agent_status);
        else if(!['running','idle','pending'].includes(agent.agent_status))throw new Error('Unknown native agent status; confirm terminal state before reporting');
      }
    }else{
      const agentId=input?.target;
      // Do not interfere with unrelated native agents.
      if(!e.listRuns(db).some(r=>r.steps.some(s=>s.agent_id===agentId)))return {};
      const status=output?.previous_status;
      if(!(['shutdown','not_found'].includes(status)||(status&&typeof status==='object'&&('completed' in status||'errored' in status))))
        throw new Error('Close requested for non-final/unknown status; confirm shutdown before cli.cjs closed');
      e.markClosed(db,agentId);
    }
    return {};
  }catch(error){
    if(type==='PreToolUse')return {hookSpecificOutput:{hookEventName:type,permissionDecision:'deny',permissionDecisionReason:'Orchestration: '+error.message}};
    return {systemMessage:'Orchestration reconciliation required: '+error.message};
  }finally{db?.close();}
}
try{const event=JSON.parse(fs.readFileSync(0,'utf8').replace(/^\uFEFF/,''));process.stdout.write(JSON.stringify(handle(event))+'\n');}
catch(error){process.stderr.write('Orchestration hook input error: '+error.message+'\n');process.exitCode=2;}
