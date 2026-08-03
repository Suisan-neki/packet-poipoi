import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const url = process.env.SHELFPDF_URL || 'https://suisan-neki.github.io/packet-poipoi/tools/shelfpdf/';
const imagePath = process.env.SHELFPDF_TEST_IMAGE || '/tmp/shelfpdf-test.png';
const epubPath = process.env.SHELFPDF_TEST_EPUB || '/tmp/shelfpdf-test.epub';
const pdfPath = '/tmp/shelfpdf-output.pdf';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();

try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForSelector('h1:text("ShelfPDF Web")');

  await page.setInputFiles('#imageInput', imagePath);
  await page.waitForFunction(() => !document.querySelector('#makeImagePdf')?.disabled);
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.click('#makeImagePdf');
  const download = await downloadPromise;
  await download.saveAs(pdfPath);
  const pdf = await readFile(pdfPath);
  if (pdf.subarray(0, 5).toString() !== '%PDF-') {
    throw new Error('Downloaded image conversion result is not a PDF.');
  }

  await page.click('[data-tab="epub"]');
  await page.setInputFiles('#epubInput', epubPath);
  await page.waitForFunction(() => !document.querySelector('#prepareEpub')?.disabled);
  await page.click('#prepareEpub');
  await page.waitForSelector('#previewWrap:not([hidden])', { timeout: 60_000 });
  const previewFrame = page.frames().find((frame) => frame !== page.mainFrame());
  if (!previewFrame) throw new Error('EPUB preview frame was not created.');
  await previewFrame.waitForSelector('text=ShelfPDF EPUB test chapter', { timeout: 30_000 });

  console.log('ShelfPDF E2E verified: public page, image PDF download, and EPUB preview.');
} finally {
  await browser.close();
}
