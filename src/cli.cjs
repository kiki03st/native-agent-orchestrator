'use strict';
const fs=require('node:fs');
const e=require('./engine.cjs');
let db;
try {
  const args=process.argv.slice(2);
  const at=args.indexOf('--input');let filename;
  if(at!==-1){filename=args[at+1];if(!filename)throw new Error('--input needs a UTF-8 JSON file');args.splice(at,2);}
  const [command,a,b,c,d]=args;
  const input=()=>JSON.parse(fs.readFileSync(filename||0,'utf8').replace(/^\uFEFF/,''));
  db=e.openDb();let result;
  switch(command){
    case 'create':result=e.createRun(db,input(),a);break;
    case 'prepare':result=e.prepare(db,a,b);break;
    case 'show':result=e.getRun(db,a);break;
    case 'list':if(!a)throw new Error('list needs SESSION_ID');result=e.listRuns(db,a);break;
    case 'bind':result=e.bind(db,a,b,c,d);break;
    case 'report':result=e.report(db,a,b,input());break;
    case 'closed':result=e.markClosed(db,a);break;
    case 'fail':{const value=input();result=e.fail(db,a,b,value.reason,value.call_id);break;}
    case 'retry':result=e.retry(db,a,b,input());break;
    case 'revise':result=e.revise(db,a,b,input());break;
    case 'inspect-claude':result=require('./claude-adapter.cjs').inspect(db,a,b);break;
    case 'memory-read':result=require('./memory.cjs').read(db.orch_filename,a);break;
    case 'memory-write':result=require('./memory.cjs').write(db,a,b,input());break;
    default:throw new Error('Commands: create, prepare, show, list, bind, report, closed, fail, retry, revise, inspect-claude, memory-read, memory-write');
  }
  process.stdout.write(JSON.stringify(result)+'\n');
} catch(error){process.stdout.write(JSON.stringify({error:error.message})+'\n');process.exitCode=1;}
finally{db?.close();}
