'use strict';
const fs=require('node:fs');
const path=require('node:path');
const isTool=(name,tool)=>name===tool||name==='multi_agent_v1__'+tool||name==='multi_agent_v1.'+tool||(tool==='spawn_agent'&&name==='Agent');
const worker='You are a scoped worker, NOT the orchestrator. Follow your ORCH_TASK assignment. Do not create plans or spawn child agents. Do not change orchestration settings or the plan ledger. Return a concise result with evidence, changed files and remaining issues. A worker report is not parent verification.';
function object(value){return typeof value==='string'?JSON.parse(value):value;}
function response(value){
  if(typeof value==='string'){try{return response(JSON.parse(value));}catch{return null;}}
  if(!value||typeof value!=='object')return null;
  if(value.agent_id||Object.hasOwn(value,'previous_status'))return value;
  if(value.structuredContent){const v=response(value.structuredContent);if(v)return v;}
  if(Array.isArray(value.content))for(const block of value.content){if(block.type==='text'){const v=response(block.text);if(v)return v;}}
  return null;
}
function handle(event){
  const type=event.hook_event_name;
  if(type==='UserPromptSubmit'){
    const isWorker=/^ORCH_TASK [a-f0-9-]{36} /.test(event.prompt||'');
    const context=isWorker?worker:fs.readFileSync(path.join(__dirname,'coordinator.md'),'utf8')+
      '\nOwner session ID: '+JSON.stringify(event.session_id)+'. CLI path: '+JSON.stringify(path.join(__dirname,'cli.cjs'))+'.';
    return {hookSpecificOutput:{hookEventName:type,additionalContext:context}};
  }
  const spawn=isTool(event.tool_name,'spawn_agent'),close=isTool(event.tool_name,'close_agent');
  if(!['PreToolUse','PostToolUse'].includes(type)||(!spawn&&!close))return {};
  if(type==='PreToolUse'&&!spawn)return {};
  const e=require('./engine.cjs');let db;
  try{
    // Mirrors claude-hook.cjs: a worker must not delegate further. Placed ahead of the
    // marker gate so it covers unmanaged dispatches too. UNVERIFIED: whether Codex
    // supplies agent_id on PreToolUse has not been tested against a live host. If it
    // does not, this guard never fires and denies nothing.
    if(type==='PreToolUse'&&event.agent_id)throw new Error('Worker cannot recursively delegate');
    const input=object(event.tool_input);
    if(spawn&&!e.hasTask(input))return {};
    db=e.openDb();
    if(type==='PreToolUse'){
      e.reserve(db,input,event.session_id,event.tool_use_id);return {};
    }
    const output=response(event.tool_response);
    if(spawn){
      const {runId,stepId}=e.parseTask(input);
      if(!output?.agent_id)throw new Error('Spawn response has no recognizable agent_id; confirm whether a worker exists before bind/fail');
      e.bind(db,runId,stepId,output.agent_id,event.tool_use_id);
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
