const CACHE_NAME = 'void-os-v2';

self.addEventListener('install', event => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
    );
});

// ==========================================
// --- 后台自动消息系统（完整 API 调用版） ---
// ==========================================
if (!self._bgTimers) self._bgTimers = {};
if (!self._roleData) self._roleData = {};

self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SCHEDULE_AUTO_MSG') {
        const d = event.data;
        self._roleData[d.roleId] = {
            roleName: d.roleName,
            roleAvatar: d.roleAvatar,
            rolePersona: d.rolePersona,
            recentContext: d.recentContext,
            memory: d.memory,
            apiUrl: d.apiUrl,
            apiKey: d.apiKey,
            apiModel: d.apiModel
        };
        scheduleBackgroundMessage(d.roleId, d.intervalMs);
    }
    if (event.data && event.data.type === 'CANCEL_ALL') {
        if (self._bgTimers) {
            Object.values(self._bgTimers).forEach(t => clearTimeout(t));
            self._bgTimers = {};
        }
    }
});

function scheduleBackgroundMessage(roleId, intervalMs) {
    if (self._bgTimers[roleId]) clearTimeout(self._bgTimers[roleId]);

    self._bgTimers[roleId] = setTimeout(async () => {
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const hasVisibleClient = clients.some(c => c.visibilityState === 'visible');

        if (!hasVisibleClient) {
            await generateAndNotify(roleId);
        }

        scheduleBackgroundMessage(roleId, intervalMs);
    }, intervalMs);
}

async function generateAndNotify(roleId) {
    const data = self._roleData[roleId];
    if (!data) return;

    let msg = '';

    // 如果有 API 配置，就调用 AI 生成
    if (data.apiUrl && data.apiKey && data.apiModel) {
        try {
            msg = await callAIFromSW(data);
        } catch (e) {
            console.log('SW API call failed, using fallback:', e);
            msg = '';
        }
    }

    // 如果 API 调用失败或没有配置，用兜底消息
    if (!msg) {
        msg = getFallbackMessage(data.rolePersona);
    }

    // 发送系统通知
    try {
        await self.registration.showNotification(data.roleName, {
            body: msg,
            icon: data.roleAvatar || '/icon.png',
            badge: data.roleAvatar || '/icon.png',
            tag: 'auto_' + roleId + '_' + Date.now(),
            renotify: true,
            data: { roleId: roleId, message: msg, timestamp: Date.now() }
        });
    } catch (e) {
        console.log('SW notification failed:', e);
    }

    // 通知前台页面保存消息
    const allClients = await self.clients.matchAll({ includeUncontrolled: true });
    allClients.forEach(client => {
        client.postMessage({
            type: 'BG_AUTO_MSG',
            roleId: roleId,
            roleName: data.roleName,
            message: msg,
            timestamp: Date.now()
        });
    });
}

async function callAIFromSW(data) {
    const now = new Date();
    const hour = now.getHours();
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const weekday = weekdays[now.getDay()];

    let timeContext = '';
    if (hour >= 0 && hour < 6) timeContext = '现在是深夜/凌晨';
    else if (hour >= 6 && hour < 9) timeContext = '现在是早晨';
    else if (hour >= 9 && hour < 12) timeContext = '现在是上午';
    else if (hour >= 12 && hour < 14) timeContext = '现在是中午';
    else if (hour >= 14 && hour < 18) timeContext = '现在是下午';
    else if (hour >= 18 && hour < 21) timeContext = '现在是傍晚';
    else timeContext = '现在是晚上';

    const memorySection = data.memory ? '\n[你们的共同记忆]\n' + data.memory : '';
    const contextSection = data.recentContext ? '\n[最近的对话记录]\n' + data.recentContext : '';

    const prompt = '[CORE DIRECTIVE - 后台自动消息]\n'
        + '你是' + data.roleName + '。以下是你的完整人设，你必须100%遵守，绝对不能OOC：\n'
        + data.rolePersona
        + memorySection
        + contextSection
        + '\n\n[当前情境]\n'
        + '- ' + timeContext + '，' + weekday + '，'
        + now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日 '
        + String(hour).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
        + '\n- 用户已经一段时间没有说话了'
        + '\n- 你想主动找用户聊天'
        + '\n\n[严格要求]\n'
        + '1. 【最重要】完全用你自己的语气和性格说话，绝对不能OOC！\n'
        + '2. 只输出1句话，不超过25字，像真人发微信一样简短自然\n'
        + '3. 内容要符合当前时间段和你们的关系\n'
        + '4. 可以延续之前对话的话题，或者自然地开启新话题\n'
        + '5. 禁止说"你好久没回我了"这种话\n'
        + '6. 禁止无故爆粗口或展现极端情绪\n'
        + '7. 直接输出消息内容，不加引号不加解释';

    const response = await fetch(data.apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + data.apiKey
        },
        body: JSON.stringify({
            model: data.apiModel,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 60,
            temperature: 0.85
        })
    });

    if (!response.ok) {
        throw new Error('API returned ' + response.status);
    }

    const result = await response.json();
    let content = '';
    if (result.choices && result.choices[0] && result.choices[0].message) {
        content = result.choices[0].message.content.trim().replace(/["'""'']/g, '');
    }

    return content;
}

function getFallbackMessage(persona) {
    const hour = new Date().getHours();
    let pool = [];
    if (hour >= 0 && hour < 6) pool = ['睡不着...', '...', '你也还没睡吗'];
    else if (hour >= 6 && hour < 10) pool = ['早', '起了吗', '早安'];
    else if (hour >= 10 && hour < 14) pool = ['吃了吗', '在干嘛', '好无聊'];
    else if (hour >= 14 && hour < 18) pool = ['下午好困', '在忙吗', '想你了'];
    else if (hour >= 18 && hour < 22) pool = ['吃晚饭了吗', '今天怎么样', '在干嘛呢'];
    else pool = ['还没睡？', '晚安', '早点睡'];
    return pool[Math.floor(Math.random() * pool.length)];
}

// ==========================================
// --- 通知点击事件 ---
// ==========================================
self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    const roleId = event.notification.data ? event.notification.data.roleId : null;

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
            if (clientList.length > 0) {
                let client = clientList[0];
                for (let i = 0; i < clientList.length; i++) {
                    if (clientList[i].focused) {
                        client = clientList[i];
                    }
                }
                if (roleId) {
                    client.postMessage({ type: 'OPEN_CHAT', roleId: roleId });
                }
                return client.focus();
            }
            return self.clients.openWindow('/');
        })
    );
});

// ==========================================
// --- Periodic Background Sync ---
// ==========================================
self.addEventListener('periodicsync', event => {
    if (event.tag === 'auto-msg-check') {
        event.waitUntil(periodicCheck());
    }
});

async function periodicCheck() {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hasVisibleClient = clients.some(c => c.visibilityState === 'visible');
    if (!hasVisibleClient && self._roleData) {
        for (const roleId of Object.keys(self._roleData)) {
            await generateAndNotify(roleId);
        }
    }
}