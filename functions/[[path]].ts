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
  if (!settings.BotToken || !settings.ChatID) {
    console.log("TG BotToken or ChatID not set, skipping notification.");
    return false;
  }
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const fullMessage = `${message}\n\n*时间:* \`${now} (UTC+8)\``;
  const url = `https://api.telegram.org/bot${settings.BotToken}/sendMessage`;
  const payload = {
    chat_id: settings.ChatID,
    text: fullMessage,
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return response.ok;
  } catch (error) {
    console.error("发送 TG 通知时出错：", error);
    return false;
  }
}

async function handleCronTrigger(env: Env) {
  console.log("Cron trigger fired...");
  const originalSubs = await env.SUB_ONE_KV.get(KV_KEY_SUBS, 'json') || [];
  const allSubs = JSON.parse(JSON.stringify(originalSubs));
  const settings = await env.SUB_ONE_KV.get(KV_KEY_SETTINGS, 'json') || defaultSettings;
  let changesMade = false;

  for (const sub of allSubs) {
    if (sub.url.startsWith('http') && sub.enabled) {
      try {
        const trafficRequest = fetch(new Request(sub.url, { headers: { 'User-Agent': 'Clash for Windows/0.20.39' }, redirect: "follow" }));
        const nodeCountRequest = fetch(new Request(sub.url, { headers: { 'User-Agent': 'Sub-One-Cron-Updater/1.0' }, redirect: "follow" }));
        
        const [trafficResult, nodeCountResult] = await Promise.allSettled([
          Promise.race([trafficRequest, new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))]),
          Promise.race([nodeCountRequest, new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))])
        ]) as any;

        if (trafficResult.status === 'fulfilled' && trafficResult.value.ok) {
          const userInfoHeader = trafficResult.value.headers.get('subscription-userinfo');
          if (userInfoHeader) {
            const info = {};
            userInfoHeader.split(';').forEach(part => {
              const [key, value] = part.trim().split('=');
              if (key && value) info[key] = /^\d+$/.test(value) ? Number(value) : value;
            });
            sub.userInfo = info;
            await checkAndNotify(sub, settings, env);
            changesMade = true;
          }
        }

        if (nodeCountResult.status === 'fulfilled' && nodeCountResult.value.ok) {
          const text = await nodeCountResult.value.text();
          try {
            const nodes = subscriptionParser.parse(text);
            sub.nodeCount = nodes.length;
            changesMade = true;
          } catch (e) { console.error(e); }
        }
      } catch (e) { console.error(e); }
    }
  }

  if (changesMade) {
    await env.SUB_ONE_KV.put(KV_KEY_SUBS, JSON.stringify(allSubs));
  }
  return new Response("Cron job completed.", { status: 200 });
}

async function checkAndNotify(sub: any, settings: any, env: Env) {
  if (!sub.userInfo) return;
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  if (sub.userInfo.expire) {
    const expiryDate = new Date(sub.userInfo.expire * 1000);
    const daysRemaining = Math.ceil((expiryDate.getTime() - now) / ONE_DAY_MS);
    if (daysRemaining <= (settings.NotifyThresholdDays || 3)) {
      if (!sub.lastNotifiedExpire || (now - sub.lastNotifiedExpire > ONE_DAY_MS)) {
        const message = `🗓️ *订阅临期提醒*\n*订阅名称:* \`${sub.name}\`\n*状态:* \`${daysRemaining < 0 ? '已过期' : `剩 ${daysRemaining} 天`}\``;
        if (await sendTgNotification(settings, message)) sub.lastNotifiedExpire = now;
      }
    }
  }

  const { upload, download, total } = sub.userInfo;
  if (total > 0) {
    const used = upload + download;
    const usagePercent = Math.round((used / total) * 100);
    if (usagePercent >= (settings.NotifyThresholdPercent || 90)) {
      if (!sub.lastNotifiedTraffic || (now - sub.lastNotifiedTraffic > ONE_DAY_MS)) {
        const message = `📈 *流量预警提醒*\n*订阅名称:* \`${sub.name}\`\n*状态:* \`已用 ${usagePercent}%\``;
        if (await sendTgNotification(settings, message)) sub.lastNotifiedTraffic = now;
      }
    }
  }
}

