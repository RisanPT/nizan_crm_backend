import PDFDocument from 'pdfkit';
import { Parser } from 'json2csv';
import { FINANCE_COLUMNS, csvRecord, summarizeFinanceRows } from '../utils/financeReportRows.js';

// The three files of the Finance Report — CSV, Excel and PDF — made from the same rows
// (utils/financeReportRows.js), so they always say the same thing: one line per entry, and on every
// line the work (client, booking number, day of the work) it belongs to.

/// "1,23,456.50" (Indian grouping). The PDF writes "Rs." — its built-in font has no rupee sign.
const money = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const rs = (n) => `Rs. ${money(n)}`;
const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');

// ── CSV ─────────────────────────────────────────────────────────────────────

export const financeCsv = ({ collections, expenses }) =>
  new Parser({ fields: FINANCE_COLUMNS.map(([h]) => h) }).parse([...collections, ...expenses].map(csvRecord));

// ── Excel ───────────────────────────────────────────────────────────────────

/// A day ('YYYY-MM-DD') as the date a spreadsheet shows on that day, whatever its own time zone.
const excelDate = (day) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))));

const WIDTHS = { Type: 11, Date: 13, Artist: 18, 'Client / Work': 24, 'Booking No.': 16, 'Work Date': 13, Category: 11, Amount: 12, 'Logged Amount': 14, Status: 10, 'Work Linked': 22, Notes: 60 };

/// A workbook: "Finance Report" (every entry on one sheet, real dates and numbers, filterable) and "Summary".
/// Returns the file's bytes. The spreadsheet library is loaded only when an Excel file is asked for, so the
/// server (and the CSV / PDF) never depend on it being installed.
export const financeXlsx = async ({ collections, expenses }, { label }) => {
  const { default: XLSX } = await import('xlsx');
  const rows = [...collections, ...expenses];
  const header = FINANCE_COLUMNS.map(([h]) => h);
  const cell = (row, key) => {
    switch (key) {
      case 'dayText':
        return row.day ? excelDate(row.day) : '';
      case 'workDayText':
        return row.workDays.length === 1 ? excelDate(row.workDays[0]) : row.workDayText;
      case 'loggedAmount':
        return row.loggedAmount ?? '';
      default:
        return row[key] ?? '';
    }
  };
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows.map((r) => FINANCE_COLUMNS.map(([, key]) => cell(r, key)))], { cellDates: true });
  const colOf = (h) => header.indexOf(h);
  for (let r = 1; r <= rows.length; r += 1) {
    for (const h of ['Date', 'Work Date']) {
      const c = ws[XLSX.utils.encode_cell({ r, c: colOf(h) })];
      if (c && c.t === 'd') c.z = 'dd mmm yyyy';
    }
    for (const h of ['Amount', 'Logged Amount']) {
      const c = ws[XLSX.utils.encode_cell({ r, c: colOf(h) })];
      if (c && c.t === 'n') c.z = '#,##0.00';
    }
  }
  ws['!cols'] = header.map((h) => ({ wch: WIDTHS[h] ?? 14 }));
  ws['!autofilter'] = { ref: ws['!ref'] };

  const s = summarizeFinanceRows({ collections, expenses });
  const summary = XLSX.utils.aoa_to_sheet([
    ['Team N Makeovers - Finance Report'],
    [`Period: ${label}`],
    [],
    ['', 'Collections', 'Expenses'],
    ['Verified', s.collections.verified, s.expenses.verified],
    ['Pending', s.collections.pending, s.expenses.pending],
    ['Rejected (not counted)', s.collections.rejected, s.expenses.rejected],
    ['Total (verified + pending)', s.collections.counted, s.expenses.counted],
    ['Entries', s.collections.count, s.expenses.count],
    [],
    ['Net balance (collections - expenses)', s.net],
  ]);
  summary['!cols'] = [{ wch: 36 }, { wch: 16 }, { wch: 16 }];
  for (const ref of ['B5', 'C5', 'B6', 'C6', 'B7', 'C7', 'B8', 'C8', 'B11']) if (summary[ref]) summary[ref].z = '#,##0.00';

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Finance Report');
  XLSX.utils.book_append_sheet(wb, summary, 'Summary');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

