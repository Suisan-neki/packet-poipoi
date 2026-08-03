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

async function makeImagePdf() {
  const status = $('#imageStatus');
  const progress = $('#imageProgress');
  $('#makeImagePdf').disabled = true;
  try {
    if (!window.jspdf?.jsPDF) throw new Error('PDFライブラリの読み込みに失敗しました。ページを再読み込みしてください。');
    setStatus(status, '画像を展開しています。');
    setProgress(progress, 2);
    const images = await expandImageInputs(state.imageFiles);
    if (!images.length) throw new Error('PDFにする画像がありません。');

    const format = $('#imagePageSize').value;
    const margin = Number($('#imageMargin').value);
    const quality = Number($('#imageQuality').value) / 100;
    const shouldCrop = $('#autoCrop').checked;
    const baseSize = pageSizeMm(format);
    let pdf = null;

    for (let index = 0; index < images.length; index += 1) {
      const source = images[index];
      setStatus(status, `${index + 1}/${images.length} ${source.name}を処理中…`);
      setProgress(progress, 5 + ((index + 0.25) / images.length) * 90);
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

      let [pageW, pageH] = baseSize;
      if (finalCanvas.width > finalCanvas.height) [pageW, pageH] = [pageH, pageW];
      const orientation = pageW > pageH ? 'landscape' : 'portrait';
      if (!pdf) {
        pdf = new window.jspdf.jsPDF({ unit: 'mm', format: [pageW, pageH], orientation, compress: true });
      } else {
        pdf.addPage([pageW, pageH], orientation);
      }
      const availableW = Math.max(1, pageW - margin * 2);
      const availableH = Math.max(1, pageH - margin * 2);
      const ratio = Math.min(availableW / finalCanvas.width, availableH / finalCanvas.height);
      const drawW = finalCanvas.width * ratio;
      const drawH = finalCanvas.height * ratio;
      const x = (pageW - drawW) / 2;
      const y = (pageH - drawH) / 2;
      const data = finalCanvas.toDataURL('image/jpeg', quality);
      pdf.addImage(data, 'JPEG', x, y, drawW, drawH, undefined, 'FAST');
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const firstName = state.imageFiles[0]?.name || 'images';
    const name = state.imageFiles.length === 1 ? stemOf(firstName) : `${stemOf(firstName)}_and_${state.imageFiles.length - 1}_more`;
    pdf.save(`${safeFilename(name, 'images')}.pdf`);
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
