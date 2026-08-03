function registerServiceWorker() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

setupTabs();
setupDropZone($('#imageDrop'), $('#imageInput'), acceptImageFiles);
setupDropZone($('#epubDrop'), $('#epubInput'), acceptEpub);
$('#chooseImages').addEventListener('click', () => $('#imageInput').click());
$('#chooseEpub').addEventListener('click', () => $('#epubInput').click());
$('#makeImagePdf').addEventListener('click', makeImagePdf);
$('#prepareEpub').addEventListener('click', prepareEpub);
$('#printEpub').addEventListener('click', () => {
  const frame = $('#epubPreview');
  frame.contentWindow?.focus();
  frame.contentWindow?.print();
});
$('#clearImages').addEventListener('click', () => {
  state.imageFiles = [];
  $('#imageInput').value = '';
  renderFiles($('#imageFiles'), []);
  $('#makeImagePdf').disabled = true;
  setStatus($('#imageStatus'), 'ファイルを選択してください。');
});
$('#clearEpub').addEventListener('click', () => {
  state.epubFile = null;
  $('#epubInput').value = '';
  renderFiles($('#epubFiles'), []);
  $('#prepareEpub').disabled = true;
  $('#previewWrap').hidden = true;
  state.epubObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  state.epubObjectUrls = [];
  setStatus($('#epubStatus'), 'EPUBを選択してください。');
});
$('#imageQuality').addEventListener('input', (event) => { $('#qualityValue').textContent = event.target.value; });
$('#fontScale').addEventListener('input', (event) => { $('#fontScaleValue').textContent = event.target.value; });
registerServiceWorker();
