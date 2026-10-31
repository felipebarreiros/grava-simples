import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRecordings, grantRecordingUpload } from '../server/storage/service.ts';
import { validateMetadata } from '../server/storage/validation.ts';
import { validateStoredTranscript } from '../server/storage/transcript.ts';
import { ApiError } from '../server/transcription/security.ts';

const id = '12345678-1234-4234-9234-123456789012';
const now = 1800000000000;
const request = (method='GET', body, query='') => new Request('https://studio.test/api/recordings'+query, { method, headers:{Authorization:'Bearer fixture',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}) });
const metadata = () => ({ id:'take-fixture',projectId:'project-fixture',projectName:'Projeto',name:'Gravação',createdAt:1,startedAt:1,stoppedAt:10001,durationMs:10000,warnings:[],landscape:{fileName:'landscape.mp4',mimeType:'video/mp4',size:1024},portrait:{fileName:'portrait.mp4',mimeType:'video/mp4',size:512} });
function fixture() {
  const calls = { signed:[], deleted:[], completed:0, removed:0, reserves:[], transcripts:[] };
  let record = {id,ownerId:'user_alice',localId:'take-fixture',metadata:metadata(),status:'pending',expiresAt:now+3600000,assets:['landscape','portrait'].map((orientation,index)=>({orientation,pathname:`recordings/user_alice/${id}/${orientation}.mp4`,expectedBytes:index?512:1024,contentType:'video/mp4'}))};
  const deps = { configured:true,authenticate:async()=>({userId:'user_alice'}),now:()=>now,quota:async()=>{},repository:{
    list:async()=>({recordings:[],usedBytes:0}),get:async()=>record,
    reserve:async(userId,metadata)=>{calls.reserves.push({userId,metadata});return record;},
    complete:async()=>{calls.completed++;record={...record,status:'ready'};return record;},
    markDeleting:async()=>{record={...record,status:'deleting'};return record;},
    remove:async()=>{calls.removed++;record=null;},
    getTranscript:async()=>({transcript:null,version:0}),
    saveTranscript:async(...args)=>{calls.transcripts.push(args);return {version:1};},
  },blob:{
    head:async(pathname)=>{ const asset=record.assets.find(a=>a.pathname===pathname); return {pathname,url:`https://fixture.private.blob.vercel-storage.com/${pathname}`,size:asset.expectedBytes,contentType:asset.contentType}; },
    signedGet:async pathname=>{calls.signed.push(pathname);return {url:'https://fixture.private.blob.vercel-storage.com/scoped?token=temporary',expiresAt:now+600000};},
    delete:async paths=>{calls.deleted.push(...paths);},
  }};
  return {deps,calls,get record(){return record;},set record(value){record=value;}};
}

