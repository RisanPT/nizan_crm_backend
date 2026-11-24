import { istEnd, istStart } from '../utils/istDate.js';
import {
  DETAIL_SHEETS,
  caseRows,
  chatRows,
  istText,
  reEngagementRows,
  requestRows,
  reviewRows,
  summaryRows,
  teamRows,
  trialRows,
} from '../utils/crmReportRows.js';
import { buildCrmOverview } from './crmMetrics.js';
import { drawTable, MARGIN } from './financeReportFiles.js';

// THE CRM REPORT — the team's (or one member's) figures for a period, as an Excel workbook (the summary, the team, and every request,
// chat, review, case, trial and re-engagement call behind the figures) or a PDF (the summary, the team, what is overdue and the cases).
// Made from the same records as the dashboard (services/crmMetrics.js), so the two never disagree.

const KIND_LABEL = { booking: 'Booking request', conversation: 'Client chat', case: 'Case', trial: 'Trial' };
const dayText = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }) : '');

/// Everything both files say: { overview, rows: { summary, team, requests, chats, reviews, cases, trials, reEngagement, overdue } }.
export const crmReportData = async ({ period, member = null, now = new Date() }) => {
  const { overview, loaded, settings, memberId } = await buildCrmOverview({ period, member, now, withTrend: false });
  const win = { start: istStart(period.from), end: istEnd(period.to) };
  const d = loaded.data;
  const rows = {
    summary: summaryRows(overview.kpis),
    team: teamRows(overview.members),
    requests: requestRows(d.requests, win, { memberId, slaHours: settings.requestSlaHours }),
    chats: chatRows(d.episodes, win, {
      memberId,
      assigneeOf: loaded.assigneeOf,
      nameOf: loaded.conversationNameOf,
      slaMins: settings.chatResponseSlaMins,
      unansweredHours: settings.chatUnansweredHours,
      now,
    }),
    reviews: reviewRows(d.reviews, win, { memberId, ownerOf: loaded.ownerOf, ownerNameOf: loaded.ownerNameOf }),
    cases: caseRows(d.cases, win, { memberId, now }),
    trials: trialRows(d.trials, d.byPhone, win, { memberId, conversionDays: settings.trialConversionDays, now }),
    reEngagement: reEngagementRows(d.reCases, d.byPhone, win, { memberId, winDays: settings.reEngagementWinDays }),
    overdue: overview.breaches.map((b) => ({
      kind: KIND_LABEL[b.type] ?? b.type,
      client: b.title,
      detail: b.subtitle,
      owner: b.ownerName || 'Unassigned',
      since: istText(b.since),
      due: istText(b.dueAt),
    })),
  };
  return { overview, rows };
};

/// "CRM_Report_2026-11-01_to_2026-11-30[_Asha].xlsx"
export const crmReportFileName = (overview, period, ext) => {
  const who = overview.scope.kind === 'member' ? `_${String(overview.scope.name || 'member').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}` : '';
  return `CRM_Report_${period.tag}${who}.${ext}`;
};

const scopeText = (o) => (o.scope.kind === 'member' ? o.scope.name || 'One member' : 'The whole CRM team');
const previousText = (o) => (o.previous ? `${dayText(istStart(o.previous.from))} – ${dayText(istStart(o.previous.to))}` : 'nothing (the period has not started)');
const trackingText = (o) =>
  `The CRM records began on ${dayText(o.trackingSince)}.${o.partial ? ' This period starts earlier, so who owned and decided the work is known only from that day; such figures show "—" for earlier periods.' : ''}`;

const OPEN_WORK = [
  ['Booking requests waiting for a decision', 'requests'],
  ['Client chats waiting for an answer', 'chats'],
  ['Open cases', 'cases'],
  ['Trials still to report on', 'trials'],
  ['Of these, overdue', 'overdue'],
];

// ── Excel ───────────────────────────────────────────────────────────────────

