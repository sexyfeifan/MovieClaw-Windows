const {test,expect}=require('@playwright/test');
const {openDesktop,state}=require('./helpers.cjs');
const app=(id,label,nav=true)=>({id,name:label,nav,base:`/api/v1/plugins/${id}/web/`,entries:[{label,path:''}]});
const patch=(request,data)=>request.post('/__test/friends',{data});
const ready=page=>expect.poll(()=>page.evaluate(()=>!!App.session && !App._authPending)).toBe(true);

test('plugin entries follow installation, navigation permissions and uninstall without a dead legacy entry',async({page,request})=>{
  await openDesktop(page,request);await ready(page);
  await expect(page.locator('#pluginNav')).toBeHidden();await expect(page.locator('#btnBrowseFriends')).toBeHidden();
  await patch(request,{pluginApps:[app('watch-friends','映迹'),app('movie-voice','寻映'),app('private-app','私有',false)]});
  await page.evaluate(()=>DesktopPlugins.refresh(true));
  await expect(page.locator('#pluginNav button')).toHaveText(['映迹','寻映']);
  await page.getByRole('button',{name:'映迹',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.__fixture.calls.filter(v=>v.command==='open_plugin_page').at(-1)?.args.entryId)).toBe('watch-friends');
  await page.locator('[data-page="settings"]').click();
  await expect(page.locator('#openWatchFriends')).toBeVisible();await expect(page.locator('#setFriendsShare')).toHaveCount(0);
  const count=(await state(request)).requests.filter(v=>v.path.startsWith('/plugins/watch-presence')).length;
  await page.locator('#openWatchFriends').click();
  expect((await state(request)).requests.filter(v=>v.path.startsWith('/plugins/watch-presence'))).toHaveLength(count);
  await patch(request,{pluginApps:[]});await page.evaluate(()=>DesktopPlugins.refresh(true));
  await expect(page.locator('#pluginNav')).toBeHidden();await expect(page.locator('#btnBrowseFriends')).toBeHidden();
  await expect(page.locator('#openWatchFriends')).toHaveCount(0);
  await page.locator('[data-page="home"]').click();await page.locator('[data-page="settings"]').click();
  await expect(page.locator('.friends-settings')).toContainText('服务器未提供当前账号可用');
  await expect(page.locator('#openWatchFriends')).toHaveCount(0);
});
test('plugin labels are text, hidden entries stay hidden and late results cannot cross accounts',async({page,request})=>{
  await openDesktop(page,request,{pluginApps:[app('movie-voice','<img src=x onerror=alert(1)>'),app('watch-friends','映迹')],nav:{hidden:['app:watch-friends:0']}});await ready(page);
  await expect(page.locator('#pluginNav button')).toHaveText(['<img src=x onerror=alert(1)>']);
  await expect(page.locator('#pluginNav img')).toHaveCount(0);
  await page.route('**/api/v1/ui/apps',async route=>{await new Promise(resolve=>setTimeout(resolve,250));await route.fulfill({json:{data:[app('stale-app','旧账号')]}});});
  await page.evaluate(()=>{DesktopPlugins.load();API.contextEpoch++;DesktopPlugins.reset();DesktopPlugins.nav();});
  await page.waitForTimeout(350);await expect(page.locator('#pluginNav')).toBeHidden();
});
test('plugin movie links resolve current-account source metadata before native playback and ignore stale sessions',async({page,request})=>{
  await openDesktop(page,request);await ready(page);
  await page.evaluate(()=>DesktopPlugins.route({path:'/play/1',epoch:API.contextEpoch}));
  await expect(page.locator('#playerView')).toBeVisible();
  await expect.poll(async()=>(await state(request)).requests.find(r=>r.path==='/playback/sessions')?.body.media_item_id).toBe(1);
  await page.locator('#playerBack').click();
  await page.evaluate(()=>DesktopPlugins.route({path:'/library/1/item/3',epoch:API.contextEpoch}));
  await expect(page.locator('.detail-title')).toContainText('第三季续播');
  const before=(await state(request)).requests.filter(r=>r.path==='/playback/sessions').length;
  await page.evaluate(()=>DesktopPlugins.route({path:'/play/1',epoch:API.contextEpoch-1}));
  expect((await state(request)).requests.filter(r=>r.path==='/playback/sessions')).toHaveLength(before);
});
test('plugin resource search opens explicitly without changing the saved sidebar preference',async({page,request})=>{
  await openDesktop(page,request,{catalog:true});await ready(page);
  await page.evaluate(()=>DesktopPlugins.route({path:'/search',query:'q=星海&private=1',epoch:API.contextEpoch}));
  await expect(page.locator('.catalog-page h1')).toHaveText('发现');
  await expect(page.locator('#catalogNav [data-page="discover"]')).toHaveCount(0);
  await expect.poll(async()=>(await state(request)).requests.find(r=>r.path==='/search/titles')?.body).toMatchObject({query:'星海',save_history:false});
});
async function play(page,request,options) {
  await openDesktop(page,request,options);await ready(page);
  await page.evaluate(async()=>{
    window.__fixture.props['time-pos']=12;
    await App.startPlayback({media_item_id:3,library_id:1,title:'测试剧',kind:'tv',seasonNumber:1,episodeNumber:1,startMs:0});
  });
  await expect(page.locator('#playerView')).toBeVisible();
}
const seekTo=page=>page.evaluate(()=>window.__fixture.calls.filter(v=>v.command==='send_mpv_command_embedded' && v.args.command[0]==='seek').map(v=>v.args.command[1]));
test('automatic ad skip and undo use the original file clock without skipping again',async({page,request})=>{
  await play(page,request,{segments:[{type:'ad',start_ms:10000,end_ms:30000}],autoSkip:{enabled:true,intro:false}});
  await expect.poll(()=>seekTo(page)).toContain(30);
  await expect(page.locator('#autoSkipFeedback')).toContainText('已跳过广告');
  await page.locator('#autoSkipFeedback button').click();
  await expect.poll(()=>seekTo(page)).toContain(12);
  await page.evaluate(()=>Player.checkSegments());
  expect((await seekTo(page)).filter(v=>v===30)).toHaveLength(1);
  await page.locator('#playerBack').click();await expect(page.locator('#autoSkipFeedback')).toBeHidden();
});
test('an automatic skip beyond the transcode buffer retains undo through both session restarts',async({page,request})=>{
  await play(page,request,{segments:[{type:'ad',start_ms:10000,end_ms:120000}],autoSkip:{enabled:true,intro:false}});
  await expect.poll(async()=>(await state(request)).created.length).toBe(2);
  await expect(page.locator('#autoSkipFeedback')).toContainText('已跳过广告');
  await expect.poll(()=>page.evaluate(()=>Player.activeEngine)).toBe('mpv');
  await page.evaluate(()=>{window.__fixture.props['time-pos']=0;});
  await page.locator('#autoSkipFeedback button').click();
  await expect.poll(async()=>(await state(request)).created.length).toBe(3);
  await expect.poll(()=>page.evaluate(()=>Player.activeEngine)).toBe('mpv');
  await expect(page.locator('#autoSkipFeedback')).toBeHidden();
  await page.evaluate(()=>Player.checkSegments());
  const starts=(await state(request)).requests.filter(r=>r.path==='/playback/sessions').map(r=>r.body.start_ms);
  expect(starts).toEqual([0,120000,12000]);
});
test('manual intro learns the series preference, and undo disables it on the server',async({page,request})=>{
  await play(page,request,{segments:[{type:'intro',start_ms:10000,end_ms:30000}],autoSkip:{enabled:true,intro:false}});
  await expect(page.locator('#playerSkipBtn')).toBeVisible();await page.locator('#playerSkipBtn').click();
  await expect(page.locator('#autoSkipFeedback')).toContainText('以后这部剧自动跳片头');
  expect((await state(request)).autoSkip.intro).toBe(true);
  await page.locator('#autoSkipFeedback button').click();await expect.poll(async()=>(await state(request)).autoSkip.intro).toBe(false);
});
test('learned intro automatically skips and undo returns to the prior position and disables learning',async({page,request})=>{
  await play(page,request,{segments:[{type:'intro',start_ms:10000,end_ms:30000}],autoSkip:{enabled:true,intro:true}});
  await expect(page.locator('#autoSkipFeedback')).toContainText('已跳过片头');
  await page.locator('#autoSkipFeedback button').click();
  await expect.poll(()=>seekTo(page)).toContain(12);expect((await state(request)).autoSkip.intro).toBe(false);
});
test('global auto-skip follows the server, restores a failed setting, and takes effect after a successful save',async({page,request})=>{
  await play(page,request,{segments:[{type:'ad',start_ms:10000,end_ms:30000}],autoSkip:{enabled:false,intro:false},autoSkipError:true});
  await page.evaluate(()=>Player.checkSegments());expect(await seekTo(page)).not.toContain(30);
  await page.locator('#btnSettings').click();
  const toggle=page.getByLabel('自动跳过广告、预告和已记住的片头',{exact:true});
  await expect(toggle).not.toBeChecked();await toggle.check();
  await expect(page.locator('#autoSkipFeedback')).toContainText('设置未保存');
  await expect(toggle).not.toBeChecked();await expect(toggle).toBeEnabled();
  expect((await state(request)).autoSkip.enabled).toBe(false);
  await patch(request,{autoSkipError:false});await toggle.check();
  await expect.poll(async()=>(await state(request)).autoSkip.enabled).toBe(true);
  await expect.poll(()=>seekTo(page)).toContain(30);
});
