const state = {
  imageFiles: [],
  epubFile: null,
  epubObjectUrls: [],
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function setStatus(element, message, type = '') {
  element.textContent = message;
  element.className = `status${type ? ` ${type}` : ''}`;
}

function setProgress(element, value, visible = true) {
  element.hidden = !visible;
  element.value = Math.max(0, Math.min(100, value));
}

function setupTabs() {
  $$('.tab').forEach((button) => {
    button.addEventListener('click', () => {
      $$('.tab').forEach((tab) => tab.setAttribute('aria-selected', String(tab === button)));
      const target = button.dataset.tab;
      $('#images-panel').hidden = target !== 'images';
      $('#epub-panel').hidden = target !== 'epub';
    });
  });
}

function setupDropZone(zone, input, handler) {
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('dragover');
    handler([...event.dataTransfer.files]);
  });
  input.addEventListener('change', () => handler([...input.files]));
}

function renderFiles(container, files) {
  container.innerHTML = '';
  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.innerHTML = `<span>${escapeHtml(file.name)}</span><span>${formatBytes(file.size)}</span>`;
    container.appendChild(row);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

function acceptImageFiles(files) {
  const accepted = files.filter((file) => IMAGE_EXTENSIONS.has(extensionOf(file.name)) || ['cbz', 'zip'].includes(extensionOf(file.name)));
  state.imageFiles = accepted.sort((a, b) => naturalCompare(a.name, b.name));
  renderFiles($('#imageFiles'), state.imageFiles);
  $('#makeImagePdf').disabled = state.imageFiles.length === 0;
  setStatus($('#imageStatus'), state.imageFiles.length ? `${state.imageFiles.length}件を読み込みました。` : '対応する画像またはCBZがありません。', state.imageFiles.length ? '' : 'error');
}

function acceptEpub(files) {
  const file = files.find((item) => extensionOf(item.name) === 'epub');
  state.epubFile = file || null;
  renderFiles($('#epubFiles'), file ? [file] : []);
  $('#prepareEpub').disabled = !file;
  $('#previewWrap').hidden = true;
  setStatus($('#epubStatus'), file ? `${file.name}を選択しました。` : 'EPUBファイルがありません。', file ? '' : 'error');
}