const TEAM_COLUMNS = [
  ['Member', 'name', 22],
  ['Open work', 'open', 10, 'n'],
  ['Overdue', 'overdue', 9, 'n'],
  ['Requests decided', 'decided', 10],
  ['Time to decide', 'decideTime', 10],
  ['Decided in time', 'decideInTime', 10],
  ['Chat waits', 'chats', 10],
  ['Time to answer', 'replyTime', 10],
  ['Answered in time', 'replyInTime', 10],
  ['Cases resolved', 'casesResolved', 10],
  ['Cases on time', 'casesOnTime', 10],
  ['Re-engagement calls', 'calls', 11],
  ['Wins', 'wins', 7],
  ['NPS', 'nps', 7],
];
const OVERDUE_COLUMNS = [['Kind', 'kind', 16], ['Client', 'client', 24], ['Detail', 'detail', 40], ['Owner', 'owner', 16], ['Waiting since', 'since', 20], ['Due', 'due', 20]];

/// The workbook's bytes. The spreadsheet library is loaded only when an Excel file is asked for.
export const crmXlsx = async ({ overview, rows }) => {
  const { default: XLSX } = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const sheet = (aoa, widths) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = widths.map((w) => ({ wch: w }));
    return ws;
  };
  const table = (columns, list) => {
    const ws = sheet([columns.map(([h]) => h), ...list.map((r) => columns.map(([, k, , kind]) => (kind === 'n' ? (r[k] ?? '') : r[k] ?? '')))], columns.map(([, , w]) => w ?? 14));
    if (list.length) ws['!autofilter'] = { ref: ws['!ref'] };
    return ws;
  };

  const o = overview;
  const summary = [
    ['Team N Makeovers - CRM Report'],
    [`Period: ${o.range.label}`],
    [`For: ${scopeText(o)}`],
    [`Compared with: ${previousText(o)}`],
    [trackingText(o)],
    [],
    ['Measure', 'This period', 'Previous period', 'Change', 'Based on (records)'],
    ...rows.summary.map((r) => [r.label, r.value, r.prev, r.verdict ? `${r.change} (${r.verdict})` : r.change, r.n]),
    [],
    ['Open work now', 'Count'],
    ...OPEN_WORK.map(([label, key]) => [label, o.now[key]]),
    ...(o.unassigned ? [['Not assigned to anyone yet', o.unassigned.total]] : []),
  ];
  XLSX.utils.book_append_sheet(wb, sheet(summary, [46, 16, 16, 20, 18]), 'Summary');
  if (rows.team.length) XLSX.utils.book_append_sheet(wb, table(TEAM_COLUMNS, rows.team), 'Team');
  XLSX.utils.book_append_sheet(wb, table(OVERDUE_COLUMNS, rows.overdue), 'Overdue now');
  for (const [name, key, columns] of DETAIL_SHEETS) XLSX.utils.book_append_sheet(wb, table(columns, rows[key]), name);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

// ── PDF ─────────────────────────────────────────────────────────────────────

const INK = '#111827';
const GREY = '#6b7280';
const GOOD = '#047857';
const BAD = '#b91c1c';
const PDF_CASE_LIMIT = 200;

const heading = (doc, text) => {
  doc.moveDown(0.6);
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1f2937').text(text, MARGIN);
  doc.moveDown(0.3);
};
const line = (text, extra = {}) => [{ text: text == null ? '' : String(text), size: 8, ...extra }];

