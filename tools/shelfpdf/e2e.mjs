import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const url = process.env.SHELFPDF_URL || 'https://suisan-neki.github.io/packet-poipoi/tools/shelfpdf/';
const imagePath = process.env.SHELFPDF_TEST_IMAGE || '/tmp/shelfpdf-test.png';
const epubPath = process.env.SHELFPDF_TEST_EPUB || '/tmp/shelfpdf-test.epub';
const pdfPath = '/tmp/shelfpdf-output.pdf';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const browserMessages = [];
page.on('console', (message) => browserMessages.push(`console.${message.type()}: ${message.text()}`));
page.on('pageerror', (error) => browserMessages.push(`pageerror: ${error.message}`));
page.on('requestfailed', (request) => browserMessages.push(`requestfailed: ${request.url()} ${request.failure()?.errorText || ''}`));

try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForSelector('h1:text("ShelfPDF Web")');
  const libraryState = await page.evaluate(() => ({
    jszip: Boolean(window.JSZip),
    jspdf: Boolean(window.jspdf?.jsPDF),
  }));
  console.log(`Libraries: ${JSON.stringify(libraryState)}`);

  await page.setInputFiles('#imageInput', imagePath);
  await page.waitForFunction(() => !document.querySelector('#makeImagePdf')?.disabled);
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 }).catch(() => null);
  await page.click('#makeImagePdf');
  const download = await downloadPromise;
  if (!download) {
    const status = await page.locator('#imageStatus').textContent();
    const statusClass = await page.locator('#imageStatus').getAttribute('class');
    throw new Error(`Image conversion produced no download. status=${JSON.stringify(status)} class=${JSON.stringify(statusClass)} libraries=${JSON.stringify(libraryState)} browser=${JSON.stringify(browserMessages)}`);
  }
  await download.saveAs(pdfPath);
  const pdf = await readFile(pdfPath);
  if (pdf.subarray(0, 5).toString() !== '%PDF-') {
    throw new Error('Downloaded image conversion result is not a PDF.');
  }

  await page.click('[data-tab="epub"]');
  await page.setInputFiles('#epubInput', epubPath);
  await page.waitForFunction(() => !document.querySelector('#prepareEpub')?.disabled);
  await page.click('#prepareEpub');
  await page.waitForSelector('#previewWrap:not([hidden])', { timeout: 60_000 }).catch(async () => {
    const status = await page.locator('#epubStatus').textContent();
    throw new Error(`EPUB preview did not appear. status=${JSON.stringify(status)} browser=${JSON.stringify(browserMessages)}`);
  });
  const previewFrame = page.frames().find((frame) => frame !== page.mainFrame());
  if (!previewFrame) throw new Error('EPUB preview frame was not created.');
  await previewFrame.waitForSelector('text=ShelfPDF EPUB test chapter', { timeout: 30_000 });

  console.log('ShelfPDF E2E verified: public page, image PDF download, and EPUB preview.');
} finally {
  if (browserMessages.length) console.log(browserMessages.join('\n'));
  await browser.close();
}
