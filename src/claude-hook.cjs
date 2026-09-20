'use strict';
const fs=require('node:fs');
const path=require('node:path');
function handle(event){
  const type=event.hook_event_name;
  if(type==='UserPromptSubmit'){
    const worker=!!event.agent_id||/^ORCH_TASK /.test(event.prompt||'');
    return {hookSpecificOutput:{hookEventName:type,additionalContext:worker?'You are a scoped worker. Follow the assignment; do not orchestrate or spawn agents.':
      fs.readFileSync(path.join(__dirname,'claude-coordinator.md'),'utf8')+'\nOwner session ID: '+JSON.stringify(event.session_id)+'. CLI path: '+JSON.stringify(path.join(__dirname,'cli.cjs'))+'.'}};
  }
  const spawn=['Agent','Task'].includes(event.tool_name),managed=/^native-agent-orchestrator:orch-/.test(event.agent_type||'');
  if(!spawn&&!(['SubagentStart','SubagentStop'].includes(type)&&managed))return {};
  const e=require('./engine.cjs'),a=require('./claude-adapter.cjs');let db;
  try{
    if(type==='PreToolUse'){
      if(event.agent_id)throw new Error('Worker cannot recursively delegate');
      if(!e.hasTask(event.tool_input))return {};
      a.checkProfile(event.tool_input,event.cwd);db=e.openDb();
      e.reserve(db,event.tool_input,event.session_id,event.tool_use_id,'claude');
    }else if(type==='SubagentStart'){
      db=e.openDb();a.start(db,event);
      return {hookSpecificOutput:{hookEventName:type,additionalContext:a.worker}};
    }else if(type==='SubagentStop'){
      db=e.openDb();e.observeClaudeStop(db,event.session_id,event.agent_id,{effort:event.effort?.level,transcript_path:event.agent_transcript_path});
      // Another hook can veto this stop. Only the parent's verified completion closes it.
    }else if(type==='PostToolUse'){
      if(!e.hasTask(event.tool_input))return {};
      const {runId,stepId}=e.parseTask(event.tool_input),id=a.agentId(event.tool_response);
      if(!id)throw new Error('Unrecognized Agent response; reconcile the reservation with native completion');
      db=e.openDb();const run=e.getRun(db,runId);
      if(run.runtime!=='claude'||run.session!==event.session_id)throw new Error('Wrong runtime/session for spawn response');
      e.bind(db,runId,stepId,id,event.tool_use_id);
    }else if(type==='PostToolUseFailure'){
      throw new Error('Agent tool failed; confirm whether any worker started before fail/closed reconciliation');
    }
    return {};
  }catch(error){
    if(type==='PreToolUse')return {hookSpecificOutput:{hookEventName:type,permissionDecision:'deny',permissionDecisionReason:'Claude orchestration: '+error.message}};
    if(type==='SubagentStart')return {hookSpecificOutput:{hookEventName:type,additionalContext:'Do not execute this task: orchestration reservation could not be confirmed. Return this error to the parent: '+error.message}};
    return {systemMessage:'Claude orchestration reconciliation required: '+error.message};
  }finally{db?.close();}
}
try{process.stdout.write(JSON.stringify(handle(JSON.parse(fs.readFileSync(0,'utf8').replace(/^\uFEFF/,''))))+'\n');}
catch(error){process.stderr.write(error.message+'\n');process.exitCode=2;}
