/// <reference types="@cloudflare/workers-types" />
import yaml from 'js-yaml';
import { SubscriptionParser } from '../lib/shared/subscription-parser';
import type { Node, ProcessOptions } from '../lib/shared/types';

const subscriptionParser = new SubscriptionParser();
const OLD_KV_KEY = 'sub_one_data_v1';
const KV_KEY_SUBS = 'sub_one_subscriptions_v1';
const KV_KEY_PROFILES = 'sub_one_profiles_v1';
const KV_KEY_SETTINGS = 'worker_settings_v1';
const COOKIE_NAME = 'auth_session';
const SESSION_DURATION = 8 * 60 * 60 * 1000;

interface Env {
  SUB_ONE_KV: KVNamespace;
  ADMIN_PASSWORD?: string;
}

function calculateDataHash(data: any): string {
  const jsonString = JSON.stringify(data, Object.keys(data).sort());
  let hash = 0;
  for (let i = 0; i < jsonString.length; i++) {
    const char = jsonString.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString();
}

function hasDataChanged(oldData: any, newData: any): boolean {
  if (!oldData && !newData) return false;
  if (!oldData || !newData) return true;
  return calculateDataHash(oldData) !== calculateDataHash(newData);
}

async function conditionalKVPut(env: Env, key: string, newData: any, oldData: any = null): Promise<boolean> {
  if (oldData === null) {
    try {
      oldData = await env.SUB_ONE_KV.get(key, 'json');
    } catch (error) {
      await env.SUB_ONE_KV.put(key, JSON.stringify(newData));
      return true;
    }
  }
  if (hasDataChanged(oldData, newData)) {
    await env.SUB_ONE_KV.put(key, JSON.stringify(newData));
    return true;
  }
  return false;
}

const defaultSettings = {
  FileName: 'Sub-One',
  mytoken: 'auto',
  profileToken: '',
  subConverter: 'url.v1.mk',
  subConfig: 'https://raw.githubusercontent.com/cmliu/ACL4SSR/refs/heads/main/Clash/config/ACL4SSR_Online_Full.ini',
  prependSubName: true,
  NotifyThresholdDays: 3,
  NotifyThresholdPercent: 90
};

const formatBytes = (bytes: number, decimals = 2) => {
  if (!+bytes || bytes < 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  if (i < 0) return '0 B';
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

async function sendTgNotification(settings: any, message: string) {
  if (!settings.BotToken || !settings.ChatID) return false;
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const fullMessage = `${message}\n\n*时间:* \`${now} (UTC+8)\``;
  const url = `https://api.telegram.org/bot${settings.BotToken}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: settings.ChatID,
        text: fullMessage,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      })
    });
    return response.ok;
  } catch (e) {
    return false;
  }
}

async function handleCronTrigger(env: Env) {
  const originalSubs = await env.SUB_ONE_KV.get(KV_KEY_SUBS, 'json') || [];
  const allSubs = JSON.parse(JSON.stringify(originalSubs)) as any[];
  const settings = await env.SUB_ONE_KV.get(KV_KEY_SETTINGS, 'json') || defaultSettings;
  let changesMade = false;

  for (const sub of allSubs) {
    if (sub.url.startsWith('http') && sub.enabled) {
      try {
        const trafficReq = fetch(new Request(sub.url, { headers: { 'User-Agent': 'Clash for Windows/0.20.39' }, redirect: "follow" }));
        const nodeReq = fetch(new Request(sub.url, { headers: { 'User-Agent': 'Sub-One-Updater' }, redirect: "follow" }));
        const [tRes, nRes] = await Promise.allSettled([trafficReq, nodeReq]);

        if (tRes.status === 'fulfilled' && tRes.value.ok) {
          const userInfo = tRes.value.headers.get('subscription-userinfo');
          if (userInfo) {
            const info = {};
            userInfo.split(';').forEach(p => {
              const [k, v] = p.trim().split('=');
              if (k && v) info[k] = /^\d+$/.test(v) ? Number(v) : v;
            });
            sub.userInfo = info;
            await checkAndNotify(sub, settings, env);
            changesMade = true;
          }
        }
        if (nRes.status === 'fulfilled' && nRes.value.ok) {
          const text = await nRes.value.text();
          const nodes = subscriptionParser.parse(text);
          sub.nodeCount = nodes.length;
          changesMade = true;
        }
      } catch (e) {}
    }
  }
  if (changesMade) await env.SUB_ONE_KV.put(KV_KEY_SUBS, JSON.stringify(allSubs));
  return new Response("OK");
}

async function authMiddleware(request: Request, env: Env) {
  const cookie = request.headers.get('Cookie');
  const session = cookie?.split(';').find(c => c.trim().startsWith(`${COOKIE_NAME}=`));
  if (!session) return false;
  const token = session.split('=')[1];
  const ts = parseInt(token, 10);
  return !isNaN(ts) && (Date.now() - ts < SESSION_DURATION);
}

async function checkAndNotify(sub: any, settings: any, env: Env) {
  if (!sub.userInfo) return;
  const now = Date.now();
  if (sub.userInfo.expire) {
    const days = Math.ceil((sub.userInfo.expire * 1000 - now) / 86400000);
    if (days <= (settings.NotifyThresholdDays || 3)) {
      if (!sub.lastNotifiedExpire || (now - sub.lastNotifiedExpire > 86400000)) {
        if (await sendTgNotification(settings, `🗓️ *订阅临期提醒*\n*名称:* \`${sub.name}\`\n*剩余:* \`${days}天\``)) sub.lastNotifiedExpire = now;
      }
    }
  }
  if (sub.userInfo.total > 0) {
    const percent = Math.round(((sub.userInfo.upload + sub.userInfo.download) / sub.userInfo.total) * 100);
    if (percent >= (settings.NotifyThresholdPercent || 90)) {
      if (!sub.lastNotifiedTraffic || (now - sub.lastNotifiedTraffic > 86400000)) {
        if (await sendTgNotification(settings, `📈 *流量预警*\n*名称:* \`${sub.name}\`\n*已用:* \`${percent}%\``)) sub.lastNotifiedTraffic = now;
      }
    }
  }
}

