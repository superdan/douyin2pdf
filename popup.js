/* 弹窗逻辑：检测页面 -> 提取图片 -> 缩略图（页面代理）/预览 -> 生成PDF并保存 */
'use strict';

const $ = (id) => document.getElementById(id);
const statusEl = $('status'), thumbBox = $('thumbBox'), titleEl = $('title'),
      goBtn = $('go'), barWrap = $('barWrap'), bar = $('bar'),
      pageInfo = $('pageInfo');

let currentTabId = null;
let images = []; // {url}

function setStatus(msg, cls = '') {
  statusEl.textContent = msg;
  statusEl.className = cls;
}

function setProgress(pct) {
  barWrap.classList.add('show');
  bar.style.width = pct + '%';
}

// ---------- 启动：探测当前标签页 ----------
(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { setStatus('未找到当前标签页。', 'err'); return; }
  currentTabId = tab.id;

  // 搜索页/带 modal_id 的链接：自动跳转到标准笔记页（复用既有提取逻辑）
  const url = tab.url || '';
  const searchMatch = url.match(/^https:\/\/(www\.)?douyin\.com\/search\/[^?]*\?.*modal_id=(\d+)/);
  if (searchMatch) {
    const noteId = searchMatch[2];
    const noteUrl = `https://www.douyin.com/note/${noteId}`;
    setStatus(`检测到搜索页链接，正在跳转到笔记页…`);
    await chrome.tabs.update(currentTabId, { url: noteUrl });
    // 等待新页面加载 + content script 注入，轮询探测就绪（最长约 12 秒）
    let ready = false;
    let navigated = false;
    for (let i = 0; i < 40; i++) {
      await new Promise(res => setTimeout(res, 300));
      // 关键：先确认标签页已真正跳转到笔记页。
      // 跳转发起后旧搜索页卸载前仍会应答 PING（标题是搜索页的），必须忽略。
      const [t] = await chrome.tabs.get(currentTabId);
      if (!t || !t.url || !t.url.includes(`/note/${noteId}`)) continue;
      navigated = true;
      const resp = await chrome.tabs.sendMessage(currentTabId, { type: 'PING_EXTRACT_IMAGES' }).catch(() => null);
      if (resp && resp.ok && (resp.images || []).length) {
        handleExtract(resp);
        return;
      }
      if (resp && resp.ok) ready = true; // script 已注入但图片未加载完，继续等
    }
    setStatus(navigated
      ? (ready ? '笔记页已打开但未找到图片，请稍等图片加载后重新点击插件图标。'
               : '跳转超时，请打开笔记页后重新点击插件图标。')
      : '页面跳转失败，请手动打开笔记页后再点插件图标。', 'err');
    return;
  }

  if (!/^https:\/\/(www\.)?douyin\.com\/(note|video)\/\d+/.test(url)) {
    setStatus('请先打开抖音图文页面（douyin.com/note/…），再点击本插件图标。', 'err');
    return;
  }

  const resp = await chrome.tabs.sendMessage(currentTabId, { type: 'PING_EXTRACT_IMAGES' }).catch(() => null);
  if (!resp || !resp.ok) {
    setStatus('页面未响应，请刷新抖音页面后重新打开插件。', 'err');
    return;
  }
  handleExtract(resp);
})();

// ---------- 提取结果处理 ----------
function handleExtract(resp) {
  images = resp.images || [];
  if (!images.length) {
    setStatus('未在页面中找到图文图片。若刚打开页面，请稍等图片加载后重试。', 'err');
    return;
  }

  const ind = resp.indicator;
  pageInfo.textContent = ind && ind.total
    ? `${images.length} 张图${ind.total !== images.length ? `（页面显示共 ${ind.total} 张）` : ''}`
    : `${images.length} 张图`;

  let hint = `已识别 ${images.length} 张图片，点击缩略图可取消选择。`;
  if (ind && ind.total > images.length) {
    hint = `识别到 ${images.length} 张，页面共 ${ind.total} 张：请在页面上左右滑完所有图片后再点插件图标。`;
  }
  setStatus(hint);
  renderThumbs(resp.title);
}

// ---------- 缩略图（通过页面上下文取 dataURL，规避 CDN 拒绝扩展源） ----------
let thumbCache = {}; // url -> dataURL

async function getThumbDataUrl(url) {
  if (thumbCache[url]) return thumbCache[url];
  const resp = await chrome.tabs.sendMessage(currentTabId, {
    type: 'FETCH_IMAGES', urls: [url],
  }).catch(() => null);
  if (!resp || !resp.ok || !resp.results[0].ok) return null;
  const b64 = resp.results[0].b64;
  // 缩略图无需全分辨率：转成小图减少内存（直接用原 dataURL 也可，图片一般 <500KB）
  const dataUrl = 'data:image/webp;base64,' + b64;
  thumbCache[url] = dataUrl;
  return dataUrl;
}

function renderThumbs(title) {
  thumbBox.classList.add('show');
  thumbBox.innerHTML = '';
  images.forEach((im, i) => {
    const div = document.createElement('div');
    div.className = 'thumb selected';
    div.innerHTML = `<span class="no">${i + 1}</span><span class="pick"></span>`;
    const img = document.createElement('img');
    img.alt = i + 1;
    div.appendChild(img);

    // 异步取缩略图
    getThumbDataUrl(im.url).then(du => {
      if (du) img.src = du;
      else div.title = '预览不可用（仍可生成PDF）';
    });

    div.onclick = () => {
      div.classList.toggle('selected');
      const n = thumbBox.querySelectorAll('.thumb.selected').length;
      setStatus(`已选 ${n}/${images.length} 张`);
    };
    thumbBox.appendChild(div);
  });

  titleEl.style.display = '';
  titleEl.value = title || '抖音图文';
  goBtn.disabled = false;
}

// ---------- 生成 ----------
goBtn.onclick = async () => {
  goBtn.disabled = true;
  setProgress(10);
  try {
    const sel = [];
    thumbBox.querySelectorAll('.thumb').forEach((el, i) => {
      if (el.classList.contains('selected')) sel.push(images[i].url);
    });
    if (!sel.length) { setStatus('请至少选择一张图片。', 'err'); goBtn.disabled = false; return; }

    const filename = (titleEl.value.trim() || '抖音图文') + '.pdf';
    setStatus(`正在下载 ${sel.length} 张图片并合成 PDF…`);
    setProgress(40);

    const resp = await chrome.runtime.sendMessage({
      type: 'MAKE_PDF',
      tabId: currentTabId,
      urls: sel,
    });

    if (!resp || !resp.ok) throw new Error((resp && resp.error) || '生成失败');

    setProgress(90);
    const bin = atob(resp.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = sanitizeFilename(filename);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 8000);

    setProgress(100);
    setStatus(`PDF 已生成（${(bytes.length / 1024 / 1024).toFixed(1)} MB），已开始保存。`, 'ok');
  } catch (e) {
    setStatus('出错：' + e.message, 'err');
  } finally {
    goBtn.disabled = false;
    setTimeout(() => barWrap.classList.remove('show'), 2500);
  }
};

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}
