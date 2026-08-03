async function fileToImage(fileOrBlob) {
  const url = URL.createObjectURL(fileOrBlob);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('画像を読み込めませんでした。'));
      image.src = url;
    });
    return image;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function expandImageInputs(files) {
  const results = [];
  for (const file of files) {
    const ext = extensionOf(file.name);
    if (!['cbz', 'zip'].includes(ext)) {
      results.push({ name: file.name, blob: file });
      continue;
    }
    if (!window.JSZip) throw new Error('JSZipの読み込みに失敗しました。ページを再読み込みしてください。');
    const zip = await window.JSZip.loadAsync(file);
    const entries = Object.values(zip.files)
      .filter((entry) => !entry.dir && IMAGE_EXTENSIONS.has(extensionOf(entry.name)))
      .sort((a, b) => naturalCompare(a.name, b.name));
    if (!entries.length) throw new Error(`${file.name}に対応画像がありません。`);
    for (const entry of entries) {
      results.push({ name: entry.name, blob: await entry.async('blob') });
    }
  }
  return results.sort((a, b) => naturalCompare(a.name, b.name));
}

function cropCanvas(sourceCanvas) {
  const maxSide = 1100;
  const scale = Math.min(1, maxSide / Math.max(sourceCanvas.width, sourceCanvas.height));
  const sample = document.createElement('canvas');
  sample.width = Math.max(1, Math.round(sourceCanvas.width * scale));
  sample.height = Math.max(1, Math.round(sourceCanvas.height * scale));
  const sampleCtx = sample.getContext('2d', { willReadFrequently: true });
  sampleCtx.drawImage(sourceCanvas, 0, 0, sample.width, sample.height);
  const bounds = findContentBounds(sampleCtx.getImageData(0, 0, sample.width, sample.height), sample.width, sample.height);
  const ratioX = sourceCanvas.width / sample.width;
  const ratioY = sourceCanvas.height / sample.height;
  const sx = Math.max(0, Math.floor(bounds.x * ratioX));
  const sy = Math.max(0, Math.floor(bounds.y * ratioY));
  const sw = Math.min(sourceCanvas.width - sx, Math.ceil(bounds.width * ratioX));
  const sh = Math.min(sourceCanvas.height - sy, Math.ceil(bounds.height * ratioY));
  if (sw >= sourceCanvas.width * 0.995 && sh >= sourceCanvas.height * 0.995) return sourceCanvas;
  const cropped = document.createElement('canvas');
  cropped.width = Math.max(1, sw);
  cropped.height = Math.max(1, sh);
  cropped.getContext('2d').drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return cropped;
}

function canvasToJpegBytes(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error('画像のJPEG変換に失敗しました。'));
        return;
      }
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/jpeg', quality);
  });
}

