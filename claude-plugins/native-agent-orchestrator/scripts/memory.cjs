'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const fields=['goals','decisions','constraints','facts','evidence','assumptions','questions','next_actions','detail_references'];
const titles={goals:'Goals',decisions:'User decisions',constraints:'Constraints',facts:'Verified facts',evidence:'Evidence',assumptions:'Assumptions',questions:'Open questions',next_actions:'Next actions',detail_references:'Detail references'};
const fail=message=>{throw new Error(message);};
function runId(value){if(typeof value!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value))fail('Invalid run ID');return value;}
function pathFor(filename,id){
  if(typeof filename!=='string'||!path.isAbsolute(filename))fail('Memory requires an absolute SQLite filename');
  const database=createHash('sha256').update(path.resolve(filename)).digest('hex').slice(0,16);
  return path.join(path.dirname(path.resolve(filename)),'memory',database,runId(id),'current.md');
}
function validState(state){
  if(!state||typeof state!=='object'||Array.isArray(state)||Object.keys(state).length!==fields.length||fields.some(key=>!Object.hasOwn(state,key)))fail('Invalid memory state');
  for(const key of fields){const values=state[key];if(!Array.isArray(values)||values.length>20||values.some(value=>typeof value!=='string'||!value.trim()||value.length>500||/[\r\n]/.test(value)))fail('Invalid memory '+key);}
  for(const ref of state.detail_references)if(path.isAbsolute(ref)||path.win32.isAbsolute(ref)||ref.includes('..')||/^[\\/]|[\0-\x1f]/.test(ref))fail('Invalid detail reference');
  const normalized=Object.fromEntries(fields.map(key=>[key,state[key].map(value=>value.trim())]));
  if(JSON.stringify(normalized).length>6000)fail('Memory state is too large');return normalized;
}
function revision(state){return createHash('sha256').update(JSON.stringify(state)).digest('hex');}
function content(id,state){
  const meta={version:1,run_id:id,revision:revision(state)};
  return `<!-- native-agent-orchestrator-memory ${JSON.stringify(meta)} -->\n\n# Current task state\n\n`+fields.map(key=>`## ${titles[key]}\n\n${state[key].length?state[key].map(value=>`- ${value}`).join('\n')+'\n':''}`).join('\n');
}
function parse(filename,id,source){
  const lines=source.split(/\r?\n/);let at=0;
  const match=/^<!-- native-agent-orchestrator-memory (\{.*\}) -->$/.exec(lines[at++]||'');if(!match)fail('Invalid memory record');
  let meta;try{meta=JSON.parse(match[1]);}catch{fail('Invalid memory record');}
  if(meta?.version!==1||meta.run_id!==id||typeof meta.revision!=='string'||lines[at++]!==''||lines[at++]!=='# Current task state'||lines[at++]!=='')fail('Invalid memory record');
  const state={};for(const key of fields){
    if(lines[at++]!==`## ${titles[key]}`||lines[at++]!=='')fail('Invalid memory record');
    const values=[];while(at<lines.length&&lines[at]!==''){const line=lines[at++];if(!line.startsWith('- '))fail('Invalid memory record');values.push(line.slice(2));}
    if(lines[at++]!=='')fail('Invalid memory record');state[key]=values;
  }
  if(at!==lines.length)fail('Invalid memory record');const normalized=validState(state);
  if(meta.revision!==revision(normalized)||source!==content(id,normalized))fail('Invalid memory record');
  return {path:pathFor(filename,id),revision:meta.revision,state:normalized,content:source};
}
function read(filename,id){const target=pathFor(filename,id);if(!fs.existsSync(target))return null;if(fs.statSync(target).size>32*1024)fail('Memory record is too large');return parse(filename,id,fs.readFileSync(target,'utf8'));}
function runFor(db,id){const row=db.prepare('SELECT session,data FROM runs WHERE id=?').get(id);if(!row)fail('Unknown run');return {session:row.session,data:JSON.parse(row.data)};}
function write(db,id,session,{expected_revision,state}){
  if(!db?.orch_filename)fail('Memory requires the opened SQLite filename');runId(id);if(typeof session!=='string'||!session.trim())fail('Memory owner session is required');
  const target=pathFor(db.orch_filename,id);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
  db.exec('BEGIN IMMEDIATE');
  try{
      const run=runFor(db,id);if(run.session!==session)fail('Memory owner session differs');
      const collaboration=run.data.runtime==='codex'&&run.data.codex_contract==='collaboration';
      if(run.data.steps.some(step=>step.status!=='pending'&&!step.closed&&!(collaboration&&step.execution_complete===true)))fail('Cannot update memory while the owner has an active worker');
      const previous=read(db.orch_filename,id);if((previous?previous.revision:null)!==(expected_revision??null))fail('Memory revision is stale');
      const normalized=validState(state),temporary=target+'.'+process.pid+'.'+randomUUID()+'.tmp';
      try{fs.writeFileSync(temporary,content(id,normalized),{encoding:'utf8',mode:0o600});fs.renameSync(temporary,target);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
      db.exec('COMMIT');return {path:target,revision:revision(normalized)};
  }catch(error){db.exec('ROLLBACK');throw error;}
}
module.exports={pathFor,read,write};
