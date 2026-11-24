import { drawTable, MARGIN } from './financeReportFiles.js';

// THE CRM WEEKLY REPORT as files — a PDF to hand round (the eight items in the team's own order) and an Excel workbook (the same, plus
// every list behind the counts). Made from what the screen shows (services/crmWeekly.js weeklyReportView), so they always agree.

const INK = '#111827';
const GREY = '#6b7280';
const RED = '#b91c1c';
const GREEN = '#047857';
const dash = (v) => (v == null ? '—' : String(v));
const ofTotal = (n, total, pct) => (n == null ? '—' : `${n} of ${total}${pct == null ? '' : ` (${pct}%)`}`);
const day = (d) => {
  if (!d) return '';
  const [y, m, dd] = String(d).slice(0, 10).split('-').map(Number);
  return `${dd} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
};
const statusText = (v) =>
  v.status === 'submitted' ? `Handed in by ${v.submittedByName || 'the CRM Head'} on ${day(new Date(v.submittedAt).toISOString())}` : v.status === 'draft' ? 'Draft — not handed in yet' : 'Not started';

/// "CRM_Weekly_Report_2026-11-09_to_2026-11-15.pdf"
export const crmWeeklyFileName = (v, ext) => `CRM_Weekly_Report_${v.week.from}_to_${v.week.to}.${ext}`;

/// "12 · typed by hand (records: 9)" — a figure the CRM Head typed in place of the records' one.
const typedNote = (v, keys) => {
  const typed = keys.filter((k) => v.typed?.overrides?.[k] != null);
  if (!typed.length) return '';
  const rec = keys.map((k) => dash(v.records?.[k])).join(' / ');
  return ` · typed by hand (records: ${rec})`;
};

/// The summary lines (item, what, figure) — the same in both files. A figure typed by hand says so, with the records' figure.
export const weeklySummaryRows = (v) => {
  const f = v.figures;
  const t = v.typed;
  const vn = f.verification.nextWeek;
  const wl = f.workload.nextWeek;
  const m = (keys) => typedNote(v, keys);
  const note = (section) => (t.sectionNotes?.[section] ? [['', 'Note', t.sectionNotes[section]]] : []);
  const conditions = f.medical.conditionsCount ?? f.medical.withConditions?.length ?? null;
  const emergencies = f.medical.emergenciesCount ?? f.medical.emergencies?.length ?? null;
  const handLines = f.outsource.lines.filter((l) => l.byHand).length;
  return [
    ['1. Trials', 'Trials held this week', `${f.trials.held} (week before ${f.trials.prevHeld})${m(['trialsHeld'])}`],
    ['', 'Completed · cancelled · postponed', `${f.trials.completed} · ${f.trials.cancelled} · ${f.trials.postponed}${m(['trialsCompleted'])}`],
    ['', 'Became bookings', `${f.trials.converted}${f.trials.maturing ? ` (${f.trials.maturing} still deciding)` : ''}${m(['trialsConverted'])}`],
    ...note('trials'),
    ['2. Photos & reviews', 'Makeover works done', `${f.photosReviews.worksDone}${m(['worksDone'])}`],
    ['', 'Photos collected', `${ofTotal(f.photosReviews.photos, f.photosReviews.worksDone, f.photosReviews.photosPct)}${m(['photos'])}`],
    ['', 'Reviews collected (clients)', `${ofTotal(f.photosReviews.reviews, f.photosReviews.clientsDone, f.photosReviews.reviewsPct)}${m(['reviews', 'clientsDone'])}`],
    ...note('photos'),
    ['3. Customer support', 'Clients handled this week', `${f.support.clients} (week before ${f.support.prevClients})${m(['supportClients'])}`],
    ['', `Clients handled this month (${day(f.support.monthFrom)} – ${day(f.support.monthTo)})`, `${f.support.monthToDate} of the ${f.support.monthTarget} target${m(['monthToDate'])}`],
    ...note('support'),
    ['4. Starting messages', 'Nizan · Team N', `${dash(t.startingMessagesNizan)} · ${dash(t.startingMessagesTeamN)}${t.startingMessagesNizan != null && t.startingMessagesTeamN != null ? ` (total ${t.startingMessagesNizan + t.startingMessagesTeamN})` : ''}`],
    ['5. Verification', `Coming week's works verified (${day(vn.from)} – ${day(vn.to)})`, `${ofTotal(vn.verified, vn.works, vn.pct)}${m(['verified', 'verifyWorks'])}`],
    ['', "This week's works verified", ofTotal(f.verification.thisWeek.verified, f.verification.thisWeek.works, f.verification.thisWeek.pct)],
    ...note('verification'),
    ['6. Medical', 'Clients with a medical condition (this + coming week)', `${dash(conditions)}${m(['medicalConditions'])}`],
    ['', 'Medical emergencies this week', `${dash(emergencies)}${m(['medicalEmergencies'])}`],
    ...note('medical'),
    ['7. Workload & manpower', `Coming week: bookings against slots`, `${wl.booked} of ${wl.capacity}${wl.overDays ? ` — ${wl.overDays} day(s) over` : ''}${m(['workloadBooked', 'workloadCapacity'])}`],
    ['', 'This week: bookings', `${f.workload.thisWeek.booked} of ${f.workload.thisWeek.capacity}`],
    ['', 'Plan for extra manpower', t.manpowerPlan || '—'],
    ['', 'Is there enough work?', t.enoughWork ? `${t.enoughWork === 'yes' ? 'Yes' : 'No'}${t.enoughWorkNote ? ` — ${t.enoughWorkNote}` : ''}` : '—'],
    ...note('workload'),
    ['8. Outsource', 'Works by outside artists', `${f.outsource.total}${handLines ? ` (${handLines} typed by hand)` : ''}`],
    ...note('outsource'),
  ];
};