// ── PDF ─────────────────────────────────────────────────────────────────────

const STATUS_COLOR = { verified: '#047857', pending: '#b45309', rejected: '#b91c1c' };
const GREY = '#6b7280';
const INK = '#111827';
export const MARGIN = 28;

/// A cell is a list of lines: { text, size, color, bold, italic, strike }.
const font = (p) => (p.bold ? 'Helvetica-Bold' : p.italic ? 'Helvetica-Oblique' : 'Helvetica');
const cellHeight = (doc, lines, width) =>
  lines.reduce((h, p) => {
    doc.font(font(p)).fontSize(p.size ?? 8);
    return h + doc.heightOfString(p.text || ' ', { width }) + 1.5;
  }, 0);

/// One table: a header row, then a row per entry (as tall as its tallest cell), the header again after each
/// page break. Draws at explicit positions, so nothing depends on where the text cursor was.
export const drawTable = (doc, { columns, rows, cells }) => {
  const total = columns.reduce((a, c) => a + c.width, 0);
  const bottom = () => doc.page.height - MARGIN - 18;
  const header = (y) => {
    doc.rect(MARGIN, y, total, 18).fill('#f3f4f6');
    let x = MARGIN;
    for (const c of columns) {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(GREY).text(c.label.toUpperCase(), x + 4, y + 5, { width: c.width - 8, align: c.align ?? 'left', lineBreak: false });
      x += c.width;
    }
    return y + 18;
  };
  let y = header(doc.y);
  rows.forEach((row, i) => {
    const parts = cells(row, i);
    const h = Math.max(16, ...parts.map((lines, k) => cellHeight(doc, lines, columns[k].width - 8) + 6));
    if (y + h > bottom()) {
      doc.addPage();
      y = header(MARGIN);
    }
    if (i % 2 === 1) doc.rect(MARGIN, y, total, h).fill('#fafafa');
    let x = MARGIN;
    parts.forEach((lines, k) => {
      let cy = y + 3;
      for (const p of lines) {
        doc.font(font(p)).fontSize(p.size ?? 8).fillColor(p.color ?? INK);
        const text = p.text || ' ';
        doc.text(text, x + 4, cy, { width: columns[k].width - 8, align: columns[k].align ?? 'left', strike: !!p.strike });
        cy += doc.heightOfString(text, { width: columns[k].width - 8 }) + 1.5;
      }
      x += columns[k].width;
    });
    doc.moveTo(MARGIN, y + h).lineTo(MARGIN + total, y + h).lineWidth(0.4).strokeColor('#e5e7eb').stroke();
    y += h;
  });
  doc.y = y + 6;
};

const statusLine = (status) => ({ text: cap(status), size: 8, bold: true, color: STATUS_COLOR[status] ?? INK });
const amountLines = (row) => [
  { text: rs(row.amount), size: 8.5, bold: true, color: row.status === 'rejected' ? GREY : INK, strike: row.status === 'rejected' },
  ...(row.loggedAmount != null ? [{ text: `logged ${rs(row.loggedAmount)}`, size: 7, color: '#b45309' }] : []),
];
const notesLines = (row) => [{ text: row.notes || '', size: 7.5, color: '#374151' }];
const refLine = (row) => [row.bookingNo, row.workDayText ? `work ${row.workDayText}` : ''].filter(Boolean).join('  ·  ');

