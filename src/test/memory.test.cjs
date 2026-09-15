const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {spawn}=require('node:child_process');
const e=require('../engine.cjs');
const memory=require('../memory.cjs');
function setup(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-agent-memory-')),filename=path.join(dir,'state.sqlite'),db=e.openDb(filename);
  const step={id:'work',task:'Work',model:'gpt-5.6-terra',reasoning_effort:'medium',reason:'Test',depends_on:[],read_paths:[],write_paths:[],acceptance:['Done']};
  const run=e.createRun(db,{objective:'Memory',cwd:dir,steps:[step]},'parent');
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});return {dir,filename,db,run};
}
const state={goals:['Keep the current task usable'],decisions:['None'],constraints:['Owner writes only'],facts:['SQLite is the lifecycle source'],evidence:['docs/context-memory-plan.md'],assumptions:['Workers receive a path only'],questions:['Which result is next?'],next_actions:['Read this before planning'],detail_references:['details/evidence.md']};
test('stores bounded Markdown under its run beside SQLite and reads it back',t=>{
  const {filename,db,run}=setup(t),saved=memory.write(db,run.id,'parent',{expected_revision:null,state});
  assert.equal(saved.path,memory.pathFor(filename,run.id));
  const found=memory.read(filename,run.id);assert.equal(found.revision,saved.revision);assert.deepEqual(found.state,state);assert.match(found.content,/## Goals/);
});
test('round-trips empty sections and the literal None',t=>{
  const {filename,db,run}=setup(t),empty={...state,goals:[],constraints:[],decisions:['None']};
  memory.write(db,run.id,'parent',{expected_revision:null,state:empty});assert.deepEqual(memory.read(filename,run.id).state,empty);
});
test('rejects malformed records, unsafe references, and paths outside a run',t=>{
  const {filename,db,run}=setup(t);
  assert.throws(()=>memory.pathFor('relative.sqlite',run.id),/absolute/i);
  assert.throws(()=>memory.write(db,run.id,'parent',{expected_revision:null,state:{...state,detail_references:['../secret.md']}}),/reference/i);
  fs.mkdirSync(path.dirname(memory.pathFor(filename,run.id)),{recursive:true});fs.writeFileSync(memory.pathFor(filename,run.id),'<!-- native-agent-orchestrator-memory {bad} -->\n');
  assert.throws(()=>memory.read(filename,run.id),/invalid/i);
  fs.writeFileSync(memory.pathFor(filename,run.id),'x'.repeat(32*1024+1));assert.throws(()=>memory.read(filename,run.id),/large/i);
});
test('rejects stale and competing owner updates',t=>{
  const {db,run}=setup(t),first=memory.write(db,run.id,'parent',{expected_revision:null,state});
  const second=memory.write(db,run.id,'parent',{expected_revision:first.revision,state:{...state,next_actions:['Verify the change']}});
  assert.throws(()=>memory.write(db,run.id,'parent',{expected_revision:first.revision,state}),/stale/i);
  assert.throws(()=>memory.write(db,run.id,'other',{expected_revision:second.revision,state}),/owner/i);
});
test('refuses owner writes while its run has an active worker',t=>{
  const {db,run}=setup(t);e.reserve(db,e.prepare(db,run.id,'work'),'parent','call');
  assert.throws(()=>memory.write(db,run.id,'parent',{expected_revision:null,state}),/active worker/i);
});
test('CLI reads and writes the selected run record only',t=>{
  const {filename,dir,run}=setup(t),input=path.join(dir,'memory.json');fs.writeFileSync(input,JSON.stringify({expected_revision:null,state}));
  const cli=path.join(__dirname,'../cli.cjs'),env={...process.env,CODEX_ORCH_DB:filename};
  const write=spawnSync(process.execPath,[cli,'memory-write',run.id,'parent','--input',input],{encoding:'utf8',env});
  assert.equal(write.status,0,write.stdout);assert.equal(JSON.parse(write.stdout).path,memory.pathFor(filename,run.id));
  const read=spawnSync(process.execPath,[cli,'memory-read',run.id],{encoding:'utf8',env});
  assert.equal(read.status,0,read.stdout);assert.deepEqual(JSON.parse(read.stdout).state,state);
});
test('separates records for runs and SQLite files sharing a directory',t=>{
  const {dir,filename,db,run}=setup(t),step={id:'other',task:'Other',model:'gpt-5.6-terra',reasoning_effort:'medium',reason:'Test',depends_on:[],read_paths:[],write_paths:[],acceptance:['Done']};
  const second=e.createRun(db,{objective:'Other',cwd:dir,steps:[step]},'parent');memory.write(db,run.id,'parent',{expected_revision:null,state});memory.write(db,second.id,'parent',{expected_revision:null,state:{...state,goals:['Other goal']}});
  const otherFile=path.join(dir,'other.sqlite'),otherDb=e.openDb(otherFile),third=e.createRun(otherDb,{objective:'Third',cwd:dir,steps:[step]},'parent');
  memory.write(otherDb,third.id,'parent',{expected_revision:null,state});otherDb.close();
  assert.notEqual(memory.pathFor(filename,run.id),memory.pathFor(filename,second.id));assert.notEqual(memory.pathFor(filename,run.id),memory.pathFor(otherFile,third.id));
  assert.deepEqual(memory.read(filename,second.id).state.goals,['Other goal']);
});
test('separates copied SQLite ledgers with the same run ID',t=>{
  const {dir,filename,db,run}=setup(t);memory.write(db,run.id,'parent',{expected_revision:null,state});db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const copiedFile=path.join(dir,'copied.sqlite');fs.copyFileSync(filename,copiedFile);const copied=e.openDb(copiedFile);
  memory.write(copied,run.id,'parent',{expected_revision:null,state:{...state,goals:['Copied ledger']}});copied.close();
  assert.notEqual(memory.pathFor(filename,run.id),memory.pathFor(copiedFile,run.id));assert.deepEqual(memory.read(copiedFile,run.id).state.goals,['Copied ledger']);
});
test('round-trips valid Unicode state below the 6000-character ceiling',t=>{
  const {filename,db,run}=setup(t),unicode={...state,goals:Array.from({length:11},()=>'가'.repeat(500)),decisions:[],constraints:[],facts:[],evidence:[],assumptions:[],questions:[],next_actions:[],detail_references:[]};
  memory.write(db,run.id,'parent',{expected_revision:null,state:unicode});assert.deepEqual(memory.read(filename,run.id).state,unicode);
});
test('concurrent CLI writes allow one revision and reject the stale competitor',async t=>{
  const {filename,dir,run}=setup(t),input=path.join(dir,'memory.json'),cli=path.join(__dirname,'../cli.cjs'),env={...process.env,CODEX_ORCH_DB:filename};fs.writeFileSync(input,JSON.stringify({expected_revision:null,state}));
  const call=()=>new Promise(resolve=>{const child=spawn(process.execPath,[cli,'memory-write',run.id,'parent','--input',input],{env});let output='';child.stdout.on('data',data=>output+=data);child.on('close',code=>resolve({code,output}));});
  const results=await Promise.all([call(),call()]);assert.deepEqual(results.map(result=>result.code).sort(),[0,1]);assert.match(results.find(result=>result.code===1).output,/stale/i);
});
