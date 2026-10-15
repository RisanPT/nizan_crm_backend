// Renders the CRM's own print HTML (e.g. the "Print Full GST Invoice" page)
// to PDF with headless Chrome — the same engine as the browser's "Save as
// PDF", so the file matches the CRM print exactly. Used to send that exact
// invoice on WhatsApp (controllers/whatsappController.js).
//
// Locked down: the page is untrusted input, so JavaScript is off and every
// network request is refused (inline data: images only) — it can't reach the
// server's network or the internet.

import puppeteer from 'puppeteer';

let browserPromise = null;
let idleTimer = null;
const IDLE_CLOSE_MS = 5 * 60 * 1000; // free Chrome's memory when unused

const getBrowser = () => {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        headless: true,
        // --no-sandbox: needed when the server runs as root / in a container.
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      })
      .then((browser) => {
        browser.on('disconnected', () => {
          browserPromise = null;
        });
        return browser;
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
};

const scheduleIdleClose = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const p = browserPromise;
    browserPromise = null;
    if (p) (await p.catch(() => null))?.close().catch(() => {});
  }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
};

/**
 * @param {string} html  complete HTML document
 * @returns {Promise<Buffer>} PDF bytes
 */
export const htmlToPdf = async (html) => {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.url().startsWith('data:')) req.continue();
      else req.abort();
    });
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    // Same output as Chrome's print dialog with its defaults: background
    // graphics off (elements marked print-color-adjust: exact still keep
    // their colour), default margins, no header / footer.
    const pdf = await page.pdf({
      format: process.env.INVOICE_PDF_FORMAT || 'A4',
      printBackground: false,
      displayHeaderFooter: false,
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
      timeout: 30000,
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
    scheduleIdleClose();
  }
};