// ── Excel ───────────────────────────────────────────────────────────────────

export const crmWeeklyXlsx = async (v) => {
  const { default: XLSX } = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const f = v.figures;
  const add = (name, rows, widths) => {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = widths.map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  add(
    'Summary',
    [
      ['Team N Makeovers - CRM Weekly Report'],
      [`Week: ${v.week.label}`],
      [statusText(v)],
      [],
      ['Item', 'What', 'Figure'],
      ...weeklySummaryRows(v),
      [],
      ['Starting messages note', v.typed.startingMessagesNote || ''],
      ['Notes', v.typed.notes || ''],
    ],
    [24, 52, 40]
  );
  const ref = (r) => [day(r.day), r.client, r.bookingNumber, r.phone];
  add('Photos missing', [['Day', 'Client', 'Booking No.', 'Phone'], ...f.photosReviews.missingPhotos.map(ref)], [14, 26, 16, 14]);
  add('Reviews missing', [['Day', 'Client', 'Booking No.', 'Phone'], ...f.photosReviews.missingReviews.map(ref)], [14, 26, 16, 14]);
  add('Support by member', [['Member', 'Clients handled'], ...f.support.byMember.map((m) => [m.name, m.clients])], [24, 16]);
  add('Not verified', [['Day', 'Client', 'Booking No.', 'Phone'], ...f.verification.nextWeek.unverified.map(ref)], [14, 26, 16, 14]);
  add(
    'Medical',
    [
      ['Client', 'Booking No.', 'Days', 'Conditions', 'Note'],
      ...(f.medical.withConditions ?? []).map((m) => [m.client, m.bookingNumber, m.days.map(day).join(', '), m.conditions.join(', '), m.note]),
      [],
      ['Emergencies', 'Booking No.', 'Day', 'What happened', 'What was done', 'Logged by'],
      ...(f.medical.emergencies ?? []).map((e) => [e.client, e.bookingNumber, day(e.day), e.what, e.action, e.byName]),
    ],
    [24, 16, 22, 30, 50, 16]
  );
  add('Workload next week', [['Day', 'Bookings', 'Slots', 'Spare', 'Over?'], ...f.workload.nextWeek.days.map((d) => [day(d.day), d.booked, d.capacity, d.spare, d.blocked ? 'Blocked' : d.over ? 'OVER' : ''])], [14, 10, 8, 8, 10]);
  add(
    'Outsource',
    [
      ['Bride', 'Outsource artist', 'Work', 'Phone', 'Day', 'Booking No.', 'Typed by hand'],
      ...f.outsource.lines.map((l) => [l.bride, l.outsource, l.work, l.phone, day(l.day), l.bookingNumber, l.byHand ? 'Yes' : '']),
      [],
      ['Artist', 'Phone', 'Works'],
      ...f.outsource.byPerson.map((p) => [p.name, p.phone, p.works]),
    ],
    [24, 22, 30, 14, 14, 16, 14]
  );
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

// ── PDF ─────────────────────────────────────────────────────────────────────

const heading = (doc, text) => {
  if (doc.y > doc.page.height - 120) doc.addPage();
  doc.moveDown(0.6);
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1f2937').text(text, MARGIN);
  doc.moveDown(0.3);
};
const line = (text, extra = {}) => [{ text: text == null ? '' : String(text), size: 8.5, ...extra }];
const none = (doc, text) => doc.fontSize(9).font('Helvetica').fillColor(GREY).text(text, MARGIN);
const WORK_COLUMNS = [
  { label: 'Day', width: 90 },
  { label: 'Client', width: 200 },
  { label: 'Booking No.', width: 120 },
  { label: 'Phone', width: 120 },
];
const workTable = (doc, rows, empty) => {
  if (!rows.length) return none(doc, empty);
  drawTable(doc, { columns: WORK_COLUMNS, rows, cells: (r) => [line(day(r.day)), line(r.client, { bold: true }), line(r.bookingNumber), line(r.phone)] });
};

export const writeCrmWeeklyPdf = (doc, v) => {
  const f = v.figures;
  doc.fontSize(18).fillColor(INK).font('Helvetica-Bold').text('Team N Makeovers - CRM Weekly Report', MARGIN, MARGIN);
  doc.fontSize(10).font('Helvetica').fillColor(GREY).text(`Week: ${v.week.label}   ·   ${statusText(v)}`);

  heading(doc, 'Summary');
  drawTable(doc, {
    columns: [
      { label: 'Item', width: 150 },
      { label: 'What', width: 330 },
      { label: 'Figure', width: 300 },
    ],
    rows: weeklySummaryRows(v),
    cells: (r) => [line(r[0], { bold: true }), line(r[1]), line(r[2], { bold: true })],
  });
  if (v.typed.startingMessagesNote) doc.fontSize(9).fillColor(INK).text(`Starting messages: ${v.typed.startingMessagesNote}`, MARGIN);

  if (Object.keys(v.typed?.overrides ?? {}).length || f.outsource.lines.some((l) => l.byHand)) {
    doc.moveDown(0.3);
    doc.fontSize(8.5).font('Helvetica-Oblique').fillColor(GREY).text('Figures marked "typed by hand" were entered by the CRM Head in place of the records\' figure (shown beside them).', MARGIN);
  }

  heading(doc, `2. Works without photos (${f.photosReviews.missingPhotos.length})`);
  workTable(doc, f.photosReviews.missingPhotos.slice(0, 60), f.photosReviews.photos == null ? 'Photos were not ticked yet in this week.' : 'Every work this week has its photos.');

  heading(doc, `3. Clients handled, by member`);
  if (!f.support.byMember.length) none(doc, 'Nobody handled a client this week.');
  else drawTable(doc, { columns: [{ label: 'Member', width: 260 }, { label: 'Clients', width: 100, align: 'right' }], rows: f.support.byMember, cells: (m) => [line(m.name, { bold: true }), line(m.clients)] });

  heading(doc, `5. Coming week's works not verified yet (${f.verification.nextWeek.unverified.length})`);
  workTable(doc, f.verification.nextWeek.unverified, f.verification.nextWeek.verified == null ? 'Verification was not ticked yet.' : 'Every work of the coming week is verified.');

  heading(doc, '6. Medical conditions and emergencies');
  if (f.medical.withConditions == null) none(doc, 'Medical notes were not kept yet for these weeks.');
  else {
    if (!f.medical.withConditions.length) none(doc, 'No client with a medical condition.');
    else {
      drawTable(doc, {
        columns: [{ label: 'Client', width: 170 }, { label: 'Days', width: 150 }, { label: 'Conditions', width: 150 }, { label: 'Note', width: 310 }],
        rows: f.medical.withConditions,
        cells: (m) => [line(m.client, { bold: true }), line(m.days.map(day).join(', ')), line(m.conditions.join(', '), { color: RED, bold: true }), line(m.note)],
      });
    }
    if (f.medical.emergencies.length) {
      doc.moveDown(0.3);
      drawTable(doc, {
        columns: [{ label: 'Emergency', width: 170 }, { label: 'Day', width: 90 }, { label: 'What happened', width: 260 }, { label: 'What was done', width: 260 }],
        rows: f.medical.emergencies,
        cells: (e) => [line(e.client, { bold: true }), line(day(e.day)), line(e.what, { color: RED }), line(e.action)],
      });
    } else doc.fontSize(9).font('Helvetica').fillColor(GREEN).text('No medical emergency this week.', MARGIN);
  }

  heading(doc, `7. Coming week, day by day`);
  drawTable(doc, {
    columns: [{ label: 'Day', width: 160 }, { label: 'Bookings', width: 90, align: 'right' }, { label: 'Slots', width: 90, align: 'right' }, { label: 'Spare', width: 90, align: 'right' }, { label: '', width: 120 }],
    rows: f.workload.nextWeek.days,
    cells: (d) => [line(day(d.day)), line(d.booked, { bold: true }), line(d.capacity), line(d.spare), line(d.blocked ? 'Blocked' : d.over ? 'Over capacity' : '', { color: RED, bold: true })],
  });

  heading(doc, `8. Outsource works (${f.outsource.total})`);
  if (!f.outsource.lines.length) none(doc, 'No outside artist worked this week.');
  else {
    drawTable(doc, {
      columns: [{ label: 'Bride', width: 170 }, { label: 'Outsource artist', width: 150 }, { label: 'Work', width: 220 }, { label: 'Phone', width: 110 }, { label: 'Day', width: 130 }],
      rows: f.outsource.lines,
      cells: (l) => [line(l.bride, { bold: true }), line(l.outsource), line(l.byHand ? [l.work, '(typed by hand)'].filter(Boolean).join(' ') : l.work), line(l.phone), line(day(l.day))],
    });
  }
  if (v.typed.notes) {
    heading(doc, 'Notes');
    doc.fontSize(9.5).font('Helvetica').fillColor(INK).text(v.typed.notes, MARGIN);
  }
};
