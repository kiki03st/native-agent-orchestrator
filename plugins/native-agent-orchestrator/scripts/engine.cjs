'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const policy = require('./policy.json');
const need = (condition, message) => { if (!condition) throw new Error(message); };
const text = (value, label) => need(typeof value === 'string' && value.trim().length > 0, label + ' is required');
const strings = (value, label) => need(Array.isArray(value) && value.every(x => typeof x === 'string' && x.trim()), label + ' must be a string array');
const now = () => new Date().toISOString();
function modelPair(model, effort, runtime='codex') {
  const models=runtime==='claude'?policy.claude_models:policy.models;
  need(Object.hasOwn(models, model || ''), 'Unsupported or missing model for '+runtime);
  need(models[model].includes(effort), 'Unsupported or missing reasoning_effort');
}
function openDb(filename = process.env.CODEX_ORCH_DB || path.join(process.env.ORCHESTRATOR_STATE_DIR || path.join(require('node:os').homedir(), '.local', 'share', 'native-agent-orchestrator'), 'state.sqlite')) {
  const posix=process.platform!=='win32';
  const previousMask=posix?process.umask(0o077):null;
  let db;
  try {
    // Restrict newly created directories, but do not chmod a caller's existing parent directory.
    fs.mkdirSync(path.dirname(filename), {recursive:true,mode:0o700});
    if(posix)for(const suffix of ['', '-wal', '-shm']){
      try{fs.chmodSync(filename+suffix,0o600);}catch(error){if(error.code!=='ENOENT')throw error;}
    }
    db = new DatabaseSync(filename);
    db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, session TEXT NOT NULL, data TEXT NOT NULL)');
    return db;
  } catch(error) { db?.close();throw error; }
  finally { if(posix)process.umask(previousMask); }
}
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const value=fn(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function getRun(db, id) {
  const row = db.prepare('SELECT data FROM runs WHERE id=?').get(id);
  need(row, 'Unknown run'); return JSON.parse(row.data);
}
function listRuns(db, session) {
  const rows = session === undefined ? db.prepare('SELECT data FROM runs').all() : db.prepare('SELECT data FROM runs WHERE session=?').all(session);
  return rows.map(r=>JSON.parse(r.data));
}
function save(db, run, event) {
  run.updated_at=now(); run.events.push({at:run.updated_at,...event});
  db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(run), run.id);
  return run;
}
function stepFor(run, id) { const s=run.steps.find(s=>s.id===id); need(s, 'Unknown step'); return s; }
function validatePlan(plan, session) {
  const runtime=plan.runtime??'codex';need(['codex','claude'].includes(runtime),'Unsupported runtime');
  text(session,'session'); text(plan.objective,'objective'); text(plan.cwd,'cwd');
  need(path.isAbsolute(plan.cwd),'cwd must be absolute');
  need(fs.existsSync(plan.cwd) && fs.statSync(plan.cwd).isDirectory(),'cwd must be an existing directory');
  const parallel=plan.max_parallel ?? 1;
  need(Number.isInteger(parallel) && parallel>=1 && parallel<=policy.max_parallel,'Invalid parallel limit');
  need(Array.isArray(plan.steps)&&plan.steps.length>0&&plan.steps.length<=50,'Plan needs 1-50 steps');
  const ids=new Set();
  const steps=plan.steps.map(s=>{
    need(typeof s.id==='string' && /^[a-zA-Z0-9_-]{1,64}$/.test(s.id)&&!ids.has(s.id),'Invalid or duplicate step id'); ids.add(s.id);
    text(s.task,'task'); text(s.reason,'routing reason'); modelPair(s.model,s.reasoning_effort,runtime);
    for(const key of ['depends_on','read_paths','write_paths','acceptance'])strings(s[key],key);
    need(s.acceptance.length>0,'Acceptance criteria required');
    for(const p of [...s.read_paths,...s.write_paths])need(p==='**'||!/[?*]/.test(p),'Use concrete paths or ** for unknown scope');
    return {id:s.id,task:s.task,model:s.model,reasoning_effort:s.reasoning_effort,reason:s.reason,
      depends_on:[...s.depends_on],read_paths:[...s.read_paths],write_paths:[...s.write_paths],acceptance:[...s.acceptance],
      status:'pending',attempts:0,agent_id:null,closed:true,result:null};
  });
  const visiting=new Set(),visited=new Set();
  function visit(s){need(!visiting.has(s.id),'Dependency cycle');if(visited.has(s.id))return;visiting.add(s.id);
    for(const id of s.depends_on){need(ids.has(id),'Unknown dependency');visit(steps.find(t=>t.id===id));}
    visiting.delete(s.id);visited.add(s.id);}
  steps.forEach(visit);
  return {id:randomUUID(),runtime,session,objective:plan.objective,context:String(plan.context||''),cwd:path.resolve(plan.cwd),max_parallel:parallel,steps,created_at:now(),events:[]};
}
function createRun(db, plan, session) {
  const run=validatePlan(plan,session);
  tx(db,()=>db.prepare('INSERT INTO runs (id,session,data) VALUES (?,?,?)').run(run.id,session,JSON.stringify(run)));
  return run;
}
function canonical(cwd,p) {
  if(p==='**')return p;
  let parent=path.resolve(cwd,p);const suffix=[];
  while(!fs.existsSync(parent)){
    const next=path.dirname(parent);need(next!==parent,'Cannot resolve scope path');
    suffix.unshift(path.basename(parent));parent=next;
  }
  return path.join(fs.realpathSync.native(parent),...suffix).replace(/\\/g,'/').replace(/\/$/,'').toLowerCase();
}
function overlaps(a,b) { return a==='**'||b==='**'||a===b||a.startsWith(b+'/')||b.startsWith(a+'/'); }
function conflicts(run,s,other,t) {
  if(s.write_paths.includes('**')||t.write_paths.includes('**'))return true;
  const r=s.read_paths.map(p=>canonical(run.cwd,p)),w=s.write_paths.map(p=>canonical(run.cwd,p));
  const tr=t.read_paths.map(p=>canonical(other.cwd,p)),tw=t.write_paths.map(p=>canonical(other.cwd,p));
  return w.some(p=>[...tr,...tw].some(q=>overlaps(p,q)))||tw.some(p=>r.some(q=>overlaps(p,q)));
}
const active=s=>!s.closed && s.status!=='pending';
function ready(db,run,s) {
  need(s.status==='pending','Step is not pending (already dispatched or finished)');
  for(const dep of s.depends_on){const p=stepFor(run,dep);need(p.status==='completed'&&p.closed,'Dependency must have verified result and be closed: '+dep);}
  need(run.steps.filter(active).length<run.max_parallel,'Parallel limit reached');
  const runs=listRuns(db);
  need(runs.reduce((n,r)=>n+r.steps.filter(active).length,0)<policy.max_parallel,'Global parallel limit reached');
  for(const other of runs)for(const t of other.steps)if(active(t))need(!conflicts(run,s,other,t),'Read/write scope conflict with '+other.id+'/'+t.id);
}
function prepare(db,id,step) {
  const run=getRun(db,id),s=stepFor(run,step);ready(db,run,s);
  const predecessors=s.depends_on.map(id=>({id,result:stepFor(run,id).result}));
  const input={model:s.model,reasoning_effort:s.reasoning_effort,fork_context:false,
    message:`ORCH_TASK ${run.id} ${s.id}\nYou are a task worker, not the orchestrator. Do not spawn subagents. Execute only this assignment. Respect the supplied working directory and write scope. Return summary, evidence, changed files and remaining issues; do not report success without checking acceptance criteria.\n`+
      JSON.stringify({cwd:run.cwd,objective:run.objective,context:run.context,task:s.task,read_paths:s.read_paths,write_paths:s.write_paths,acceptance:s.acceptance,predecessors})};
  if(run.runtime!=='claude')return input;
  const occupied=new Set(listRuns(db,run.session).flatMap(r=>r.steps.filter(active).map(t=>t.worker_type)));
  const workerType=['one','two','three'].map(slot=>`native-agent-orchestrator:orch-${s.model}-${s.reasoning_effort}-${slot}`).find(type=>!occupied.has(type));
  need(workerType,'No free Claude worker profile slot');
  return {model:s.model,subagent_type:workerType,description:'Planned step '+s.id,prompt:input.message};
}
function parseTask(input) {
  let message=input?.message||input?.prompt;
  if(!message && Array.isArray(input?.items))message=input.items.filter(x=>x.type==='text').map(x=>x.text||'').join('\n');
  const match=/^ORCH_TASK ([a-f0-9-]{36}) ([a-zA-Z0-9_-]{1,64})(?:\r?\n|$)/.exec(message||'');
  need(match,'Missing plan marker; create a plan and use cli.cjs prepare');
  return {runId:match[1],stepId:match[2]};
}
function reserve(db,input,session,callId,runtime='codex') {
  text(callId,'tool call_id');
  const {runId,stepId}=parseTask(input);
  return tx(db,()=>{
    const run=getRun(db,runId),s=stepFor(run,stepId);
    need((run.runtime||'codex')===runtime,'Dispatch runtime differs from plan');
    if(runtime==='claude'){
      const expected=prepare(db,runId,stepId);
      need(Object.keys(input).every(k=>Object.hasOwn(expected,k))&&Object.keys(expected).every(k=>input[k]===expected[k]),'Claude assignment/model/profile differs from prepared arguments');
    }else{
      modelPair(input?.model,input?.reasoning_effort);
      need(input.fork_context!==true,'Worker requires fresh context');
      need(input.model===s.model&&input.reasoning_effort===s.reasoning_effort,'Spawn model/effort differs from plan');
      need(input.message===prepare(db,runId,stepId).message&&!input.items,'Spawn assignment differs from prepared arguments');
      const expected=prepare(db,runId,stepId);
      need(Object.keys(input).every(k=>Object.hasOwn(expected,k))&&Object.keys(expected).every(k=>input[k]===expected[k]),'Codex dispatch arguments differ from prepared arguments');
    }
    need(run.session===session,'Session is not the plan owner');
    need(!listRuns(db,session).some(r=>r.events.some(v=>v.type==='reserved'&&v.call_id===callId)),'Tool call_id has already been used');
    ready(db,run,s);need(s.attempts<policy.max_attempts,'Attempt limit reached');
    s.status='dispatching';s.closed=false;s.attempts++;s.call_id=callId;s.started_at=now();
    if(runtime==='claude'){s.worker_type=input.subagent_type;s.stop_observed=null;}
    return save(db,run,{type:'reserved',step:stepId,model:s.model,reasoning_effort:s.reasoning_effort,call_id:callId});
  });
}
function bind(db,id,step,agentId,callId) {
  text(agentId,'agent_id');text(callId,'tool call_id');
  return tx(db,()=>{const run=getRun(db,id),s=stepFor(run,step);
    need(s.call_id===callId,'Spawn response call_id differs from reservation');
    if(s.agent_id===agentId)return run;
    need(s.status==='dispatching'&&!s.agent_id,'Step must have a dispatch reservation before bind');
    need(!listRuns(db).some(r=>r.steps.some(t=>t.agent_id===agentId)||r.events.some(v=>v.type==='bound'&&v.agent_id===agentId)),'Agent already bound to an attempt');
    s.agent_id=agentId;s.status='running';return save(db,run,{type:'bound',step,agent_id:agentId});});
}
function report(db,id,step,result) {
  text(result?.summary,'result summary');strings(result.evidence,'evidence');strings(result.changed_files,'changed_files');
  need(typeof result.verified==='boolean','verified must be boolean');
  need(!result.verified||result.evidence.length>0,'Verified result requires evidence');
  return tx(db,()=>{const run=getRun(db,id),s=stepFor(run,step);
    need(s.agent_id&&s.status==='running'&&!s.closed,'Report requires an open running attempt; recorded outcomes are terminal');
    need(result.agent_id===s.agent_id&&result.call_id===s.call_id,'Report agent/call does not match the active attempt');
    if(run.runtime==='claude'&&result.verified){
      need(result.execution_complete===true,'Claude report requires native completion confirmation');text(result.completion_evidence,'completion evidence');
      need(typeof result.observed_model==='string'&&result.observed_model.startsWith('claude-'+s.model+'-'),'Observed Claude model differs from plan');
      if(s.reasoning_effort!=='default')need(result.observed_effort===s.reasoning_effort,'Observed Claude effort differs from plan');
      if(s.stop_observed?.effort&&s.reasoning_effort!=='default')need(s.stop_observed.effort===s.reasoning_effort,'Hook-observed effort differs from plan');
    }
    s.result=structuredClone(result);s.status=result.verified?'completed':'failed';
    if(run.runtime==='claude'&&result.execution_complete===true){text(result.completion_evidence,'completion evidence');s.closed=true;}
    return save(db,run,{type:'report',step,agent_id:s.agent_id,result:s.result});});
}
function markClosed(db,agentId) {
  return tx(db,()=>{const run=listRuns(db).find(r=>r.steps.some(s=>s.agent_id===agentId));
    need(run,'Unknown agent');const s=run.steps.find(s=>s.agent_id===agentId);
    s.closed=true;if(s.status==='running')s.status='failed';
    return save(db,run,{type:'closed',step:s.id,agent_id:agentId});});
}
function fail(db,id,step,reason,callId) {
  text(reason,'failure reason');text(callId,'tool call_id');
  return tx(db,()=>{const run=getRun(db,id),s=stepFor(run,step);
    need(s.call_id===callId,'Failure call_id does not match active attempt');
    need(['dispatching','running'].includes(s.status),'No active attempt to fail');
    s.status='failed';if(!s.agent_id)s.closed=true;
    return save(db,run,{type:'failed',step,reason});});
}
function retry(db,id,step,revision) {
  need(revision&&Object.keys(revision).every(k=>['model','reasoning_effort','reason'].includes(k)),'Unsupported retry field');
  text(revision.reason,'replan reason');
  return tx(db,()=>{const run=getRun(db,id),s=stepFor(run,step);
    modelPair(revision.model,revision.reasoning_effort,run.runtime||'codex');
    need(s.status==='failed'&&s.closed,'Failed agent must be closed before retry');
    need(s.attempts<policy.max_attempts,'Attempt limit reached');
    s.model=revision.model;s.reasoning_effort=revision.reasoning_effort;s.reason=revision.reason;
    s.status='pending';s.agent_id=null;s.result=null;
    return save(db,run,{...revision,type:'retry-planned',step});});
}
function revise(db,id,step,revision) {
  text(revision?.change_reason,'change_reason');
  const allowed=['task','model','reasoning_effort','reason','depends_on','read_paths','write_paths','acceptance'];
  need(Object.keys(revision).every(k=>allowed.includes(k)||k==='change_reason'),'Unsupported revision field');
  return tx(db,()=>{const run=getRun(db,id),s=stepFor(run,step);
    need(s.status==='pending','Only pending steps can be revised');
    const patch=Object.fromEntries(Object.entries(revision).filter(([k])=>allowed.includes(k)));
    validatePlan({...run,steps:run.steps.map(t=>t.id===step?{...t,...patch}:t)},run.session);
    Object.assign(s,patch);return save(db,run,{type:'revised',step,revision});
  });
}
function observeClaudeStop(db,session,agentId,details) {
  return tx(db,()=>{const run=listRuns(db,session).find(r=>r.runtime==='claude'&&r.steps.some(s=>s.agent_id===agentId));
    if(!run)return null;const s=run.steps.find(s=>s.agent_id===agentId);
    if(s.closed)return run;
    s.stop_observed={agent_id:agentId,call_id:s.call_id,effort:details.effort||null,transcript_path:details.transcript_path||null};
    return save(db,run,{type:'stop-observed',step:s.id,agent_id:agentId,call_id:s.call_id});
  });
}
module.exports={openDb,createRun,getRun,listRuns,prepare,parseTask,reserve,bind,report,markClosed,fail,retry,revise,observeClaudeStop};