async function handleApiRequest(request: Request, env: Env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '');

  if (path === '/login') {
    const { password } = await request.json() as any;
    if (password === env.ADMIN_PASSWORD) {
      const resp = new Response(JSON.stringify({ success: true }));
      resp.headers.set('Set-Cookie', `${COOKIE_NAME}=${Date.now()}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DURATION / 1000}`);
      return resp;
    }
    return new Response('Error', { status: 401 });
  }

  if (!await authMiddleware(request, env)) return new Response('Unauthorized', { status: 401 });

  if (path === '/data') {
    const [subs, profiles, settings] = await Promise.all([
      env.SUB_ONE_KV.get(KV_KEY_SUBS, 'json').then(r => r || []),
      env.SUB_ONE_KV.get(KV_KEY_PROFILES, 'json').then(r => r || []),
      env.SUB_ONE_KV.get(KV_KEY_SETTINGS, 'json').then(r => r || {})
    ]);
    return new Response(JSON.stringify({ subs, profiles, config: settings }));
  }

  if (path === '/subs' && request.method === 'POST') {
    const { subs, profiles } = await request.json() as any;
    await Promise.all([
      env.SUB_ONE_KV.put(KV_KEY_SUBS, JSON.stringify(subs)),
      env.SUB_ONE_KV.put(KV_KEY_PROFILES, JSON.stringify(profiles))
    ]);
    return new Response(JSON.stringify({ success: true }));
  }

  if (path === '/settings') {
    if (request.method === 'POST') {
      await env.SUB_ONE_KV.put(KV_KEY_SETTINGS, JSON.stringify(await request.json()));
      return new Response(JSON.stringify({ success: true }));
    }
    const s = await env.SUB_ONE_KV.get(KV_KEY_SETTINGS, 'json') || defaultSettings;
    return new Response(JSON.stringify(s));
  }

  return new Response('Not Found', { status: 404 });
}

async function generateCombinedNodeList(context, config, ua, subs) {
  const manual = subs.filter(s => !s.url.startsWith('http'));
  const parsedManual = subscriptionParser.parseNodeLines(manual.map(n => n.url), 'Manual');
  const processedManual = subscriptionParser.processNodes(parsedManual, 'Manual', { prependSubName: config.prependSubName });

  const httpSubs = subs.filter(s => s.url.startsWith('http'));
  const results = await Promise.all(httpSubs.map(async (s) => {
    try {
      const r = await fetch(s.url, { headers: { 'User-Agent': ua } });
      if (!r.ok) return [];
      return subscriptionParser.parse(await r.text(), s.name, { exclude: s.exclude, prependSubName: config.prependSubName });
    } catch { return []; }
  }));

  const all = [...processedManual, ...results.flat()];
  const unique = [];
  const seen = new Set();
  for (const n of all) {
    if (n?.url && !seen.has(n.url)) {
      seen.add(n.url);
      unique.push(n);
    }
  }
  return unique;
}

