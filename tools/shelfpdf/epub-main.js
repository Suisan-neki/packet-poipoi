async function prepareEpub() {
  const status = $('#epubStatus');
  const progress = $('#epubProgress');
  $('#prepareEpub').disabled = true;
  state.epubObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  state.epubObjectUrls = [];
  try {
    if (!state.epubFile) throw new Error('EPUBを選択してください。');
    if (!window.JSZip) throw new Error('JSZipの読み込みに失敗しました。ページを再読み込みしてください。');
    setStatus(status, 'EPUBを展開しています。');
    setProgress(progress, 3);
    const zip = await window.JSZip.loadAsync(state.epubFile);

    const encryptionEntry = findZipEntry(zip, 'META-INF/encryption.xml');
    if (encryptionEntry) {
      const algorithms = detectEncryptedAlgorithms(await encryptionEntry.async('text'));
      const unsupported = algorithms.filter((algorithm) => !isAllowedFontObfuscation(algorithm));
      if (unsupported.length) throw new Error('通常のフォント難読化以外の暗号化が見つかったため処理を停止しました。');
    }

    const containerEntry = findZipEntry(zip, 'META-INF/container.xml');
    if (!containerEntry) throw new Error('EPUBのcontainer.xmlが見つかりません。');
    const containerDoc = new DOMParser().parseFromString(await containerEntry.async('text'), 'application/xml');
    const rootfile = containerDoc.querySelector('rootfile');
    const opfPath = rootfile?.getAttribute('full-path');
    if (!opfPath) throw new Error('EPUBのパッケージ情報を取得できません。');
    const opfEntry = findZipEntry(zip, opfPath);
    if (!opfEntry) throw new Error('EPUBのOPFファイルが見つかりません。');
    const opfDoc = new DOMParser().parseFromString(await opfEntry.async('text'), 'application/xml');
    const manifest = new Map();
    opfDoc.querySelectorAll('manifest > item, package > manifest > item').forEach((item) => {
      manifest.set(item.getAttribute('id'), {
        href: item.getAttribute('href'),
        mediaType: item.getAttribute('media-type') || '',
        properties: item.getAttribute('properties') || '',
      });
    });
    const spine = [...opfDoc.querySelectorAll('spine > itemref, package > spine > itemref')]
      .map((item) => manifest.get(item.getAttribute('idref')))
      .filter(Boolean);
    if (!spine.length) throw new Error('EPUBの本文順序を取得できません。');
    const titleNode = opfDoc.querySelector('metadata > title, metadata > dc\\:title, dc\\:title');
    const title = titleNode?.textContent?.trim() || stemOf(state.epubFile.name);
    const objectUrlCache = new Map();

    const getObjectUrl = async (path) => {
      const clean = path.split(/[?#]/, 1)[0];
      if (objectUrlCache.has(clean)) return objectUrlCache.get(clean);
      const entry = findZipEntry(zip, clean);
      if (!entry) return null;
      const blob = new Blob([await entry.async('arraybuffer')], { type: mimeForPath(clean) });
      const url = URL.createObjectURL(blob);
      objectUrlCache.set(clean, url);
      state.epubObjectUrls.push(url);
      return url;
    };

    const loadCss = async (cssPath, seen = new Set()) => {
      const clean = cssPath.split(/[?#]/, 1)[0];
      if (seen.has(clean)) return '';
      seen.add(clean);
      const entry = findZipEntry(zip, clean);
      if (!entry) return '';
      let css = await entry.async('text');
      css = await replaceAsync(css, /@import\s+(?:url\()?\s*['"]?([^'"\)\s;]+)['"]?\s*\)?\s*;/gi, async (match) => {
        const imported = normalizeZipPath(clean, match[1]);
        if (/^(?:[a-z]+:|\/\/)/i.test(imported)) return '';
        return loadCss(imported, seen);
      });
      css = await replaceAsync(css, /url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, async (match) => {
        const target = match[2].trim();
        if (!target || target.startsWith('#') || /^(?:data:|blob:)/i.test(target)) return match[0];
        if (/^(?:https?:|\/\/|javascript:)/i.test(target)) return 'url("")';
        const resolved = normalizeZipPath(clean, target);
        const url = await getObjectUrl(resolved);
        return url ? `url("${url}")` : 'url("")';
      });
      return css;
    };

    const sections = [];
    const styles = [];
    for (let index = 0; index < spine.length; index += 1) {
      const item = spine[index];
      const docPath = normalizeZipPath(opfPath, item.href);
      const entry = findZipEntry(zip, docPath);
      if (!entry) continue;
      setStatus(status, `${index + 1}/${spine.length}章を準備中…`);
      setProgress(progress, 8 + ((index + 1) / spine.length) * 84);
      const source = await entry.async('text');
      let doc = new DOMParser().parseFromString(source, 'application/xhtml+xml');
      if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(source, 'text/html');
      sanitizeDocument(doc);

      for (const link of [...doc.querySelectorAll('link[rel~="stylesheet"]')]) {
        const href = link.getAttribute('href');
        if (href && !/^(?:[a-z]+:|\/\/)/i.test(href)) styles.push(await loadCss(normalizeZipPath(docPath, href)));
        link.remove();
      }
      for (const style of doc.querySelectorAll('style')) {
        style.textContent = await replaceAsync(style.textContent || '', /url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, async (match) => {
          const target = match[2].trim();
          if (!target || target.startsWith('#') || /^(?:data:|blob:)/i.test(target)) return match[0];
          if (/^(?:https?:|\/\/|javascript:)/i.test(target)) return 'url("")';
          const url = await getObjectUrl(normalizeZipPath(docPath, target));
          return url ? `url("${url}")` : 'url("")';
        });
        styles.push(style.textContent || '');
        style.remove();
      }
      const resourceAttrs = [
        ['img[src]', 'src'], ['source[src]', 'src'], ['svg image[href]', 'href'], ['svg image[xlink\\:href]', 'xlink:href'],
      ];
      for (const [selector, attr] of resourceAttrs) {
        for (const node of doc.querySelectorAll(selector)) {
          const value = node.getAttribute(attr);
          if (!value || /^(?:data:|blob:)/i.test(value)) continue;
          if (/^(?:https?:|\/\/|javascript:)/i.test(value)) {
            node.removeAttribute(attr);
            continue;
          }
          const url = await getObjectUrl(normalizeZipPath(docPath, value));
          if (url) node.setAttribute(attr, url); else node.removeAttribute(attr);
        }
      }
      doc.querySelectorAll('[srcset]').forEach((node) => node.removeAttribute('srcset'));
      doc.querySelectorAll('svg use, foreignObject, link').forEach((node) => node.remove());
      for (const node of doc.querySelectorAll('[style]')) {
        const value = node.getAttribute('style') || '';
        if (/url\s*\(/i.test(value) && !/url\s*\(\s*['"]?(?:data:image\/|blob:)/i.test(value)) {
          node.removeAttribute('style');
        }
      }
      doc.querySelectorAll('video,audio').forEach((node) => node.remove());
      doc.querySelectorAll('a[href]').forEach((anchor) => {
        const href = anchor.getAttribute('href') || '';
        if (/^https?:/i.test(href)) {
          anchor.setAttribute('target', '_blank');
          anchor.setAttribute('rel', 'noopener noreferrer');
        } else if (!href.startsWith('#')) {
          anchor.removeAttribute('href');
        }
      });
      const body = doc.body || doc.documentElement;
      const bodyClass = body.getAttribute('class') || '';
      const bodyStyle = body.getAttribute('style') || '';
      const lang = body.getAttribute('lang') || doc.documentElement.getAttribute('lang') || 'ja';
      sections.push(`<section class="epub-section ${escapeHtml(bodyClass)}" id="chapter-${index + 1}" lang="${escapeHtml(lang)}" style="${escapeHtml(bodyStyle)}">${body.innerHTML}</section>`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (!sections.length) throw new Error('表示できる本文が見つかりません。');

    const pageSize = $('#epubPageSize').value;
    const margin = Number($('#epubMargin').value);
    const fontScale = Number($('#fontScale').value);
    const writingMode = $('#writingMode').value;
    const writingCss = writingMode === 'vertical'
      ? '.epub-section { writing-mode: vertical-rl !important; text-orientation: mixed; }'
      : writingMode === 'horizontal'
        ? '.epub-section { writing-mode: horizontal-tb !important; }'
        : '';
    const frameHtml = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
      @page { size: ${pageSize}; margin: ${margin}mm; }
      html { background: #e7eaf0; font-size: ${fontScale}%; }
      body { margin: 0; padding: 16px 0; color: #111; background: #e7eaf0; font-family: -apple-system, BlinkMacSystemFont, "Yu Mincho", "Hiragino Mincho ProN", serif; }
      .epub-section { width: min(210mm, calc(100% - 24px)); min-height: 260mm; margin: 0 auto 16px; padding: ${margin}mm; background: white; box-shadow: 0 2px 12px rgba(0,0,0,.12); overflow-wrap: anywhere; box-sizing: border-box; }
      .epub-section + .epub-section { break-before: page; }
      img, svg { max-width: 100%; height: auto; }
      pre { white-space: pre-wrap; }
      ${writingCss}
      @media print {
        html, body { background: white; }
        body { padding: 0; }
        .epub-section { width: auto; min-height: auto; margin: 0; padding: 0; box-shadow: none; }
      }
    </style>${styles.map((css) => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`).join('')}</head><body>${sections.join('')}</body></html>`;

    const frame = $('#epubPreview');
    frame.srcdoc = frameHtml;
    $('#previewTitle').textContent = `${title} — ${sections.length}章`;
    $('#previewWrap').hidden = false;
    setProgress(progress, 100);
    setStatus(status, '印刷用プレビューを作成しました。「印刷画面を開く」からPDFとして保存してください。', 'success');
  } catch (error) {
    console.error(error);
    $('#previewWrap').hidden = true;
    setStatus(status, error.message || 'EPUBの処理に失敗しました。', 'error');
  } finally {
    $('#prepareEpub').disabled = !state.epubFile;
    setTimeout(() => setProgress(progress, 0, false), 700);
  }
}
