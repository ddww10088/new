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

/**
 * 计算数据的简单哈希值，用于检测变更
 */
function calculateDataHash(data: any): string {
  const jsonString = JSON.stringify(data, Object.keys(data).sort());
  let hash = 0;
  for (let i = 0; i < jsonString.length; i++) {
    const char = jsonString.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // 转换为32位整数
  }
  return hash.toString();
}

/**
 * 检测数据是否发生变更
 */
function hasDataChanged(oldData: any, newData: any): boolean {
  if (!oldData && !newData) return false;
  if (!oldData || !newData) return true;
  return calculateDataHash(oldData) !== calculateDataHash(newData);
}

/**
 * 条件性写入KV存储
 */
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

// --- 默认设置 ---
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

// --- TG 通知函式 ---
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
    if (response.ok) {
      console.log("TG 通知已成功发送。");
      return true;
    } else {
      const errorData = await response.json();
      console.error("发送 TG 通知失败：", response.status, errorData);
      return false;
    }
  } catch (error) {
    console.error("发送 TG 通知时出错：", error);
    return false;
  }
}

async function handleCronTrigger(env: Env) {
  console.log("Cron trigger fired. Checking all subscriptions...");
  const originalSubs = await env.SUB_ONE_KV.get(KV_KEY_SUBS, 'json') || [];
  const allSubs = JSON.parse(JSON.stringify(originalSubs));
  const settings = await env.SUB_ONE_KV.get(KV_KEY_SETTINGS, 'json') || defaultSettings;
  let changesMade = false;

  for (const sub of allSubs) {
    if (sub.url.startsWith('http') && sub.enabled) {
      try {
        const trafficRequest = fetch(new Request(sub.url, { headers: { 'User-Agent': 'Clash for Windows/0.20.39' }, redirect: "follow", cf: { insecureSkipVerify: true } } as any));
        const nodeCountRequest = fetch(new Request(sub.url, { headers: { 'User-Agent': 'Sub-One-Cron-Updater/1.0' }, redirect: "follow", cf: { insecureSkipVerify: true } } as any));
        
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
          let nodeCount = 0;
          try {
            const nodes = subscriptionParser.parse(text);
            nodeCount = nodes.length;
          } catch (e) { console.error(e); }
          if (nodeCount > 0) {
            sub.nodeCount = nodeCount;
            changesMade = true;
          }
        }
      } catch (e: any) {
        console.error(`Cron: Unhandled error while updating ${sub.name}`, e.message);
      }
    }
  }

  if (changesMade) {
    await env.SUB_ONE_KV.put(KV_KEY_SUBS, JSON.stringify(allSubs));
  }
  return new Response("Cron job completed successfully.", { status: 200 });
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

async function checkAndNotify(sub: any, settings: any, env: Env) {
  if (!sub.userInfo) return;
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  if (sub.userInfo.expire) {
    const expiryDate = new Date(sub.userInfo.expire * 1000);
    const daysRemaining = Math.ceil((expiryDate.getTime() - now) / ONE_DAY_MS);
    if (daysRemaining <= (settings.NotifyThresholdDays || 7)) {
      if (!sub.lastNotifiedExpire || (now - sub.lastNotifiedExpire > ONE_DAY_MS)) {
        const message = `🗓️ *订阅临期提醒* 🗓️\n\n*订阅名称:* \`${sub.name || '未命名'}\`\n*状态:* \`${daysRemaining < 0 ? '已过期' : `仅剩 ${daysRemaining} 天到期`}\`\n*到期日期:* \`${expiryDate.toLocaleDateString('zh-CN')}\``;
        const sent = await sendTgNotification(settings, message);
        if (sent) sub.lastNotifiedExpire = now;
      }
    }
  }

  const { upload, download, total } = sub.userInfo;
  if (total > 0) {
    const used = upload + download;
    const usagePercent = Math.round((used / total) * 100);
    if (usagePercent >= (settings.NotifyThresholdPercent || 90)) {
      if (!sub.lastNotifiedTraffic || (now - sub.lastNotifiedTraffic > ONE_DAY_MS)) {
        const message = `📈 *流量预警提醒* 📈\n\n*订阅名称:* \`${sub.name || '未命名'}\`\n*状态:* \`已使用 ${usagePercent}%\`\n*详情:* \`${formatBytes(used)} / ${formatBytes(total)}\``;
        const sent = await sendTgNotification(settings, message);
        if (sent) sub.lastNotifiedTraffic = now;
      }
    }
  }
}

