import { setTimeout as delay } from 'node:timers/promises';

export async function notify([event, job, encodedName, run, revision, status]: string[]) {
  const endpoint = process.env.WEBHOOK_URL;
  if (!endpoint) return;
  let target: URL;
  let payload: string;
  try {
    target = new URL(endpoint);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) {
      throw new Error('Invalid webhook URL');
    }
    const consoleURL = process.env.CONSOLE_PUBLIC_URL ?? 'http://127.0.0.1:4466';
    payload = JSON.stringify({
      event, job, name: decodeURIComponent(encodedName), run, revision, status,
      link: new URL('/job-console/runs/' + encodeURIComponent(run), consoleURL).href,
    });
  } catch {
    console.error('Webhook configuration is invalid');
    return;
  }
  const token = process.env.WEBHOOK_TOKEN;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(target, {
        method: 'POST', body: payload, redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      });
      await response.body?.cancel();
      if (response.ok) {
        console.log(`Webhook delivered ${event}`);
        return;
      }
      console.error(`Webhook returned HTTP ${response.status} (attempt ${attempt})`);
    } catch {
      console.error(`Webhook delivery failed (attempt ${attempt})`);
    }
    if (attempt < 2) await delay(500);
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await notify(process.argv.slice(2));
}
