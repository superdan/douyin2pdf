/* 抖音图文转PDF - 纯原生 JS PDF 1.4 生成器（零依赖）
 * 核心：PDFDocument 流式序列化；图片以 JPEG(DCTDecode) 内嵌
 * 页面树使用 Catalog/Pages(Kids) 标准结构
 */
'use strict';

const PDFGen = (() => {

  // ---------- 基础值类型 ----------
  function PDFName(n) { this.name = n; }
  function PDFRef(id) { this.id = id; }

  class PDFDocument {
    constructor() {
      this.objects = [];          // 下标 i -> 对象编号 i+1
      this.streams = new Map();   // objId -> Uint8Array（流内容）
      this.pageRefs = [];
    }

    add(obj) {
      this.objects.push(obj);
      return new PDFRef(this.objects.length);
    }

    // 先建 Catalog 与 Pages 占位，页全部加入后 end() 定稿
    createDocument() {
      this.catalogRef = this.add(null);
      this.pagesRef = this.add(null);
      return this;
    }

    addPage(page) {
      page.Parent = this.pagesRef;
      this.pageRefs.push(this.add(page));
    }

    end() {
      this.objects[this.catalogRef.id - 1] = {
        Type: new PDFName('Catalog'),
        Pages: this.pagesRef,
      };
      this.objects[this.pagesRef.id - 1] = {
        Type: new PDFName('Pages'),
        Kids: this.pageRefs,
        Count: this.pageRefs.length,
      };
    }
  }

  // ---------- 数字格式化 ----------
  function fmt(n) {
    if (Number.isInteger(n)) return String(n);
    let s = n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }

  // ---------- PDF 字面字符串转义（latin1 输出） ----------
  function escapeStr(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 0x28) out += '\\(';
      else if (c === 0x29) out += '\\)';
      else if (c === 0x5C) out += '\\\\';
      else if (c < 0x20 || c > 0x7E) {
        let oct = c.toString(8);
        while (oct.length < 3) oct = '0' + oct;
        out += '\\' + oct;
      } else out += s[i];
    }
    return out;
  }

  // ---------- 值写入器 ----------
  function writeVal(v, push) {
    if (v === null || v === undefined) { push('null'); return; }
    if (v instanceof PDFRef) { push(`${v.id} 0 R`); return; }
    if (v instanceof PDFName) { push('/' + v.name); return; }
    if (Array.isArray(v)) {
      push('[');
      v.forEach((item, i) => { if (i) push(' '); writeVal(item, push); });
      push(']');
      return;
    }
    switch (typeof v) {
      case 'number': push(fmt(v)); return;
      case 'boolean': push(v ? 'true' : 'false'); return;
      case 'string': push('(' + escapeStr(v) + ')'); return;
      case 'object': {
        push('<<');
        for (const k of Object.keys(v)) {
          const val = v[k];
          if (val === null || val === undefined) continue;
          push(`/${k} `);
          writeVal(val, push);
        }
        push('>>');
        return;
      }
    }
  }

  // ---------- JPEG SOF 解析（支持基线/渐进） ----------
  function parseJpegSize(bytes) {
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) throw new Error('非JPEG数据');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let i = 2;
    while (i + 4 <= bytes.length) {
      if (bytes[i] !== 0xFF) { i++; continue; }
      const m = bytes[i + 1];
      if (m === 0xFF) { i++; continue; }
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
      if (m === 0xD9) break;
      const len = view.getUint16(i + 2);
      if ((m >= 0xC0 && m <= 0xCF) && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return {
          height: view.getUint16(i + 5),
          width: view.getUint16(i + 7),
          components: bytes[i + 9],
        };
      }
      i += 2 + len;
    }
    throw new Error('JPEG解析失败：未找到SOF段');
  }

  // ---------- 主入口 ----------
  async function pdfFromBlobs(blobs, opts = {}) {
    const dpi = opts.dpi || 150;
    const quality = opts.quality !== undefined ? opts.quality : 0.85;
    const marginPt = opts.marginPt !== undefined ? opts.marginPt : 20;
    const A4W = 595.276, A4H = 841.89; // A4 纵向，单位 pt

    const doc = new PDFDocument().createDocument();

    // 1) 解码图片
    const bmps = [];
    for (const b of blobs) {
      bmps.push(await createImageBitmap(b));
    }

    try {
      // 2) 逐张转 JPEG 并构建页面对象
      for (const bmp of bmps) {
        const w = bmp.width, h = bmp.height;
        // 像素尺寸限制在 A4 可打印区域内（150 DPI）
        const maxWPx = Math.round((A4W - marginPt * 2) / 72 * dpi);
        const maxHPx = Math.round((A4H - marginPt * 2) / 72 * dpi);
        const scale = Math.min(maxWPx / w, maxHPx / h, 1);
        const tw = Math.max(1, Math.round(w * scale));
        const th = Math.max(1, Math.round(h * scale));

        let outCanvas;
        if (tw === w && th === h) {
          outCanvas = new OffscreenCanvas(w, h);
          outCanvas.getContext('2d').drawImage(bmp, 0, 0);
        } else {
          outCanvas = new OffscreenCanvas(tw, th);
          const ctx = outCanvas.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(bmp, 0, 0, w, h, 0, 0, tw, th);
        }

        const jpegBlob = await outCanvas.convertToBlob({ type: 'image/jpeg', quality });
        const bytes = new Uint8Array(await jpegBlob.arrayBuffer());
        const dims = parseJpegSize(bytes);

        // 页面版心 pt 尺寸：按 DPI 换算（≤ A4 可打印区域）
        let ptW = dims.width / dpi * 72;
        let ptH = dims.height / dpi * 72;
        if (ptW > A4W - marginPt * 2 || ptH > A4H - marginPt * 2) {
          const s = Math.min((A4W - marginPt * 2) / ptW, (A4H - marginPt * 2) / ptH);
          ptW *= s; ptH *= s;
        }

        // 图像 XObject（流对象）
        const imgRef = doc.add({
          Type: new PDFName('XObject'),
          Subtype: new PDFName('Image'),
          Width: dims.width,
          Height: dims.height,
          ColorSpace: new PDFName('DeviceRGB'),
          BitsPerComponent: 8,
          Filter: new PDFName('DCTDecode'),
        });
        doc.streams.set(imgRef.id, bytes);

        // 内容流：cm 矩阵将图片铺满版心
        // PDF 坐标系原点在左下角、Y 向上：图片左下角 x=marginPt, y=A4H-marginPt-ptH
        const content =
          `q ${fmt(ptW)} 0 0 ${fmt(ptH)} ` +
          `${fmt(marginPt)} ${fmt(A4H - marginPt - ptH)} cm /Im${imgRef.id} Do Q`;
        const contentRef = doc.add({ Length: content.length });
        doc.streams.set(contentRef.id, new TextEncoder().encode(content));

        // 页面对象（MediaBox 必须是数字，由 writeVal 格式化）
        doc.addPage({
          Type: new PDFName('Page'),
          MediaBox: [0, 0, A4W, A4H],
          Resources: { XObject: { ['Im' + imgRef.id]: imgRef } },
          Contents: contentRef,
        });
      }

      doc.end();

      // 3) 序列化
      const out = serialize(doc);
      return { blob: new Blob([out], { type: 'application/pdf' }) };
    } finally {
      for (const b of bmps) { if (b.close) b.close(); }
    }
  }

  // ---------- 序列化（含流与 xref/trailer） ----------
  function serialize(doc) {
    const chunks = [];
    let offset = 0;
    const push = (s) => { chunks.push(s); offset += s.length; };
    const pushBytes = (u8) => {
      // 二进制按 latin1 语义入 chunk
      let s = '';
      const CH = 0x8000;
      for (let i = 0; i < u8.length; i += CH) {
        s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      }
      chunks.push(s);
      offset += u8.length;
    };

    push('%PDF-1.4\n');
    push('%\xE2\xE3\xCF\xD3\n');

    // Info 对象
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const infoRef = doc.add({
      Producer: '(douyin-note-to-pdf chrome extension)',
      Creator: '(douyin-note-to-pdf chrome extension)',
      CreationDate: `(D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z)`,
    });

    const offsets = new Array(doc.objects.length + 1);

    for (let i = 0; i < doc.objects.length; i++) {
      const obj = doc.objects[i];
      if (obj === null) continue;
      const id = i + 1;
      offsets[id] = offset;
      push(`${id} 0 obj\n`);
      writeVal(obj, push);
      const streamBytes = doc.streams.get(id);
      if (streamBytes) {
        push('\nstream\n');
        pushBytes(streamBytes);
        push('\nendstream');
      }
      push('\nendobj\n');
    }

    const xrefStart = offset;
    const count = doc.objects.length + 1;
    push(`xref\n0 ${count}\n`);
    push('0000000000 65535 f \n');
    for (let id = 1; id < count; id++) {
      const o = offsets[id] !== undefined ? offsets[id] : 0;
      push(`${String(o).padStart(10, '0')} 00000 n \n`);
    }
    push(`trailer << /Size ${count} /Root 1 0 R /Info ${infoRef.id} 0 R >>\n`);
    push(`startxref\n${xrefStart}\n`);
    push('%%EOF');

    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) {
      for (let i = 0; i < c.length; i++) out[p++] = c.charCodeAt(i) & 0xFF;
    }
    return out;
  }

  return { pdfFromBlobs };
})();