// --- 核心修改：handleSubRequest ---
async function handleSubRequest(context: EventContext<Env, any, any>) {
  const { request, env } = context;
  const url = new URL(request.url);
  const ua = request.headers.get('User-Agent') || "";

  const [sData, subsData, pData] = await Promise.all([
    env.SUB_ONE_KV.get(KV_KEY_SETTINGS, 'json'),
    env.SUB_ONE_KV.get(KV_KEY_SUBS, 'json'),
    env.SUB_ONE_KV.get(KV_KEY_PROFILES, 'json')
  ]);

  const config = { ...defaultSettings, ...(sData as any || {}) };
  const allSubs = (subsData || []) as any[];
  const allProfiles = (pData || []) as any[];

  let token = url.searchParams.get('token');
  let profileId: string | null = null;
  const path = url.pathname.replace(/^\/sub\//, '').split('/');
  if (path.length > 0 && path[0]) {
    token = path[0];
    profileId = path[1] || null;
  }

  if (!token || (profileId ? token !== config.profileToken : token !== config.mytoken)) return new Response('Forbidden', { status: 403 });

  let targetSubs = allSubs.filter(s => s.enabled);
  let subName = config.FileName;
  let conv = config.subConverter;
  let conf = config.subConfig;

  if (profileId) {
    const p = allProfiles.find(x => x.customId === profileId || x.id === profileId);
    if (p?.enabled) {
      subName = p.name;
      const sIds = new Set(p.subscriptions);
      const nIds = new Set(p.manualNodes);
      targetSubs = allSubs.filter(i => (i.url.startsWith('http') ? sIds.has(i.id) : nIds.has(i.id)) && i.enabled);
      if (p.subConverter) conv = p.subConverter;
      if (p.subConfig) conf = p.subConfig;
    }
  }

  let target = url.searchParams.get('target');
  if (!target) {
    const lUA = ua.toLowerCase();
    if (lUA.includes('clash') || lUA.includes('mihomo')) target = 'clash';
    else if (lUA.includes('sing-box')) target = 'singbox';
    else target = 'base64';
  }

  const nodes = await generateCombinedNodeList(context, config, 'Clash.Meta', targetSubs);
  const content = nodes.map(n => n.url).join('\n');

  if (target === 'base64') {
    return new Response(subscriptionParser.encodeBase64(content), {
      headers: { "Content-Disposition": `inline; filename="${encodeURIComponent(subName)}"` }
    });
  }

  const cbToken = await getCallbackToken(env);
  const cbUrl = `${url.protocol}//${url.host}${url.pathname}?target=base64&callback_token=${cbToken}`;
  if (url.searchParams.get('callback_token') === cbToken) return new Response(subscriptionParser.encodeBase64(content));

  const scUrl = new URL(`https://${conv.replace(/^https?:\/\//, '').replace(/\/$/, '')}/sub`);
  scUrl.searchParams.set('target', target);
  scUrl.searchParams.set('url', cbUrl);
  scUrl.searchParams.set('config', conf);
  scUrl.searchParams.set('scv', 'true'); // 跳过证书验证
  scUrl.searchParams.set('udp', 'true'); // 开启 UDP
  if (target === 'clash') scUrl.searchParams.set('ver', 'meta');

  try {
    const res = await fetch(scUrl.toString());
    return new Response(await res.text(), {
      headers: { "Content-Disposition": `inline; filename="${encodeURIComponent(subName)}"` }
    });
  } catch (e) {
    return new Response("Conv Error", { status: 502 });
  }
}

async function getCallbackToken(env) {
  const secret = env.ADMIN_PASSWORD || 'secret';
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode('cb-static'));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export async function onRequest(context: EventContext<Env, any, any>) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  if (request.headers.get("cf-cron")) return handleCronTrigger(env);
  if (url.pathname.startsWith('/api/')) return handleApiRequest(request, env);
  if (url.pathname !== '/' && !/\.\w+$/.test(url.pathname)) return handleSubRequest(context);
  return next();
}
