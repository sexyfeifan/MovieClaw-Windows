const test=require('node:test'), assert=require('node:assert/strict'), vm=require('node:vm'), fs=require('node:fs'), path=require('node:path');
function load(request=async()=>({data:null})) {
  let position=12; const calls=[], owner={session:{username:'alice'}};
  const player={generation:1,activeEngine:'mpv',context:{media_item_id:7},currentSegments:[],engPos:()=>position,engSeekTo:value=>{calls.push(value);position=value;}};
  const API={baseUrl:'https://nas.example',contextEpoch:1,request};
  const context=vm.createContext({window:{},API,App:owner,document:{getElementById:()=>null},setTimeout:()=>0,clearTimeout(){}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../ui/desktop/auto-skip.js'),'utf8'),context);
  return {skip:context.window.DesktopAutoSkip,player,API,owner,calls,setPosition:value=>position=value};
}
test('server preference automatically skips ads and learned intros once on the common file clock',()=>{
  const h=load();h.player.currentSegments=[{type:'ad',start_ms:10000,end_ms:20000}];
  h.skip.attach(h.player,{auto_skip:{enabled:true,intro:false}});
  assert.equal(h.skip.check(h.player),true);assert.deepEqual(h.calls,[20]);
  h.setPosition(12);assert.equal(h.skip.check(h.player),false);
  h.player.currentSegments=[{type:'intro',start_ms:10000,end_ms:20000}];
  h.skip.attach(h.player,{auto_skip:{enabled:true,intro:true}});assert.equal(h.skip.check(h.player),true);
});
test('disabled preference, unknown intros, outros and short remainders remain manual',()=>{
  for(const [type,prefs,position] of [['ad',{enabled:false},12],['intro',{enabled:true,intro:false},12],['outro',{enabled:true},12],['ad',{enabled:true},18]]){
    const h=load();h.setPosition(position);h.player.currentSegments=[{type,start_ms:10000,end_ms:20000}];
    h.skip.attach(h.player,{auto_skip:prefs});assert.equal(h.skip.check(h.player),false);assert.deepEqual(h.calls,[]);
  }
});
test('manual intro persists to its own series and a late preference cannot enter another account',async()=>{
  let release;const requests=[];const h=load((route,args)=>{requests.push([route,args]);return new Promise(resolve=>release=resolve);});
  const intro={type:'intro',start_ms:10000,end_ms:20000};h.player.currentSegments=[intro];
  h.skip.attach(h.player,{auto_skip:{enabled:true,intro:false}});const pending=h.skip.manual(h.player,intro);
  assert.equal(requests[0][0],'/playback/auto-skip/intro/7');assert.equal(requests[0][1].body.enabled,true);
  h.owner.session.username='bob';release({});await pending;assert.equal(h.skip.check(h.player),false);
  h.skip.reset();assert.equal(h.skip.check(h.player),false);
});