// --- 主要 API 请求处理 (保持你的原始 API 逻辑) ---
async function handleApiRequest(request: Request, env: Env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '');

  if (path === '/migrate') {
    if (!await authMiddleware(request, env)) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    try {
      const oldData = await env.SUB_ONE_KV.get(OLD_KV_KEY, 'json');
      const newDataExists = await env.SUB_ONE_KV.get(KV_KEY_SUBS) !== null;
      if (newDataExists) return new Response(JSON.stringify({ success: true, message: '无需迁移' }));
      if (!oldData) return new Response(JSON.stringify({ success: false, message: '未找到旧数据' }), { status: 404 });
      await env.SUB_ONE_KV.put(KV_KEY_SUBS, JSON.stringify(oldData));
      await env.SUB_ONE_KV.put(KV_KEY_PROFILES, JSON.stringify([]));
      await env.SUB_ONE_KV.delete(OLD_KV_KEY);
      return new Response(JSON.stringify({ success: true, message: '数据迁移成功！' }));
    } catch (e: any) { return new Response(JSON.stringify({ success: false, message: e.message }), { status: 500 }); }
  }

  if (path === '/login') {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    try {
      const { password } = await request.json() as any;
      if (password === env.ADMIN_PASSWORD) {
        const token = String(Date.now());
        const headers = new Headers({ 'Content-Type': 'application/json' });
        headers.append('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DURATION / 1000}`);
        return new Response(JSON.stringify({ success: true }), { headers });
      }
      return new Response(JSON.stringify({ error: '密码错误' }), { status: 401 });
    } catch (e) { return new Response(JSON.stringify({ error: '解析失败' }), { status: 400 }); }
  }

  if (!await authMiddleware(request, env)) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

  switch (path) {
    case '/logout': {
      const headers = new Headers({ 'Content-Type': 'application/json' });
      headers.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
      return new Response(JSON.stringify({ success: true }), { headers });
    }
    case '/data': {
      const [subs, profiles, settings] = await Promise.all([
        env.SUB_ONE_KV.get(KV_KEY_SUBS, 'json').then(res => res || []),
        env.SUB_ONE_KV.get(KV_KEY_PROFILES, 'json').then(res => res || []),
        env.SUB_ONE_KV.get(KV_KEY_SETTINGS, 'json').then(res => res || {} as any)
      ]);
      return new Response(JSON.stringify({ subs, profiles, config: { FileName: settings.FileName || 'SUB_ONE', mytoken: settings.mytoken || 'auto', profileToken: settings.profileToken || '' } }), { headers: { 'Content-Type': 'application/json' } });
    }
    case '/subs': {
      try {
        const { subs, profiles } = await request.json() as any;
        let settings = await env.SUB_ONE_KV.get(KV_KEY_SETTINGS, 'json') || defaultSettings;
        await Promise.all([
          env.SUB_ONE_KV.put(KV_KEY_SUBS, JSON.stringify(subs)),
          env.SUB_ONE_KV.put(KV_KEY_PROFILES, JSON.stringify(profiles))
        ]);
        return new Response(JSON.stringify({ success: true, message: '保存成功' }));
      } catch (e: any) { return new Response(JSON.stringify({ success: false, message: e.message }), { status: 500 }); }
    }
    case '/settings': {
      if (request.method === 'GET') {
        const settings = await env.SUB_ONE_KV.get(KV_KEY_SETTINGS, 'json') || {};
        return new Response(JSON.stringify({ ...defaultSettings, ...settings }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (request.method === 'POST') {
        const newSettings = await request.json();
        const oldSettings = await env.SUB_ONE_KV.get(KV_KEY_SETTINGS, 'json') || {};
        const finalSettings = { ...oldSettings as any, ...newSettings as any };
        await env.SUB_ONE_KV.put(KV_KEY_SETTINGS, JSON.stringify(finalSettings));
        await sendTgNotification(finalSettings, `⚙️ *Sub-One 设置更新* ⚙️\n\n您的 Sub-One 应用设置已成功更新。`);
        return new Response(JSON.stringify({ success: true, message: '设置已保存' }));
      }
      return new Response('Method Not Allowed', { status: 405 });
    }
    // 篇幅原因，其他批量更新、延迟测试等 API 逻辑在此处省略，但在你实际代码中应保持不变
  }
  return new Response('API route not found', { status: 404 });
}

async function generateCombinedNodeList(context, config, userAgent, subs, prependedContent = '') {
  const manualNodes = subs.filter(sub => !sub.url.toLowerCase().startsWith('http'));
  const parsedManualNodes = subscriptionParser.parseNodeLines(manualNodes.map(n => n.url), '手动节点');
  const processedManualNodes = subscriptionParser.processNodes(parsedManualNodes, '手动节点', { prependSubName: config.prependSubName });

  const httpSubs = subs.filter(sub => sub.url.toLowerCase().startsWith('http'));
  const subPromises = httpSubs.map(async (sub) => {
    try {
      const response = await Promise.race([
        fetch(new Request(sub.url, { headers: { 'User-Agent': userAgent }, redirect: "follow", cf: { insecureSkipVerify: true } })),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
      ]) as Response;
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

// --- [关键修改点] 订阅处理逻辑 ---
async function handleSubRequest(context: EventContext<Env, any, any>) {
  const { request, env } = context;
  const url = new URL(request.url);
  const userAgentHeader = request.headers.get('User-Agent') || "Unknown";

  const [settingsData, subsData, profilesData] = await Promise.all([
    env.SUB_ONE_KV.get(KV_KEY_SETTINGS, 'json'),
    env.SUB_ONE_KV.get(KV_KEY_SUBS, 'json'),
    env.SUB_ONE_KV.get(KV_KEY_PROFILES, 'json')
  ]);

  const settings = settingsData || {};
  const allSubs = (subsData || []) as any[];
  const allProfiles = (profilesData || []) as any[];
  const config = { ...defaultSettings, ...settings };

  let token: string | null = '';
  let profileIdentifier: string | null = null;
  const pathSegments = url.pathname.replace(/^\/sub\//, '/').split('/').filter(Boolean);
  if (pathSegments.length > 0) {
    token = pathSegments[0];
    if (pathSegments.length > 1) profileIdentifier = pathSegments[1];
  } else {
    token = url.searchParams.get('token');
  }

  let targetSubs;
  let subName = config.FileName;
  let effectiveSubConverter;
  let effectiveSubConfig;
  let isProfileExpired = false;
  const DEFAULT_EXPIRED_NODE = `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent('您的订阅已失效')}`;

  if (profileIdentifier) {
    if (!token || token !== config.profileToken) return new Response('Invalid Profile Token', { status: 403 });
    const profile = allProfiles.find(p => (p.customId && p.customId === profileIdentifier) || p.id === profileIdentifier);
    if (profile && profile.enabled) {
      if (profile.expiresAt && new Date() > new Date(profile.expiresAt)) isProfileExpired = true;
      if (isProfileExpired) {
        subName = profile.name;
        targetSubs = [{ id: 'expired-node', url: DEFAULT_EXPIRED_NODE, name: '您的订阅已到期' }];
      } else {
        subName = profile.name;
        const pSubIds = new Set(profile.subscriptions);
        const pNodeIds = new Set(profile.manualNodes);
        targetSubs = allSubs.filter(item => {
          const isSub = item.url.startsWith('http');
          return ((isSub && pSubIds.has(item.id)) || (!isSub && pNodeIds.has(item.id))) && item.enabled;
        });
      }
      effectiveSubConverter = profile.subConverter || config.subConverter;
      effectiveSubConfig = profile.subConfig || config.subConfig;
    } else { return new Response('Profile not found', { status: 404 }); }
  } else {
    if (!token || token !== config.mytoken) return new Response('Invalid Token', { status: 403 });
    targetSubs = allSubs.filter(s => s.enabled);
    effectiveSubConverter = config.subConverter;
    effectiveSubConfig = config.subConfig;
  }

  // 格式判断逻辑
  let targetFormat = url.searchParams.get('target');
  if (!targetFormat) {
    const ua = userAgentHeader.toLowerCase();
    if (ua.includes('clash') || ua.includes('mihomo')) targetFormat = 'clash';
    else if (ua.includes('sing-box')) targetFormat = 'singbox';
    else if (ua.includes('surge')) targetFormat = 'surge';
    else targetFormat = 'base64';
  }

  // 发送 TG 访问提醒
  if (!url.searchParams.has('callback_token')) {
    context.waitUntil(sendTgNotification(config, `🛰️ *订阅被访问* 🛰️\n\n*域名:* \`${url.hostname}\`\n*格式:* \`${targetFormat}\`\n*订阅组:* \`${subName}\``));
  }

  // 生成节点
  const combinedNodes = await generateCombinedNodeList(context, config, 'Clash.Meta/v1.16.0', targetSubs);
  let combinedContent = combinedNodes.map(n => n.url).join('\n');

  if (targetFormat === 'base64') {
    return new Response(subscriptionParser.encodeBase64(combinedContent), {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `inline; filename*=utf-8''${encodeURIComponent(subName)}` }
    });
  }

  // --- [这里是你要的核心修改] ---
  const callbackToken = await getCallbackToken(env);
  const callbackUrl = `${url.protocol}//${url.host}${url.pathname}?target=base64&callback_token=${callbackToken}`;
  
  if (url.searchParams.get('callback_token') === callbackToken) {
    return new Response(subscriptionParser.encodeBase64(combinedContent));
  }

  let cleanSubConverter = (effectiveSubConverter || defaultSettings.subConverter).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const subconverterUrl = new URL(`https://${cleanSubConverter}/sub`);
  
  subconverterUrl.searchParams.set('target', targetFormat);
  subconverterUrl.searchParams.set('url', callbackUrl);
  subconverterUrl.searchParams.set('config', effectiveSubConfig || defaultSettings.subConfig);
  
  // 注入参数：跳过证书验证 + UDP
  subconverterUrl.searchParams.set('scv', 'true'); // 关键：skip-cert-verify: true
  subconverterUrl.searchParams.set('udp', 'true'); // 关键：udp: true
  
  if (targetFormat === 'clash') {
    subconverterUrl.searchParams.set('ver', 'meta');
  }

  try {
    const response = await fetch(subconverterUrl.toString());
    const text = await response.text();
    return new Response(text, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `inline; filename*=utf-8''${encodeURIComponent(subName)}` }
    });
  } catch (e: any) {
    return new Response(`Error: ${e.message}`, { status: 502 });
  }
}

async function getCallbackToken(env) {
  const secret = env.ADMIN_PASSWORD || 'default-secret';
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode('callback-static-data'));
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export async function onRequest(context: EventContext<Env, any, any>) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  if (request.headers.get("cf-cron")) return handleCronTrigger(env);
  if (url.pathname.startsWith('/api/')) return handleApiRequest(request, env);
  if (url.pathname !== '/' && !/\.\w+$/.test(url.pathname)) return handleSubRequest(context);
  return next();
}

