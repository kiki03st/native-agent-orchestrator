'use strict';
const fs=require('node:fs');
const path=require('node:path');
const policy=require('./policy.json');
const e=require('./engine.cjs');
const worker='Execute only the ORCH_TASK assignment supplied by the parent. Do not create an orchestration plan, spawn agents, resume agents, send messages, or alter the ledger/settings. Respect the task scope and inherited permissions. Return summary, concrete evidence, changed files and remaining issues. Do not claim parent verification. Do not leave background processes running when you finish.';
function profiles(){
  const out={};
  for(const [model,efforts] of Object.entries(policy.claude_models))for(const effort of efforts)for(const slot of ['one','two','three']){
    const name=`orch-${model}-${effort}-${slot}`;
    out[name]=`---\nname: ${name}\ndescription: Reserved ${model} worker slot; use only through a prepared ORCH_TASK plan.\nmodel: ${model}\n`+
      (effort==='default'?'':`effort: ${effort}\n`)+`disallowedTools: Agent, SendMessage\n---\n\n${worker}\n`;
  }
  return out;
}
function checkProfile(input,cwd){
  const qualified=input?.subagent_type;
  if(typeof qualified!=='string'||!qualified.startsWith('native-agent-orchestrator:'))throw new Error('Expected plugin-qualified Claude worker profile');
  const name=qualified.slice('native-agent-orchestrator:'.length);
  const expected=profiles()[name];if(!expected)throw new Error('Unknown managed Claude worker profile');
  const root=process.env.CLAUDE_ORCH_AGENT_DIR||path.join(__dirname,'../agents');
  const filename=path.join(root,name+'.md');
  if(!fs.existsSync(filename)||fs.readFileSync(filename,'utf8')!==expected)throw new Error('Claude worker profile missing or changed: '+filename);
  // Project definitions override personal definitions. Check ancestor scopes too.
  for(let cursor=path.resolve(cwd);;cursor=path.dirname(cursor)){
    const local=path.join(cursor,'.claude/agents',qualified+'.md');
    if(path.resolve(local)!==path.resolve(filename)&&fs.existsSync(local)&&fs.readFileSync(local,'utf8')!==expected)
      throw new Error('Project overrides the planned Claude profile: '+local);
    if(path.dirname(cursor)===cursor)break;
  }
  if(/^(1|true|yes|on)$/i.test(process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE||''))throw new Error('Forced subagent model prevents per-step routing');
}
function start(db,event){
  const candidates=e.listRuns(db,event.session_id).filter(r=>r.runtime==='claude').flatMap(run=>run.steps.filter(s=>s.worker_type===event.agent_type&&!s.closed).map(step=>({run,step})));
  if(candidates.length!==1)throw new Error('Claude start has no unique plan reservation');
  const {run,step}=candidates[0];e.bind(db,run.id,step.id,event.agent_id,step.call_id);
}
function agentId(value){
  if(typeof value==='string'){
    try{const id=agentId(JSON.parse(value));if(id)return id;}catch{}
    return /^agentId:\s*([A-Za-z0-9_-]+)\s*$/m.exec(value)?.[1]||null;
  }
  if(!value||typeof value!=='object')return null;
  if(typeof value.agentId==='string')return value.agentId;
  if(typeof value.agent_id==='string')return value.agent_id;
  if(Array.isArray(value))for(const item of value){const id=agentId(item);if(id)return id;}
  for(const key of ['content','text','structuredContent'])if(value[key]){const id=agentId(value[key]);if(id)return id;}
  return null;
}
function inspect(db,runId,stepId){
  const run=e.getRun(db,runId),s=run.steps.find(s=>s.id===stepId);
  if(run.runtime!=='claude'||!s?.agent_id)throw new Error('A bound Claude worker is required');
  const filename=s.stop_observed?.transcript_path;
  if(!filename||!fs.existsSync(filename))throw new Error('Native transcript not available yet; await completion then retry');
  const projects=fs.realpathSync.native(path.join(process.env.CLAUDE_CONFIG_DIR||path.join(require('node:os').homedir(),'.claude'),'projects'));
  const resolved=fs.realpathSync.native(filename),relative=path.relative(projects,resolved);
  if(relative.startsWith('..')||path.isAbsolute(relative)||path.basename(resolved)!=='agent-'+s.agent_id+'.jsonl')throw new Error('Unexpected Claude transcript path');
  const models=new Set();
  for(const line of fs.readFileSync(resolved,'utf8').split(/\r?\n/)){
    try{const row=JSON.parse(line);if(row.type==='assistant'&&typeof row.message?.model==='string'&&row.message.model.startsWith('claude-'))models.add(row.message.model);}catch{}
  }
  return {agent_id:s.agent_id,call_id:s.call_id,models:[...models],observed_effort:s.stop_observed?.effort||null,stop_observed:!!s.stop_observed,execution_complete:'Must be confirmed from native notification/result by parent'};
}
module.exports={profiles,worker,checkProfile,start,agentId,inspect};
