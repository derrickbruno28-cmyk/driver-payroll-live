const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync('Driver_Payroll.html','utf8');
function context(source=html){
  const nodes=new Map();
  const document={getElementById(id){if(!nodes.has(id)) nodes.set(id,{value:'',textContent:'',innerHTML:'',style:{},classList:{add(){},remove(){}},addEventListener(){}});return nodes.get(id);}};
  const c=vm.createContext({window:{PAYROLL_PREVIEW:true,crypto:require('node:crypto').webcrypto},document,structuredClone,console,setTimeout,clearTimeout,fetch:()=>new Promise(()=>{}),localStorage:{setItem(){}}});
  const script=source.match(/<script>\s*([\s\S]*?)<\/script>/)[1].split('// ─── INIT')[0];
  vm.runInContext(script,c);return c;
}
const run=(c,s)=>vm.runInContext(s,c);
const json=(c,s)=>JSON.parse(run(c,`JSON.stringify(${s})`));

test('legacy payroll calculations match the pre-PBR implementation',()=>{
  const current=context();
  const fixtures=JSON.parse(fs.readFileSync('test/fixtures/legacy-payroll.json','utf8'));
  for(const {section,flat,day,expected} of fixtures){
    const actual=json(current,`(()=>{const drv=makeDriver('Test',${flat});Object.assign(drv.days[0],${JSON.stringify(day)});computeDriver(drv,false,'${section}');return {total:drv._total,flag:drv._worstFlag,day:{pay:drv.days[0]._pay,hrs:drv.days[0]._hrs,flag:drv.days[0]._flag}}})()`);
    assert.deepEqual(actual,expected,JSON.stringify({section,flat,day}));
  }
});
test('six PBR rates, multiple trips, assist, and no local pay or OT stacking',()=>{
  const c=context();
  assert.deepEqual(json(c,'Object.values(PBR_LANES).map(l=>l.amount)'),[150,350,250,300,350,700]);
  run(c,"weeks=[makeWeek('2026-10-04')];let drv=makeDriver('PBR',300);weeks[0].sections.dallas=[drv];drv.days[1].pbrTrips=[newPbrTrip('austin',75),newPbrTrip('houston',90)];Object.assign(drv.days[1],{in:'06:00',out:'22:00',payFlag:'daily',driverAssist:100});computeDriver(drv,false,'dallas');");
  assert.equal(run(c,'drv._total'),615);
  assert.equal(run(c,'drv.days[1]._hrs'),null);
  assert.equal(run(c,'calcOTPremiumForWeek(weeks[0])'),0);
  assert.equal(run(c,'drv.days[2]._pay'),0);
  run(c,"PBR_LANES.austin.amount=999;computeDriver(drv,false,'dallas');");
  assert.equal(run(c,'drv._total'),615,'saved route amounts remain unchanged');
  assert.equal(run(c,'newPbrTrip("austin").routeAmount'),999);
});
test('local assist is added once and PBR replacement clears conflicting entries',()=>{
  const c=context();run(c,"let drv=makeDriver('Local',260);Object.assign(drv.days[0],{payFlag:'daily',driverAssist:75});computeDriver(drv,false,'satx');computeDriver(drv,false,'satx');");
  assert.equal(run(c,'drv._total'),335);
  run(c,"commitPbrDay(drv.days[0],[newPbrTrip('mcallen',75)]);computeDriver(drv,false,'satx');");
  assert.equal(run(c,'drv._total'),425);
  assert.deepEqual(json(c,'[drv.days[0].payFlag,drv.days[0].driverAssist,drv.days[0].rateOverride,drv.days[0].destination]'),['',0,null,'']);
  run(c,"commitPbrDay(drv.days[0],[]);computeDriver(drv,false,'satx');");
  assert.equal(run(c,'drv._total'),0,'deleting last trip does not resurrect old local pay');
});
test('summary and dashboard count repeated names and task-only payments once',()=>{
  const c=context();run(c,"weeks=[makeWeek('2026-10-04')];SECTIONS.forEach(s=>weeks[0].sections[s]=[]);let local=makeDriver('Alex',200),pbr=makeDriver(' ALEX ',null);local.days[0].payFlag='daily';pbr.days[0].pbrTrips=[newPbrTrip('austin',75)];weeks[0].sections.satx=[local];weeks[0].sections.dallas=[pbr];weeks[0].tasks=[{driver:'alex',pay:50},{driver:'Other',pay:20}];renderSummary();");
  const roll=json(c,'getWeekRollup(cw())');assert.equal(roll.total,495);assert.equal(roll.routeSpend,150);assert.equal(roll.assistPay,75);assert.equal(roll.taskPay,70);
  assert.deepEqual(json(c,'[...getWeekRollup(cw()).totalsByDriver.values()]'),[475,20]);
  assert.equal(run(c,"document.getElementById('sum-grand').textContent"),'$495.00');
});
test('old weeks load without PBR, roundtrip stays on departure day after reload, new weeks clear entries',()=>{
  const c=context();run(c,"weeks=[{startSunday:'2026-10-04',sections:{satx:[makeDriver('Local',260)]},tasks:[]}];ensureWeekShape(cw());cw().sections.dallas=[makeDriver('PBR',null)];cw().sections.dallas[0].days[6].pbrTrips=[newPbrTrip('amarillo',75)];weeks=JSON.parse(JSON.stringify(weeks));ensureWeekShape(cw());");
  assert.equal(run(c,'getWeekRollup(cw()).routeSpend'),700);
  assert.equal(run(c,'cw().sections.dallas[0].days[6]._pay'),775);
  assert.equal(run(c,'cw().sections.dallas[0].days[0]._pay'),0);
  const copied=json(c,'copyWeekDrivers(cw())');assert.equal(copied.satx[0].flat,260);assert.equal(copied.dallas[0].flat,null);assert.equal(copied.dallas[0].days.flatMap(d=>d.pbrTrips).length,0);assert.equal(copied.dallas[0].days.reduce((n,d)=>n+d.driverAssist,0),0);
});
test('preview cannot initialize socket or authentication and payout remains Friday',()=>{
  const preview=fs.readFileSync('preview/PBR_Payroll_Preview.html','utf8');
  assert.match(preview,/window.PAYROLL_PREVIEW=true/);assert.doesNotMatch(preview,/<script src="\/socket.io/);
  assert.match(html,/!PREVIEW && window.io/);assert.match(html,/if\(!PREVIEW\) fetch\('\/auth\/me'\)/);
  const c=context();run(c,"weeks=[makeWeek('2026-10-04')];updateWeekHeader();");
  assert.match(run(c,"document.getElementById('paydate-badge').textContent"),/Fri/);
});
test('pay replacement requires an explicit second save and rejects stale editors',()=>{
  const c=context();
  run(c,"weeks=[makeWeek('2026-10-04')];let drv=makeDriver('Local',260);cw().sections.satx=[drv];drv.days[1].payFlag='daily';drv.days[1].driverAssist=75;tripEditor={week:cw(),section:'satx',driver:drv,di:0,d:1,trips:[newPbrTrip('austin')]};document.getElementById('trip-assist-0-mode').value='0';document.getElementById('pbr-editor').close=()=>{};renderAll=()=>{};saveTripPanel();");
  assert.equal(run(c,'drv.days[1].pbrTrips.length'),0);
  assert.equal(run(c,'drv.days[1].driverAssist'),75);
  assert.equal(run(c,"document.getElementById('save-pbr-day').textContent"),'Replace day & save');
  run(c,'saveTripPanel();computeDriver(drv,false,"satx");');assert.equal(run(c,'drv._total'),150);
  run(c,"tripEditor.trips=[newPbrTrip('amarillo')];weeks=[makeWeek('2026-10-11')];saveTripPanel();");
  assert.match(run(c,"document.getElementById('trip-error').textContent"),/Payroll changed/);
  assert.equal(run(c,'drv.days[1].pbrTrips[0].routeAmount'),150);
});
test('custom assist rejects blank, negative and nonfinite amounts',()=>{
  const c=context();run(c,"document.getElementById('assist-mode').value='custom';");
  for(const amount of ['', '-1','Infinity','abc']){
    run(c,`document.getElementById('assist-amount').value=${JSON.stringify(amount)};`);
    assert.throws(()=>run(c,'readAssist("assist")'),/valid assist amount/);
  }
  run(c,"document.getElementById('assist-amount').value='95.25';");assert.equal(run(c,'readAssist("assist")'),95.25);
});

test('retired PBR roster moves intact to SATX exactly once',()=>{
  const c=context();run(c,"weeks=[makeWeek('2026-10-04')];cw().sections.satx=[makeDriver('Same',260)];cw().sections.pbr=[makeDriver('Same',null)];cw().sections.pbr[0].days[6].pbrTrips=[newPbrTrip('amarillo',75)];ensureWeekShape(cw());ensureWeekShape(cw());");
  assert.deepEqual(json(c,'SECTIONS'),['satx','dallas','memphis']);
  assert.equal(run(c,'cw().sections.satx.length'),2);
  assert.equal(run(c,'cw().sections.pbr'),undefined);
  assert.equal(run(c,'getWeekRollup(cw()).total'),775);
  assert.equal(json(c,'copyWeekDrivers(cw())').satx[1].flat,null);
  assert.doesNotMatch(html,/id="view-pbr"|switchView\('pbr'/);
  assert.match(html,/San Antonio PBR"><option value="__pbr"/);
});
