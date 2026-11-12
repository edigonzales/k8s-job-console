import { chromium } from '@playwright/test';
import { signIn } from './login.ts';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await signIn(page, 'admin');
  const cookies = await page.context().cookies('http://127.0.0.1:4466');
  for (const cookie of cookies) {
    process.stdout.write([cookie.domain, 'FALSE', cookie.path, 'FALSE',
      Math.max(0, Math.floor(cookie.expires)), cookie.name, cookie.value].join('\t') + '\n');
  }
} finally {
  await browser.close();
}
