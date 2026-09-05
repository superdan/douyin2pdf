/* 内容脚本：从抖音图文页面提取笔记图片 + 作为图片下载代理
 *
 * 提取策略（按优先级）：
 *   1) DOM 轮播大图（当前笔记正文，最可靠，天然去重）
 *   2) hydration 脚本（urlList 多 CDN 镜像，按图片本体 uri 去重）
 * 关键去重键：douyinpic.com/<tos-xxx>~ 中的 tos 部分（图片本体标识）
 *
 * 图片下载代理：popup/SW 的 fetch 带 chrome-extension 源会被抖音 CDN 拒绝，
 * 必须在页面上下文 fetch（同源、带页面 Referer/Cookie），转 base64 回传。
 */
'use strict';

(function () {

  // ---------- 工具 ----------
  function uriKey(u) {
    // 提取图片本体标识：tos-cn-i-xxx/yyy~（~ 前是本体，~ 后是尺寸模板）
    const m = u.match(/douyinpic\.com\/(tos-[^~?\/]+\/[^~?\/]+)/);
    return m ? m[1] : u;
  }

  function dedupeByUri(urls) {
    const seen = new Map(); // uriKey -> url（保留首个）
    for (const u of urls) {
      const k = uriKey(u);
      if (!seen.has(k)) seen.set(k, u);
    }
    return [...seen.values()];
  }

  function isNoteImage(u) {
    // 笔记正文图特征
    if (!(u.includes('aweme_images') || u.includes('tplv-dy-aweme-images'))) return false;
    // 排除杂项
    if (u.includes('aweme-avatar') || u.includes('aweme_comment') ||
        u.includes('pcweb_cover') || u.includes('webcast') ||
        u.includes('image-cut-tos')) return false;
    return true;
  }

  // ---------- 提取：DOM 轮播（主路径） ----------
  function fromDom() {
    const urls = [];
    for (const im of document.querySelectorAll('img')) {
      const src = im.currentSrc || im.src || '';
      if (!isNoteImage(src)) continue;
      // 正文大图：渲染尺寸或原始尺寸达标
      const r = im.getBoundingClientRect();
      if (im.naturalWidth >= 500 || r.width >= 260) urls.push(src);
    }
    return dedupeByUri(urls);
  }

  // ---------- 提取：hydration 脚本（兜底，可拿到未渲染的图） ----------
  function fromScripts() {
    const urls = [];
    const re = /https:(?:\\\/\\\/|\/\/)[^"\\\s]+?douyinpic[^"\\\s]+?(?:aweme_images|tplv-dy-aweme-images)[^"\\\s]*/g;
    for (const sc of document.querySelectorAll('script')) {
      const t = sc.textContent || '';
      if (t.length < 200 || !t.includes('aweme_images')) continue;
      let m;
      while ((m = re.exec(t)) !== null) {
        const u = m[0].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
        if (isNoteImage(u)) urls.push(u);
      }
    }
    return dedupeByUri(urls);
  }

  // ---------- 页码总数（用于自动滑动加载，可选校验） ----------
  function pageIndicator() {
    // 抖音 PC 端轮播页码形如 "4/4"
    for (const el of document.querySelectorAll('div,span')) {
      if (el.children.length === 0) {
        const t = (el.textContent || '').trim();
        if (/^\d+\s*\/\s*\d+$/.test(t)) {
          const [cur, total] = t.split('/').map(s => parseInt(s, 10));
          if (total >= 1 && total <= 60) return { cur, total };
        }
      }
    }
    return null;
  }

  // ---------- 提取入口 ----------
  function extract() {
    let urls = fromDom();
    let source = 'dom';
    if (urls.length === 0) {
      urls = fromScripts();
      source = 'scripts';
    } else {
      // DOM 拿到的可能不全（懒加载），与脚本提取合并保序（DOM 优先）
      const scriptUrls = fromScripts();
      const known = new Set(urls.map(uriKey));
      for (const u of scriptUrls) {
        if (!known.has(uriKey(u))) { urls.push(u); known.add(uriKey(u)); }
      }
    }

    // 标题
    let title = document.title || '抖音图文';
    title = title.replace(/\s*[-–—|]\s*抖音.*$/, '').trim();
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) title = og.content.replace(/\s*[-–—|]\s*抖音.*$/, '').trim();

    const indicator = pageIndicator();
    return {
      ok: true,
      images: urls.map(u => ({ url: u })),
      title: title || '抖音图文',
      source,
      indicator, // {cur,total} 或 null
      count: urls.length,
    };
  }

  // ---------- 图片下载代理（页面同源上下文） ----------
  async function downloadImage(url) {
    // 注意：不能用 credentials:'include'——跨域带 Cookie 会触发 CORS 预检，
    // 抖音 CDN 拒绝预检导致 fetch 失败。默认 same-origin 模式即可（图片 CDN 不校验 Cookie）。
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    if (buf.byteLength < 500) throw new Error('图片数据过小');
    const u8 = new Uint8Array(buf);
    // u8 -> base64 分块
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(s);
  }

  // ---------- 消息处理 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'PING_EXTRACT_IMAGES') {
      try {
        sendResponse(extract());
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
      return false;
    }

    if (msg && msg.type === 'FETCH_IMAGES') {
      // 逐张下载（页面上下文），回传 {ok, results:[{ok,b64,error,url}...]}
      (async () => {
        const results = [];
        for (const u of msg.urls) {
          try {
            results.push({ ok: true, url: u, b64: await downloadImage(u) });
          } catch (e) {
            results.push({ ok: false, url: u, error: String((e && e.message) || e) });
          }
        }
        sendResponse({ ok: results.every(r => r.ok), results });
      })();
      return true; // 异步
    }
  });

})();
