/* 离屏文档：接收 base64 图片，调用 PDFGen 生成 PDF 并以 base64 回传 */
'use strict';

// u8 -> base64（分块）
function u8ToB64(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  }
  return btoa(s);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 就绪握手：background 创建离屏文档后探测脚本是否已加载
  if (msg && msg.type === 'OFFSCREEN_PING') {
    sendResponse({ ok: true });
    return false;
  }

  if (msg && msg.type === 'OFFSCREEN_MAKE_PDF' && msg.bufs) {
    (async () => {
      try {
        // base64 -> Uint8Array -> Blob
        const blobs = msg.bufs.map(b64 => {
          const bin = atob(b64);
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          return new Blob([u8]);
        });

        const { blob } = await PDFGen.pdfFromBlobs(blobs, {
          dpi: 150,
          quality: msg.quality !== undefined ? msg.quality : 0.85,
          marginPt: 20,
        });

        const u8 = new Uint8Array(await blob.arrayBuffer());
        sendResponse({ ok: true, b64: u8ToB64(u8) });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true; // 异步 sendResponse
  }
});
