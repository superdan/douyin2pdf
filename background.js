/* Service Worker：编排 content script（页面上下文）下载图片 -> offscreen 生成PDF -> base64 回传 */
'use strict';

// ---------- offscreen 文档管理 ----------
async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: '在离屏文档中将图片合成为 PDF（Canvas 图像处理）',
  });
  // 探测 offscreen.js 是否已加载（等待脚本就绪握手，最多约 5 秒）
  for (let i = 0; i < 50; i++) {
    const r = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' }).catch(() => null);
    if (r && r.ok) return;
    await new Promise(res => setTimeout(res, 100));
  }
  throw new Error('离屏文档启动超时');
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

// ---------- 消息处理 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'MAKE_PDF') {
    (async () => {
      try {
        // 1) 在页面上下文下载全部图片（content script 代理，规避 CDN 拒绝扩展源）
        const dl = await chrome.tabs.sendMessage(msg.tabId, {
          type: 'FETCH_IMAGES',
          urls: msg.urls,
        });
        if (!dl || !dl.ok) {
          const bad = dl && dl.results ? dl.results.find(r => !r.ok) : null;
          throw new Error('图片下载失败' + (bad ? `（${bad.error}）` : '（页面未响应，请刷新页面重试）'));
        }
        const b64s = dl.results.map(r => r.b64);

        // 2) offscreen 生成 PDF
        await ensureOffscreen();
        const pdfResp = await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_MAKE_PDF',
          bufs: b64s,
          quality: 0.85,
        });
        if (!pdfResp || !pdfResp.ok) {
          throw new Error((pdfResp && pdfResp.error) || 'PDF 合成失败');
        }

        sendResponse({ ok: true, b64: pdfResp.b64 });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      } finally {
        setTimeout(() => { closeOffscreen(); }, 2000);
      }
    })();
    return true; // 异步 sendResponse
  }
});