function buildJpegPdfBlob(images, format, marginMm) {
  if (!images.length) throw new Error('PDFにする画像がありません。');
  const encode = (text) => new TextEncoder().encode(text);
  const mmToPt = (mm) => Number(mm) * 72 / 25.4;
  const [baseMmW, baseMmH] = pageSizeMm(format);
  const margin = mmToPt(marginMm);
  const objectCount = 2 + images.length * 3;
  const objects = new Array(objectCount + 1);
  objects[1] = [encode('<< /Type /Catalog /Pages 2 0 R >>')];
  const kids = images.map((_, index) => `${3 + index * 3} 0 R`).join(' ');
  objects[2] = [encode(`<< /Type /Pages /Count ${images.length} /Kids [${kids}] >>`)];

  images.forEach((image, index) => {
    const pageId = 3 + index * 3;
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    let pageW = mmToPt(baseMmW);
    let pageH = mmToPt(baseMmH);
    if (image.width > image.height) [pageW, pageH] = [pageH, pageW];
    const availableW = Math.max(1, pageW - margin * 2);
    const availableH = Math.max(1, pageH - margin * 2);
    const ratio = Math.min(availableW / image.width, availableH / image.height);
    const drawW = image.width * ratio;
    const drawH = image.height * ratio;
    const x = (pageW - drawW) / 2;
    const y = (pageH - drawH) / 2;
    const content = encode(`q\n${drawW.toFixed(3)} 0 0 ${drawH.toFixed(3)} ${x.toFixed(3)} ${y.toFixed(3)} cm\n/Im0 Do\nQ\n`);

    objects[pageId] = [encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(3)} ${pageH.toFixed(3)}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`)];
    objects[imageId] = [
      encode(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Interpolate true /Length ${image.bytes.byteLength} >>\nstream\n`),
      image.bytes,
      encode('\nendstream'),
    ];
    objects[contentId] = [
      encode(`<< /Length ${content.byteLength} >>\nstream\n`),
      content,
      encode('endstream'),
    ];
  });

  const chunks = [];
  const offsets = new Array(objectCount + 1).fill(0);
  let byteOffset = 0;
  const push = (chunk) => {
    chunks.push(chunk);
    byteOffset += chunk.byteLength;
  };
  push(encode('%PDF-1.4\n%ShelfPDF\n'));
  for (let id = 1; id <= objectCount; id += 1) {
    offsets[id] = byteOffset;
    push(encode(`${id} 0 obj\n`));
    for (const part of objects[id]) push(part);
    push(encode('\nendobj\n'));
  }
  const xrefOffset = byteOffset;
  push(encode(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`));
  for (let id = 1; id <= objectCount; id += 1) {
    push(encode(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`));
  }
  push(encode(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
  return new Blob(chunks, { type: 'application/pdf' });
}

function downloadPdfBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function makeImagePdf() {
  const status = $('#imageStatus');
  const progress = $('#imageProgress');
  $('#makeImagePdf').disabled = true;
  try {
    setStatus(status, '画像を展開しています。');
    setProgress(progress, 2);
    const images = await expandImageInputs(state.imageFiles);
    if (!images.length) throw new Error('PDFにする画像がありません。');

    const format = $('#imagePageSize').value;
    const margin = Number($('#imageMargin').value);
    const quality = Number($('#imageQuality').value) / 100;
    const shouldCrop = $('#autoCrop').checked;
    const prepared = [];

    for (let index = 0; index < images.length; index += 1) {
      const source = images[index];
      setStatus(status, `${index + 1}/${images.length} ${source.name}を処理中…`);
      setProgress(progress, 5 + ((index + 0.25) / images.length) * 85);
      const image = await fileToImage(source.blob);
      const maxPixels = 26_000_000;
      const shrink = Math.min(1, Math.sqrt(maxPixels / (image.naturalWidth * image.naturalHeight)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * shrink));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * shrink));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const finalCanvas = shouldCrop ? cropCanvas(canvas) : canvas;
      prepared.push({
        bytes: await canvasToJpegBytes(finalCanvas, quality),
        width: finalCanvas.width,
        height: finalCanvas.height,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    setStatus(status, 'PDFを組み立てています…');
    setProgress(progress, 94);
    const pdfBlob = buildJpegPdfBlob(prepared, format, margin);
    const firstName = state.imageFiles[0]?.name || 'images';
    const name = state.imageFiles.length === 1 ? stemOf(firstName) : `${stemOf(firstName)}_and_${state.imageFiles.length - 1}_more`;
    downloadPdfBlob(pdfBlob, `${safeFilename(name, 'images')}.pdf`);
    setProgress(progress, 100);
    setStatus(status, `${images.length}ページのPDFを作成しました。`, 'success');
  } catch (error) {
    console.error(error);
    setStatus(status, error.message || 'PDF作成に失敗しました。', 'error');
  } finally {
    $('#makeImagePdf').disabled = state.imageFiles.length === 0;
    setTimeout(() => setProgress(progress, 0, false), 700);
  }
}