/// Writes the report to [doc] (landscape A4).
export const writeCrmPdf = (doc, { overview: o, rows }) => {
  doc.fontSize(18).fillColor(INK).font('Helvetica-Bold').text('Team N Makeovers - CRM Report', MARGIN, MARGIN);
  doc.fontSize(10).font('Helvetica').fillColor(GREY).text(`Period: ${o.range.label}   ·   For: ${scopeText(o)}   ·   Compared with: ${previousText(o)}`);
  doc.fontSize(8.5).text(trackingText(o));

  heading(doc, 'Summary');
  drawTable(doc, {
    columns: [
      { label: 'Measure', width: 300 },
      { label: 'This period', width: 110, align: 'right' },
      { label: 'Previous period', width: 110, align: 'right' },
      { label: 'Change', width: 140, align: 'right' },
      { label: 'Based on', width: 80, align: 'right' },
    ],
    rows: rows.summary,
    cells: (r) => [
      line(r.label),
      line(r.value, { bold: true }),
      line(r.prev, { color: GREY }),
      line(r.change, { color: r.verdict === 'better' ? GOOD : r.verdict === 'worse' ? BAD : GREY, bold: !!r.verdict }),
      line(r.n === '' ? '' : `${r.n}`, { color: GREY }),
    ],
  });
  doc
    .fontSize(9)
    .font('Helvetica')
    .fillColor(INK)
    .text(`Open work now: ${OPEN_WORK.map(([label, key]) => `${label.toLowerCase()} ${o.now[key]}`).join('  ·  ')}${o.unassigned ? `  ·  not assigned yet ${o.unassigned.total}` : ''}`, MARGIN);

  if (rows.team.length) {
    heading(doc, `The team  (${rows.team.length})`);
    drawTable(doc, {
      columns: [
        { label: 'Member', width: 120 },
        { label: 'Open', width: 40, align: 'right' },
        { label: 'Overdue', width: 48, align: 'right' },
        { label: 'Decided', width: 48, align: 'right' },
        { label: 'To decide', width: 54, align: 'right' },
        { label: 'In time', width: 50, align: 'right' },
        { label: 'Chats', width: 42, align: 'right' },
        { label: 'To answer', width: 56, align: 'right' },
        { label: 'In time', width: 50, align: 'right' },
        { label: 'Cases', width: 42, align: 'right' },
        { label: 'On time', width: 50, align: 'right' },
        { label: 'Calls', width: 40, align: 'right' },
        { label: 'Wins', width: 36, align: 'right' },
        { label: 'NPS', width: 36, align: 'right' },
      ],
      rows: rows.team,
      cells: (r) => [
        line(r.name, { bold: true }),
        line(r.open),
        line(r.overdue, { color: r.overdue ? BAD : INK, bold: !!r.overdue }),
        line(r.decided),
        line(r.decideTime),
        line(r.decideInTime),
        line(r.chats),
        line(r.replyTime),
        line(r.replyInTime),
        line(r.casesResolved),
        line(r.casesOnTime),
        line(r.calls),
        line(r.wins),
        line(r.nps),
      ],
    });
  }

  heading(doc, `Overdue now  (${o.breachCount})`);
  if (!rows.overdue.length) doc.fontSize(9).font('Helvetica').fillColor(GREY).text('Nothing is overdue.', MARGIN);
  else {
    drawTable(doc, {
      columns: [
        { label: 'Kind', width: 90 },
        { label: 'Client', width: 140 },
        { label: 'Detail', width: 230 },
        { label: 'Owner', width: 100 },
        { label: 'Due', width: 125 },
      ],
      rows: rows.overdue,
      cells: (r) => [line(r.kind), line(r.client, { bold: true }), line(r.detail, { color: GREY }), line(r.owner), line(r.due, { color: BAD })],
    });
    if (o.breachCount > rows.overdue.length) doc.fontSize(8).fillColor(GREY).text(`… and ${o.breachCount - rows.overdue.length} more (see the CRM dashboard).`, MARGIN);
  }

  heading(doc, `Cases  (${rows.cases.length})`);
  if (!rows.cases.length) doc.fontSize(9).font('Helvetica').fillColor(GREY).text('No cases in this period.', MARGIN);
  else {
    drawTable(doc, {
      columns: [
        { label: 'Case', width: 90 },
        { label: 'Client', width: 120 },
        { label: 'Owner', width: 80 },
        { label: 'Status', width: 64 },
        { label: 'Opened / due', width: 120 },
        { label: 'On time', width: 46 },
        { label: 'Outcome and note', width: 265 },
      ],
      rows: rows.cases.slice(0, PDF_CASE_LIMIT),
      cells: (r) => [
        [...line(r.caseNo, { bold: true }), ...line(r.kind, { size: 7, color: GREY })],
        line(r.client),
        line(r.owner),
        line(r.status),
        [...line(r.opened, { size: 7.5 }), ...line(`due ${r.due}`, { size: 7, color: GREY })],
        line(r.onTime, { color: r.onTime === 'Yes' ? GOOD : r.onTime ? BAD : INK, bold: !!r.onTime }),
        [...(r.outcome ? line(r.outcome, { bold: true }) : []), ...line(r.note, { size: 7.5, color: '#374151' })],
      ],
    });
    if (rows.cases.length > PDF_CASE_LIMIT) doc.fontSize(8).fillColor(GREY).text(`… and ${rows.cases.length - PDF_CASE_LIMIT} more in the Excel file.`, MARGIN);
  }
  doc.moveDown(0.8);
  doc.fontSize(8).font('Helvetica-Oblique').fillColor(GREY).text('Every request, chat, review, trial and re-engagement call behind these figures is in the Excel version of this report.', MARGIN);
};
