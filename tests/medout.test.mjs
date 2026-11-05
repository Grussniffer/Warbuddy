import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const core = createRequire(import.meta.url)('../src/core.cjs');
const start = '2026-11-05T12:00:00.000Z';
const scope = { ownerFactionId: '10', enemyFactionId: '20', warStartedAt: start };
const assignment = (playerId='1',targetId='2',plannedHits=20,completedHits=0,status='active') => ({
  id:'assignment-'+playerId,playerId,playerName:playerId==='1'?'Me':'Contact',targetId,targetName:'Opponent',plannedHits,completedHits,status,
});
const plan = () => ({
  ...scope,warId:'10:20:'+Date.parse(start),enabled:true,available:true,readOnly:false,revision:1,hitLimit:20,defaultCapacity:40,
  targets:[],assignments:[],alliedMembers:[{id:'1',name:'Me'},{id:'3',name:'Contact'}],enemyMembers:[{id:'2',name:'Opponent'},{id:'4',name:'Other opponent'}],
});

test('Medout protection names all unfinished buddies and allows any of them, including an offline partner',()=>{
  const buddies=[{playerId:'3',playerName:'Contact',remainingHits:12,online:true},{playerId:'1',playerName:'Me',remainingHits:8,online:false},{playerId:'4',playerName:'Finished',remainingHits:0,online:true}];
  const dibs={medoutProtection:{'2':{buddies}}};
  const stranger=core.medoutDibsRestriction(dibs,2,'9');
  assert.equal(stranger.protected,true);assert.equal(stranger.blocked,true);
  assert.deepEqual(stranger.buddies,buddies.slice(0,2));assert.deepEqual(stranger.onlineBuddies,[buddies[0]]);
  assert.equal(stranger.reason,'Reserved for medout buddies Contact, Me while a buddy is online.');
  assert.equal(core.medoutDibsRestriction(dibs,2,'1').blocked,false);
  assert.equal(core.medoutDibsRestriction(dibs,2,'4').blocked,true,'a completed partner has no exemption');
});
test('protection lifts when no unfinished partner is online and absent/old-server data stays safe',()=>{
  for(const dibs of [null,{}, {medoutProtection:{'2':{}}}, {medoutProtection:{'2':{buddies:[{playerId:'1',remainingHits:5,online:false},{playerId:'3',remainingHits:0,online:true}]}}}]){
    assert.deepEqual(core.medoutDibsRestriction(dibs,2,'9'),{protected:false,blocked:false,reason:'',buddies:[],onlineBuddies:[]});
  }
});
test('plans are scoped to the viewing faction, opponent and exact war start, including scheduled or disabled plans',()=>{
  const value=plan();assert.equal(core.medoutPlanMatches(value,scope),true);
  assert.equal(core.medoutPlanMatches({...value,enabled:false},scope),true,'matching does not implicitly enable the feature');
  for(const patch of [{ownerFactionId:'20',enemyFactionId:'10'},{enemyFactionId:'30'},{warId:'10:20:old'}])assert.equal(core.medoutPlanMatches({...value,...patch},scope),false);
  for(const context of [{},{...scope,ownerFactionId:''},{...scope,enemyFactionId:'10'},{...scope,warStartedAt:'invalid'}])assert.equal(core.medoutPlanMatches(value,context),false);
  assert.equal(core.medoutPlanMatches(null,scope),false);
  assert.equal(core.medoutPlanMatches(value,null),false);
  const reversed={ownerFactionId:'41309',enemyFactionId:'11162',warStartedAt:'2030-01-01T00:00:00Z'};
  assert.equal(core.medoutPlanMatches({...value,...reversed,warId:'11162:41309:'+Date.parse(reversed.warStartedAt)},reversed),true);
});
test('released completed hits still consume allowances and opponent capacity; quick reserve takes the lower remaining amount',()=>{
  const value=plan();value.targets=[{targetId:'2',contactStatus:'agreed',contactPlayerId:'3',capacity:30}];
  value.assignments=[assignment('3','2',22),assignment('1','4',20,5,'released')];
  const target=core.medoutTarget(value,2,1);
  assert.equal(target.canReserve,true);assert.equal(target.playerRemainingHits,15);assert.equal(target.remaining,8);assert.equal(target.plannedHits,8);
  value.assignments.push(assignment('8','2',20,4,'released'));
  assert.equal(core.medoutTarget(value,2,1).plannedHits,4,'unused released reservation does not consume capacity');
  value.assignments.push(assignment('1','4',20,14,'completed'));
  assert.equal(core.medoutTarget(value,2,1).plannedHits,1,'completed own hits across targets consume the war allowance');
});
test('unconfirmed conversations block duplicate contacts while agreed capacity supports several buddies',()=>{
  const value=plan();value.assignments=[assignment('3','2',10)];
  for(const status of ['uncontacted','contacted']){
    value.targets=[{targetId:'2',contactStatus:status,contactPlayerId:'3'}];
    const target=core.medoutTarget(value,2,1);
    assert.equal(target.canReserve,false);assert.match(target.reason,/already handling contact/);assert.equal(target.contactName,'Contact');
  }
  value.targets[0].contactStatus='agreed';
  assert.equal(core.medoutTarget(value,2,1).canReserve,true);assert.equal(core.medoutTarget(value,2,1).plannedHits,20);
});
test('declined, unavailable, full, former-roster, paused, disabled and exhausted states cannot reserve',()=>{
  for(const scenario of ['declined','unavailable','full','left','readOnly','unavailable-plan','disabled','allowance']){
    const value=plan();
    if(['declined','unavailable'].includes(scenario))value.targets=[{targetId:'2',contactStatus:scenario}];
    if(scenario==='full')value.assignments=[assignment('3','2',40)];
    if(scenario==='left')value.enemyMembers=[];
    if(scenario==='readOnly')value.readOnly=true;
    if(scenario==='unavailable-plan')value.available=false;
    if(scenario==='disabled')value.enabled=false;
    if(scenario==='allowance')value.assignments=[assignment('1','4',20,20,'completed')];
    const target=core.medoutTarget(value,2,1);assert.equal(target.canReserve,false,scenario);assert.ok(target.reason,scenario);
  }
  assert.equal(core.medoutTarget(null,2,1).canReserve,false);
});
test('a current buddy is identified separately from the right to reserve another opponent',()=>{
  const value=plan();value.assignments=[assignment()];
  const mine=core.medoutTarget(value,2,'1');assert.equal(mine.isMine,true);assert.equal(mine.canReserve,false);assert.equal(mine.label,'Your buddy');
  const other=core.medoutTarget(value,4,'1');assert.equal(other.isMine,false);assert.equal(other.canReserve,false);assert.match(other.reason,/release your current buddy/);
});
test('own contact gets the personalized introduction and progress uses the confirmed total without summing observation sources',()=>{
  const value=plan();value.targets=[{targetId:'2',contactStatus:'uncontacted',contactPlayerId:'1'}];
  value.assignments=[{...assignment('1','2',20,7),observedHits:7,manualReportedHits:7}];
  const personal=core.medoutPersonal(value,1);
  assert.equal(personal.targetId,'2');assert.equal(personal.targetName,'Opponent');assert.equal(personal.assignmentId,'assignment-1');
  assert.equal(personal.isContact,true);assert.equal(personal.contactName,'Me');assert.equal(personal.reservedHits,20);assert.equal(personal.completedHits,7);assert.equal(personal.remainingHits,13);
  assert.equal(personal.statusLabel,'Send the introduction');assert.equal(personal.introduction,core.medoutMessage('Opponent',20));
});
test('another contact is named, and contacted/agreed targets are never prompted for another introduction',()=>{
  const value=plan();value.assignments=[assignment()];value.targets=[{targetId:'2',contactStatus:'uncontacted',contactPlayerId:'3'}];
  const personal=core.medoutPersonal(value,'1');assert.equal(personal.isContact,false);assert.equal(personal.contactName,'Contact');assert.equal(personal.introduction,'');
  value.targets[0].contactPlayerId='1';
  for(const status of ['contacted','agreed','declined','unavailable']){value.targets[0].contactStatus=status;assert.equal(core.medoutPersonal(value,'1').introduction,'');}
  assert.equal(core.medoutPersonal({...value,assignments:[]},'1'),null);
});
test('paused plans keep saved buddy details without allowing claims, while a departed opponent needs a new buddy',()=>{
  const value=plan();value.assignments=[assignment()];value.targets=[{targetId:'2',contactStatus:'uncontacted',contactPlayerId:'1'}];
  const paused=core.medoutPersonal({...value,readOnly:true,reason:'Waiting for current war information.'},'1');
  assert.equal(paused.statusLabel,'Updates paused');assert.equal(paused.remainingHits,20);assert.equal(paused.readOnly,true);
  const departed=core.medoutPersonal({...value,enemyMembers:[]},'1');assert.equal(departed.statusLabel,'Choose another buddy');assert.equal(departed.introduction,'');
  assert.equal(core.medoutPersonal({...value,enabled:false},'1').introduction,'');
  assert.equal(core.medoutPersonal({...value,available:false},'1').introduction,'');
});
test('the introduction matches the existing frontend message exactly',()=>{
  const expected="Hi Opponent! I'm allowed 20 hits in our termed war. Want to be medout buddies? Unequip weapons/armour and med out; I'll do the same. Let's leave each other.\n\nWe could use Small First Aid Kits to save some med cooldown too, if they're enough to get us out :)";
  assert.equal(core.medoutMessage('Opponent',20),expected);
});
test('presentation derivations leave the shared snapshots unchanged',()=>{
  const value=plan();value.assignments=[assignment()];value.targets=[{targetId:'2',contactStatus:'agreed',contactPlayerId:'1'}];
  const dibs={medoutProtection:{'2':{buddies:[{playerId:'1',playerName:'Me',remainingHits:10,online:true}]}}};
  const before=JSON.stringify({value,dibs});
  core.medoutTarget(value,2,1);core.medoutPersonal(value,1);core.medoutDibsRestriction(dibs,2,1);core.medoutPlanMatches(value,scope);
  assert.equal(JSON.stringify({value,dibs}),before);
});
