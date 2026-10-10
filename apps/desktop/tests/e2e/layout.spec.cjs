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
