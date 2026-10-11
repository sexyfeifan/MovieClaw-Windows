const { test, expect } = require('@playwright/test');
const { openDesktop, browseLibrary } = require('./helpers.cjs');

for (const viewport of [{width:1280,height:800},{width:1440,height:900},{width:900,height:650}]) {
  test(`browsing layout, focus and reduced motion at ${viewport.width}x${viewport.height}`, async ({page,request},info) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({reducedMotion:'reduce'});
    const errors=[]; page.on('pageerror',error=>errors.push(error.message));
    await openDesktop(page,request,{searchPeople:true,homeRows:[{id:'row:collection',collection_id:8,name:'我的精选'}]});
    const shot=async name=>{
      const filename=info.outputPath(name+'.png'); await page.screenshot({path:filename});
      await info.attach(name,{path:filename,contentType:'image/png'});
    };
    await expect(page.locator('#heroBanner')).toBeVisible();
    expect(await page.locator('#content').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
    await shot('home');
    await page.locator('#accountButton').click(); await expect(page.locator('#accountPanel')).toBeVisible();
    const panel=await page.locator('#accountPanel').boundingBox(); expect(panel.x).toBeGreaterThanOrEqual(0); expect(panel.x+panel.width).toBeLessThanOrEqual(viewport.width);
    await shot('account-panel'); await page.keyboard.press('Escape');
    await browseLibrary(page);
    await page.keyboard.press('Tab');
    await page.locator('#posterGrid .poster-card').first().focus();
    const focusStyle=await page.locator('#posterGrid .poster-card').first().evaluate(el=>{
      const style=getComputedStyle(el); return {width:parseFloat(style.outlineWidth),style:style.outlineStyle};
    });
    expect(focusStyle.width).toBeGreaterThanOrEqual(2); expect(focusStyle.style).not.toBe('none');
    await shot('library-focus');
    await page.locator('#posterGrid .poster-card').first().hover(); await shot('card-hover');
    await page.locator('#posterGrid .poster-card').first().click(); await expect(page.locator('#btnPlay')).toBeVisible();
    await expect(page.locator('.person-card-avatar').first()).toHaveCSS('border-radius','50%');
    expect(await page.locator('.detail-hero-bg img').first().evaluate(el=>getComputedStyle(el).animationName)).toBe('none');
    await shot('detail');
    await page.locator('#searchInput').fill('演员'); await expect(page.locator('[data-search-person="9"]')).toBeVisible(); await shot('search');
    expect(await page.locator('#content').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('search waiting, failure retry and empty states remain visible and usable', async ({page,request},info) => {
  await page.setViewportSize({width:1280,height:800});
  await openDesktop(page,request);
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  let fail=true;
  await page.route('**/api/v1/search/library?**',async route=>{
    await gate;
    await route.fulfill({status:fail?503:200,contentType:'application/json',body:JSON.stringify(fail
      ?{code:'LIBRARY_UNAVAILABLE',message:'媒体索引暂不可用，请重试'}
      :{code:0,message:'ok',data:{query:'空结果',items:[],people:[],suggestions:[],next_cursor:null}})});
  });
  const shot=async name=>{
    const filename=info.outputPath(name+'.png'); await page.screenshot({path:filename});
    await info.attach(name,{path:filename,contentType:'image/png'});
  };
  try {
    await page.locator('#searchInput').fill('空结果');
    await expect(page.locator('#wallStatus')).toHaveText('加载中…'); await shot('search-waiting');
    release();
    await expect(page.locator('#wallStatus')).toContainText('媒体索引暂不可用');
    await expect(page.locator('#wallStatus button')).toHaveText('重试'); await shot('search-failed');
    fail=false; await page.locator('#wallStatus button').click();
    await expect(page.locator('#wallStatus')).toHaveText('这里还没有内容');
    await expect(page.locator('#posterGrid .poster-card')).toHaveCount(0); await shot('search-empty');
    expect(await page.locator('#content').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  } finally { release(); }
});

test('playback preferences have accessible names, visible keyboard focus and persistent values', async ({page,request}) => {
  await openDesktop(page,request);
  await page.locator('[data-page="settings"]').click();
  await page.keyboard.press('Tab');
  const preferences=[
    ['自动播放下一集','mc_autoNext','0'],
    ['硬件解码','mc_hwDecode','0'],
    ['播放时置顶','mc_alwaysOnTop','false'],
    ['窗口贴合画面','mc_fitWindow','false'],
  ];
  for (const [name,key,value] of preferences) {
    const checkbox=page.getByRole('checkbox',{name,exact:true});
    await expect(checkbox).toBeChecked();
    await checkbox.focus();
    const focus=await checkbox.evaluate(input=>{
      const style=getComputedStyle(input.nextElementSibling);
      return {width:parseFloat(style.outlineWidth),style:style.outlineStyle};
    });
    expect(focus.width).toBeGreaterThanOrEqual(2); expect(focus.style).not.toBe('none');
    await page.keyboard.press('Space');
    await expect(checkbox).not.toBeChecked();
    expect(await page.evaluate(key=>localStorage.getItem(key),key)).toBe(value);
  }
  await page.locator('[data-page="home"]').click();
  await page.locator('[data-page="settings"]').click();
  for (const [name] of preferences) await expect(page.getByRole('checkbox',{name,exact:true})).not.toBeChecked();
});

test('strict CSP preserves authenticated images, logo fallback and the person back button', async ({page,request}) => {
  const documentResponse=await request.get('/desktop/index.html');
  expect(documentResponse.headers()['content-security-policy']).toContain("script-src-attr 'none'");
  await page.addInitScript(()=>{
    window.__imageCspViolations=[];
    document.addEventListener('securitypolicyviolation',event=>window.__imageCspViolations.push(event.effectiveDirective));
  });
  await openDesktop(page,request,{images:true});
  await expect(page.locator('#heroIdentity .hero-title')).toBeVisible();
  await browseLibrary(page);
  const poster=page.locator('#posterGrid .poster-card').first().locator('img');
  await expect(poster).toHaveAttribute('src',/^data:image\/png/);
  await expect(poster).toHaveCSS('opacity','1');
  expect(await poster.evaluate(img=>img.naturalWidth)).toBeGreaterThan(0);
  await page.locator('#posterGrid .poster-card').first().click();
  await expect(page.locator('.detail-hero-bg img')).toHaveCSS('opacity','1');
  expect(await page.locator('.detail-hero-bg img').evaluate(img=>img.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator('#detailTitleFallback')).toBeVisible();
  await expect(page.locator('.detail-logo')).toBeHidden();
  await page.locator('.person-card[data-person-id="9"]').click();
  await expect(page.locator('.person-avatar')).toHaveCSS('opacity','1');
  expect(await page.locator('.person-avatar').evaluate(img=>img.naturalWidth)).toBeGreaterThan(0);
  await page.locator('#personBack').click();
  await expect(page.locator('#btnPlay')).toBeVisible();
  expect(await page.locator('[onload],[onerror],[onclick]').count()).toBe(0);
  expect(await page.evaluate(()=>window.__imageCspViolations)).toEqual([]);
});
