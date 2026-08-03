const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function extensionOf(name) {
  const clean = String(name).split(/[?#]/, 1)[0];
  const index = clean.lastIndexOf('.');
  return index >= 0 ? clean.slice(index + 1).toLowerCase() : '';
}

function stemOf(name) {
  const base = String(name).split('/').pop() || 'output';
  return base.replace(/\.[^.]+$/, '') || 'output';
}

function normalizeZipPath(baseFile, target) {
  const raw = String(target || '').trim();
  if (!raw || raw.startsWith('#') || /^(?:[a-z]+:|\/\/)/i.test(raw)) return raw;
  const suffixIndex = raw.search(/[?#]/);
  const suffix = suffixIndex >= 0 ? raw.slice(suffixIndex) : '';
  const pathOnly = suffixIndex >= 0 ? raw.slice(0, suffixIndex) : raw;
  const baseDir = String(baseFile || '').split('/').slice(0, -1);
  const parts = pathOnly.startsWith('/') ? [] : baseDir;
  for (const part of pathOnly.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `${parts.join('/')}${suffix}`;
}

function pageSizeMm(name) {
  switch (String(name).toLowerCase()) {
    case 'a5': return [148, 210];
    case 'letter': return [215.9, 279.4];
    default: return [210, 297];
  }
}

function safeFilename(value, fallback = 'output') {
  const cleaned = String(value || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return cleaned || fallback;
}

function findContentBounds(imageData, width, height, tolerance = 28, padding = 3) {
  if (!imageData || !width || !height) return { x: 0, y: 0, width, height };
  const data = imageData.data || imageData;
  const samples = [];
  const sampleSize = Math.max(1, Math.floor(Math.min(width, height) * 0.015));
  const corners = [
    [0, 0], [Math.max(0, width - sampleSize), 0],
    [0, Math.max(0, height - sampleSize)],
    [Math.max(0, width - sampleSize), Math.max(0, height - sampleSize)],
  ];
  for (const [sx, sy] of corners) {
    for (let y = sy; y < Math.min(height, sy + sampleSize); y += 1) {
      for (let x = sx; x < Math.min(width, sx + sampleSize); x += 1) {
        const i = (y * width + x) * 4;
        if (data[i + 3] > 10) samples.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
  }
  const bg = [0, 1, 2].map((channel) => {
    const values = samples.map((sample) => sample[channel]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)] ?? 255;
  });
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (data[i + 3] <= 10) continue;
      const distance = Math.sqrt(
        (data[i] - bg[0]) ** 2 +
        (data[i + 1] - bg[1]) ** 2 +
        (data[i + 2] - bg[2]) ** 2,
      );
      if (distance > tolerance) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < minX || maxY < minY) return { x: 0, y: 0, width, height };
  const x = Math.max(0, minX - padding);
  const y = Math.max(0, minY - padding);
  return {
    x,
    y,
    width: Math.min(width - x, maxX - minX + 1 + padding * 2),
    height: Math.min(height - y, maxY - minY + 1 + padding * 2),
  };
}

function sanitizeDocument(doc) {
  const blocked = 'script,iframe,object,embed,form,input,button,textarea,select,base,portal';
  doc.querySelectorAll(blocked).forEach((node) => node.remove());
  doc.querySelectorAll('meta[http-equiv]').forEach((node) => {
    if ((node.getAttribute('http-equiv') || '').toLowerCase() === 'refresh') node.remove();
  });
  for (const element of doc.querySelectorAll('*')) {
    for (const attr of [...element.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith('on') || ['srcdoc', 'action', 'formaction'].includes(name)) {
        element.removeAttribute(attr.name);
        continue;
      }
      if (['href', 'src', 'xlink:href'].includes(name) && /^(?:javascript|vbscript):/i.test(value)) {
        element.removeAttribute(attr.name);
      }
      if (name === 'style' && /(?:expression\s*\(|url\s*\(\s*['"]?\s*javascript:)/i.test(value)) {
        element.removeAttribute(attr.name);
      }
    }
  }
  return doc;
}

function detectEncryptedAlgorithms(xmlText) {
  if (!xmlText) return [];
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  return [...doc.querySelectorAll('EncryptionMethod')]
    .map((node) => node.getAttribute('Algorithm'))
    .filter(Boolean);
}

function isAllowedFontObfuscation(algorithm) {
  return [
    'http://www.idpf.org/2008/embedding',
    'http://ns.adobe.com/pdf/enc#RC',
  ].includes(algorithm);
}
