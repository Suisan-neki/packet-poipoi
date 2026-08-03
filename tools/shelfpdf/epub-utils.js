function findZipEntry(zip, path) {
  const clean = String(path || '').replace(/^\/+/, '').split(/[?#]/, 1)[0];
  const candidates = [clean];
  try { candidates.push(decodeURIComponent(clean)); } catch {}
  try { candidates.push(encodeURI(clean).replace(/%25/g, '%')); } catch {}
  for (const candidate of candidates) {
    if (zip.file(candidate)) return zip.file(candidate);
  }
  const lower = clean.toLowerCase();
  const key = Object.keys(zip.files).find((name) => name.toLowerCase() === lower);
  return key ? zip.file(key) : null;
}

function mimeForPath(path) {
  const ext = extensionOf(path);
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    svg: 'image/svg+xml', css: 'text/css', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  };
  return map[ext] || 'application/octet-stream';
}

async function replaceAsync(source, regex, replacer) {
  const matches = [...source.matchAll(regex)];
  if (!matches.length) return source;
  let cursor = 0;
  let output = '';
  for (const match of matches) {
    output += source.slice(cursor, match.index);
    output += await replacer(match);
    cursor = match.index + match[0].length;
  }
  return output + source.slice(cursor);
}
