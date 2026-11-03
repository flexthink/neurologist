import {chromium} from 'playwright-core';
import {readFile} from 'node:fs/promises';
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE ?? '/Users/artem/Library/Caches/ms-playwright/chromium-1134/chrome-mac/Chromium.app/Contents/MacOS/Chromium'});
try {
  const page=await browser.newPage({viewport:{width:256,height:256},deviceScaleFactor:1});
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${await readFile('assets/neurologist.svg','utf8')}`);
  await page.locator('svg').screenshot({path:'assets/icon.png',omitBackground:true});
} finally {await browser.close();}