/// Writes the report to [doc]. Landscape A4, so the work, the amount and the notes can all sit on one line.
export const writeFinancePdf = (doc, { collections, expenses }, { label }) => {
  doc.fontSize(18).fillColor(INK).font('Helvetica-Bold').text('Team N Makeovers - Finance Report', MARGIN, MARGIN);
  doc.fontSize(10).font('Helvetica').fillColor(GREY).text(`Period: ${label}`);
  doc.moveDown(0.8);

  const s = summarizeFinanceRows({ collections, expenses });

  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1f2937').text(`Fund Collections  (${collections.length})`, MARGIN);
  doc.moveDown(0.4);
  if (collections.length === 0) {
    doc.fontSize(9).font('Helvetica').fillColor(GREY).text('No collections in this period.');
  } else {
    drawTable(doc, {
      columns: [
        { label: '#', width: 24 },
        { label: 'Date', width: 64 },
        { label: 'Artist', width: 92 },
        { label: 'Client / Booking', width: 190 },
        { label: 'Amount', width: 80, align: 'right' },
        { label: 'Status', width: 60 },
        { label: 'Notes', width: 275 },
      ],
      rows: collections,
      cells: (r, i) => [
        [{ text: String(i + 1), size: 7.5, color: GREY }],
        [{ text: r.dayText, size: 8 }],
        [{ text: r.artist, size: 8, bold: true }],
        [{ text: r.client, size: 8.5, bold: true }, ...(refLine(r) ? [{ text: refLine(r), size: 7, color: GREY }] : [])],
        amountLines(r),
        [statusLine(r.status)],
        notesLines(r),
      ],
    });
  }

  doc.moveDown(0.6);
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#991b1b').text(`Expense Claims  (${expenses.length})`, MARGIN);
  doc.moveDown(0.4);
  if (expenses.length === 0) {
    doc.fontSize(9).font('Helvetica').fillColor(GREY).text('No expenses in this period.');
  } else {
    drawTable(doc, {
      columns: [
        { label: '#', width: 24 },
        { label: 'Date', width: 64 },
        { label: 'Artist', width: 86 },
        { label: 'Work (client / booking)', width: 180 },
        { label: 'Category', width: 54 },
        { label: 'Amount', width: 82, align: 'right' },
        { label: 'Status', width: 58 },
        { label: 'Notes', width: 238 },
      ],
      rows: expenses,
      cells: (r, i) => [
        [{ text: String(i + 1), size: 7.5, color: GREY }],
        [{ text: r.dayText, size: 8 }],
        [{ text: r.artist, size: 8, bold: true }],
        [
          { text: r.client, size: 8.5, bold: true, color: r.client === 'Not tied to a work' ? '#b45309' : INK },
          ...(refLine(r) ? [{ text: refLine(r), size: 7, color: GREY }] : []),
          ...(r.linked && r.client !== 'Not tied to a work' ? [{ text: r.linked, size: 7, italic: true, color: GREY }] : []),
        ],
        [{ text: cap(r.category), size: 8 }],
        amountLines(r),
        [statusLine(r.status)],
        notesLines(r),
      ],
    });
  }

  // Totals: a rejected entry is listed above but never counted.
  if (doc.y > doc.page.height - MARGIN - 150) doc.addPage();
  doc.moveDown(0.6);
  doc.fontSize(12).font('Helvetica-Bold').fillColor(INK).text('Summary', MARGIN);
  doc.moveDown(0.4);
  drawTable(doc, {
    columns: [
      { label: '', width: 200 },
      { label: 'Collections', width: 110, align: 'right' },
      { label: 'Expenses', width: 110, align: 'right' },
    ],
    rows: [
      ['Verified', s.collections.verified, s.expenses.verified],
      ['Pending', s.collections.pending, s.expenses.pending],
      ['Rejected (not counted)', s.collections.rejected, s.expenses.rejected],
      ['Total (verified + pending)', s.collections.counted, s.expenses.counted],
    ],
    cells: ([name, c, e], i) => {
      const bold = i === 3;
      return [[{ text: name, size: 8.5, bold }], [{ text: rs(c), size: 8.5, bold }], [{ text: rs(e), size: 8.5, bold }]];
    },
  });
  doc.fontSize(11).font('Helvetica-Bold').fillColor(s.net < 0 ? '#b91c1c' : '#047857').text(`Net balance (collections - expenses): ${s.net < 0 ? '-' : ''}${rs(Math.abs(s.net))}`, MARGIN);

  // page numbers
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // text below the bottom margin would otherwise open a new page
    doc.fontSize(7.5).font('Helvetica').fillColor(GREY).text(`Page ${i + 1} of ${range.count}`, MARGIN, doc.page.height - 22, { width: doc.page.width - 2 * MARGIN, align: 'right', lineBreak: false });
  }
};

/// The PDF document, ready to pipe.
export const newFinancePdf = () => new PDFDocument({ margin: MARGIN, size: 'A4', layout: 'landscape', bufferPages: true });