async function authMiddleware(request: Request, env: Env) {
  const cookie = request.headers.get('Cookie');
  const sessionCookie = cookie?.split(';').find(c => c.trim().startsWith(`${COOKIE_NAME}=`));
  if (!sessionCookie) return false;
  const token = sessionCookie.split('=')[1];
  try {
    const timestamp = parseInt(token, 10);
    return !isNaN(timestamp) && (Date.now() - timestamp < SESSION_DURATION);
  } catch { return false; }
}

async function handleApiRequest(request: Request, env: Env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '');

  if (path === '/login') {
    const { password } = await request.json() as any;
    if (password === env.ADMIN_PASSWORD) {
      const token = String(Date.now());
      const headers = new Headers({ 'Content-Type': 'application/json' });
      headers.append('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DURATION / 1000}`);
      return new Response(JSON.stringify({ success: true }), { headers });
    }
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  if (!await authMiddleware(request, env)) return new Response('Unauthorized', { status: 401 });

  switch (path) {
    case '/data':
      const [subs, profiles, settings] = await Promise.all([
        env.SUB_ONE_KV.get(KV_KEY_SUBS, 'json').then(res => res || []),
        env.SUB_ONE_KV.get(KV_KEY_PROFILES, 'json').then(res => res || []),
        env.SUB_ONE_KV.get(KV_KEY_SETTINGS, 'json').then(res => res || {})
      ]);
      return new Response(JSON.stringify({ subs, profiles, config: { ...defaultSettings, ...settings as any } }));
    
    case '/settings':
        if (request.method === 'POST') {
            const newSettings = await request.json();
            await env.SUB_ONE_KV.put(KV_KEY_SETTINGS, JSON.stringify(newSettings));
            return new Response(JSON.stringify({ success: true }));
        }
        const currentSettings = await env.SUB_ONE_KV.get(KV_KEY_SETTINGS, 'json') || defaultSettings;
        return new Response(JSON.stringify(currentSettings));

    case '/subs':
        const { subs: newSubs, profiles: newProfiles } = await request.json() as any;
        await Promise.all([
            env.SUB_ONE_KV.put(KV_KEY_SUBS, JSON.stringify(newSubs)),
            env.SUB_ONE_KV.put(KV_KEY_PROFILES, JSON.stringify(newProfiles))
        ]);
        return new Response(JSON.stringify({ success: true }));

    default:
      return new Response('Not Found', { status: 404 });
  }
}

async function generateCombinedNodeList(context, config, userAgent, subs, prependedContent = '') {
  const manualNodes = subs.filter(sub => !sub.url.toLowerCase().startsWith('http'));
  const parsedManualNodes = subscriptionParser.parseNodeLines(manualNodes.map(n => n.url), '手动节点');
  const processedManualNodes = subscriptionParser.processNodes(parsedManualNodes, '手动节点', { prependSubName: config.prependSubName });

  const httpSubs = subs.filter(sub => sub.url.toLowerCase().startsWith('http'));
  const subPromises = httpSubs.map(async (sub) => {
    try {
      const response = await fetch(new Request(sub.url, { headers: { 'User-Agent': userAgent }, redirect: "follow" }));
      if (!response.ok) return [];
      const text = await response.text();
      return subscriptionParser.parse(text, sub.name, { exclude: sub.exclude, prependSubName: config.prependSubName });
    } catch (e) { return []; }
  });

  const results = await Promise.all(subPromises);
  const allNodes = [...processedManualNodes, ...results.flat()];
  const uniqueNodes: Node[] = [];
  const seenUrls = new Set();
  for (const node of allNodes) {
    if (node && node.url && !seenUrls.has(node.url)) {
      seenUrls.add(node.url);
      uniqueNodes.push(node);
    }
  }
  return uniqueNodes;
}

// --- 核心修改部分：handleSubRequest ---
async function handleSubRequest(context: EventContext<Env, any, any>) {
  const { request, env } = context;
  const url = new URL(request.url);
  const userAgentHeader = request.headers.get('User-Agent') || "Unknown";
  
  const [settingsData, subsData, profilesData] = await Promise.all([
    env.SUB_ONE_KV.get(KV_KEY_SETTINGS, 'json'),
    env.SUB_ONE_KV.get(KV_KEY_SUBS, 'json'),
    env.SUB_ONE_KV.get(KV_KEY_PROFILES, 'json')
  ]);

  const config = { ...defaultSettings, ...(settingsData as any || {}) };
  const allSubs = (subsData || []) as any[];
  const allProfiles = (profilesData || []) as any[];

  let token = url.searchParams.get('token');
  let profileIdentifier: string | null = null;
  const pathSegments = url.pathname.replace(/^\/sub\//, '/').split('/').filter(Boolean);
  
  if (pathSegments.length > 0) {
    token = pathSegments[0];
    profileIdentifier = pathSegments[1] || null;
  }

  if (!token || (profileIdentifier ? token !== config.profileToken : token !== config.mytoken)) {
    return new Response('Invalid Token', { status: 403 });
  }

  let targetSubs = allSubs.filter(s => s.enabled);
  let subName = config.FileName;
  let effectiveSubConverter = config.subConverter || defaultSettings.subConverter;
  let effectiveSubConfig = config.subConfig || defaultSettings.subConfig;

  if (profileIdentifier) {
    const profile = allProfiles.find(p => p.customId === profileIdentifier || p.id === profileIdentifier);
    if (profile && profile.enabled) {
        subName = profile.name;
        const pSubIds = new Set(profile.subscriptions);
        const pNodeIds = new Set(profile.manualNodes);
        targetSubs = allSubs.filter(item => (item.url.startsWith('http') ? pSubIds.has(item.id) : pNodeIds.has(item.id)) && item.enabled);
        if (profile.subConverter) effectiveSubConverter = profile.subConverter;
        if (profile.subConfig) effectiveSubConfig = profile.subConfig;
    }
  }

  // 确定目标格式
  let targetFormat = url.searchParams.get('target') || 'base64';
  const ua = userAgentHeader.toLowerCase();
  if (!url.searchParams.get('target')) {
    if (ua.includes('clash') || ua.includes('mihomo') || ua.includes('stash')) targetFormat = 'clash';
    else if (ua.includes('sing-box')) targetFormat = 'singbox';
    else if (ua.includes('surge')) targetFormat = 'surge';
  }

  // 生成合并节点
  const combinedNodes = await generateCombinedNodeList(context, config, 'Clash.Meta/v1.16.0', targetSubs);
  const combinedContent = combinedNodes.map(n => n.url).join('\n');

  if (targetFormat === 'base64') {
    return new Response(subscriptionParser.encodeBase64(combinedContent), {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `inline; filename="${encodeURIComponent(subName)}"` }
    });
  }

  // 构建 Subconverter 请求
  const callbackToken = await getCallbackToken(env);
  const callbackUrl = `${url.protocol}//${url.host}${url.pathname}?target=base64&callback_token=${callbackToken}`;
  
  if (url.searchParams.get('callback_token') === callbackToken) {
    return new Response(subscriptionParser.encodeBase64(combinedContent));
  }

  let cleanSubConverter = effectiveSubConverter.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const subconverterUrl = new URL(`https://${cleanSubConverter}/sub`);
  
  // --- 关键参数注入 ---
  subconverterUrl.searchParams.set('target', targetFormat);
  subconverterUrl.searchParams.set('url', callbackUrl);
  subconverterUrl.searchParams.set('insert', 'false');
  subconverterUrl.searchParams.set('config', effectiveSubConfig);
  subconverterUrl.searchParams.set('emoji', 'true');
  subconverterUrl.searchParams.set('list', 'false');
  subconverterUrl.searchParams.set('udp', 'true');       // 开启 UDP
  subconverterUrl.searchParams.set('scv', 'true');       // 开启 skip-cert-verify
  subconverterUrl.searchParams.set('fdn', 'true');       // 过滤非法节点
  
  if (targetFormat === 'clash') {
    subconverterUrl.searchParams.set('ver', 'meta');     // 强制 Meta 格式
  }

  try {
    const subResponse = await fetch(subconverterUrl.toString(), { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const responseText = await subResponse.text();
    return new Response(responseText, {
      headers: { 
        "Content-Type": "text/plain; charset=utf-8", 
        "Content-Disposition": `inline; filename="${encodeURIComponent(subName)}"` 
      }
    });
  } catch (e: any) {
    return new Response(`Error: ${e.message}`, { status: 502 });
  }
}

async function getCallbackToken(env) {
  const secret = env.ADMIN_PASSWORD || 'default-secret';
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode('callback-static'));
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