test('storage authenticates before exposing configuration or querying the catalogue', async()=>{
  const {deps}=fixture();deps.configured=false;deps.authenticate=async()=>{throw new ApiError(401,'Entre novamente.');};deps.repository.list=()=>{throw new Error('must not query');};
  assert.equal((await handleRecordings(request(),deps)).status,401);
});
test('unconfigured storage is explicit to an authenticated account',async()=>{
  const {deps}=fixture();deps.configured=false;
  assert.equal((await (await handleRecordings(request(),deps)).json()).configured,false);
  assert.equal((await handleRecordings(request('POST',{action:'reserve'}),deps)).status,503);
});
test('reservation projects metadata and never trusts supplied owner or cloud identifiers',async()=>{
  const {deps,calls}=fixture();const take={...metadata(),ownerId:'user_bob',cloud:{id:'other'},secret:'omit'};
  const response=await handleRecordings(request('POST',{action:'reserve',take,projectName:'Projeto'}),deps);
  assert.equal(response.status,200);assert.equal(calls.reserves[0].userId,'user_alice');
  assert.equal(calls.reserves[0].metadata.ownerId,undefined);assert.equal(calls.reserves[0].metadata.cloud,undefined);assert.equal(calls.reserves[0].metadata.secret,undefined);
  const body=await response.json();assert.equal(body.uploads.landscape.uploaded,true);assert.equal(body.recording.id,id);
});
test('private upload grants are exact-path, account and orientation bound without overwrite',async()=>{
  const {deps,record}=fixture();const path=record.assets[0].pathname;
  const options=await grantRecordingUpload(deps,'user_alice',path,JSON.stringify({recordingId:id,orientation:'landscape'}));
  assert.equal(options.maximumSizeInBytes,1024);assert.deepEqual(options.allowedContentTypes,['video/mp4']);assert.equal(options.allowOverwrite,false);assert.equal(options.addRandomSuffix,false);
  assert.equal(options.validUntil,now+900000);
  await assert.rejects(()=>grantRecordingUpload(deps,'user_alice',path.replace('user_alice','user_bob'),JSON.stringify({recordingId:id,orientation:'landscape'})),e=>e.status===403);
  await assert.rejects(()=>grantRecordingUpload(deps,'user_bob',path,JSON.stringify({recordingId:id,orientation:'landscape'})),e=>e.status===404);
});
test('another account cannot sign, finalize, read transcripts or delete Alice media',async()=>{
  const {deps,calls}=fixture();deps.authenticate=async()=>({userId:'user_bob'});
  assert.equal((await handleRecordings(request('GET',null,`?recordingId=${id}&orientation=landscape`),deps)).status,404);
  assert.equal((await handleRecordings(request('POST',{action:'finalize',recordingId:id}),deps)).status,404);
  assert.equal((await handleRecordings(request('GET',null,`?recordingId=${id}&transcript=1`),deps)).status,404);
  assert.equal((await handleRecordings(request('DELETE',null,`?recordingId=${id}`),deps)).status,200);
  assert.deepEqual(calls.signed,[]);assert.deepEqual(calls.deleted,[]);assert.equal(calls.completed,0);assert.equal(calls.removed,0);
});
test('finalization verifies both physical objects before marking a recording ready',async()=>{
  const {deps,calls}=fixture();const response=await handleRecordings(request('POST',{action:'finalize',recordingId:id}),deps);
  assert.equal(response.status,200);assert.equal(calls.completed,1);assert.equal((await response.json()).recording.status,'ready');
});
test('finalization rejects wrong bytes, wrong path, public objects and incomplete outputs',async()=>{
  for(const mutation of [b=>({...b,size:1}),b=>({...b,pathname:b.pathname.replace('landscape','other')}),b=>({...b,url:b.url.replace('.private.','.public.')}),b=>({...b,contentType:'text/html'})]){
    const {deps,calls}=fixture();const head=deps.blob.head;deps.blob.head=async p=>mutation(await head(p));
    assert.equal((await handleRecordings(request('POST',{action:'finalize',recordingId:id}),deps)).status,409);assert.equal(calls.completed,0);
  }
  const f=fixture();f.record.assets.pop();assert.equal((await handleRecordings(request('POST',{action:'finalize',recordingId:id}),f.deps)).status,409);
});
test('ready media is signed only from the stored asset path and JSON responses disable caching',async()=>{
  const f=fixture();f.record.status='ready';const response=await handleRecordings(request('GET',null,`?recordingId=${id}&orientation=portrait`),f.deps);
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.deepEqual(f.calls.signed,[f.record.assets[1].pathname]);
});
test('failed object deletion leaves a retryable tombstone and never removes ownership metadata',async()=>{
  const f=fixture();f.deps.blob.delete=async()=>{throw new Error('private provider details');};
  const response=await handleRecordings(request('DELETE',null,`?recordingId=${id}`),f.deps);
  assert.equal(response.status,503);assert.equal(f.record.status,'deleting');assert.equal(f.calls.removed,0);assert.ok(!(await response.text()).includes('provider details'));
});
test('upload authorization and finalization reject expired or completed reservations',async()=>{
  const f=fixture();f.record.expiresAt=now-1;
  await assert.rejects(()=>grantRecordingUpload(f.deps,'user_alice',f.record.assets[0].pathname,JSON.stringify({recordingId:id,orientation:'landscape'})),e=>e.status===409);
  assert.equal((await handleRecordings(request('POST',{action:'finalize',recordingId:id}),f.deps)).status,409);
  f.record.status='ready';await assert.rejects(()=>grantRecordingUpload(f.deps,'user_alice',f.record.assets[0].pathname,JSON.stringify({recordingId:id,orientation:'landscape'})),e=>e.status===409);
});
test('metadata validates actual declared storage bounds and supported content types',()=>{
  const take=metadata();assert.equal(validateMetadata(take,'Projeto').landscape.size,1024);
  assert.throws(()=>validateMetadata({...take,portrait:{...take.portrait,size:536870913}},'Projeto'));
  assert.throws(()=>validateMetadata({...take,landscape:{...take.landscape,mimeType:'text/html'}},'Projeto'));
  assert.throws(()=>validateMetadata({...take,id:'../another-user'},'Projeto'));
  assert.throws(()=>validateMetadata({...take,thumbnail:'data:image/svg+xml;base64,AAAA'},'Projeto'));
});
test('transcript snapshots preserve alignment, reject invalid times and project unknown fields',async()=>{
  const transcript={version:1,origin:'automatic',sourceName:'audio.mp4',importedAt:1,updatedAt:2,cues:[{id:'cue-1',start:0,end:1,text:'Olá',originalText:'Ola',untrusted:'omit'}],words:[{id:'word-1',start:0,end:0.5,text:'Olá'}],unexpected:{secret:'omit'}};
  const safe=validateStoredTranscript(transcript,10000);assert.equal(safe.unexpected,undefined);assert.equal(safe.cues[0].untrusted,undefined);assert.equal(safe.cues[0].originalText,'Ola');
  assert.throws(()=>validateStoredTranscript({...transcript,words:[{id:'bad',start:1,end:0,text:'invalid'}]},10000));
  const f=fixture();f.record.status='ready';const response=await handleRecordings(request('POST',{action:'transcript',recordingId:id,expectedVersion:0,transcript}),f.deps);
  assert.equal(response.status,200);assert.equal(f.calls.transcripts[0][0],'user_alice');assert.equal(f.calls.transcripts[0][3],0);
  assert.equal((await handleRecordings(request('POST',{action:'transcript',recordingId:id,transcript}),f.deps)).status,400);
});
