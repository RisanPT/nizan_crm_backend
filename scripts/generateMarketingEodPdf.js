import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';

const generatePdf = async () => {
  console.log('[PDF Generator] Starting PDF generation...');

  // 1. Load Team N Logo as base64
  const logoPath = path.resolve('d:/Nizan/Nizan_crm/assets/images/teamn_logo.png');
  let logoBase64 = '';
  if (fs.existsSync(logoPath)) {
    const logoBuffer = fs.readFileSync(logoPath);
    logoBase64 = `data:image/png;base64,${logoBuffer.toString('base64')}`;
  }

  // 2. Build complete HTML content
  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Marketing EOD Log & Team Dashboard — User Guide (v1.1)</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #2D3748;
      line-height: 1.55;
      font-size: 11pt;
      background: #FFFFFF;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    /* Colors */
    :root {
      --brand: #601A29;
      --brand-light: #F7EFF1;
      --brand-dark: #4A121E;
      --accent: #B8860B;
      --text-main: #1A202C;
      --text-muted: #718096;
      --border-color: #E2E8F0;
      --bg-card: #F8FAFC;
    }

    /* Headings */
    h1, h2, h3, h4 {
      color: var(--brand);
      font-weight: 700;
      page-break-after: avoid;
    }

    h1 {
      font-size: 20pt;
      line-height: 1.25;
      margin-bottom: 6px;
    }

    h2 {
      font-size: 14pt;
      border-bottom: 1.8pt solid var(--brand);
      padding-bottom: 4px;
      margin-top: 22px;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
    }

    h3 {
      font-size: 11.5pt;
      margin-top: 14px;
      margin-bottom: 6px;
      color: #2D3748;
      font-weight: 700;
    }

    p {
      margin-bottom: 9px;
      color: #334155;
      font-size: 10pt;
    }

    ul, ol {
      margin-left: 20px;
      margin-bottom: 10px;
      font-size: 10pt;
      color: #334155;
    }

    li {
      margin-bottom: 4px;
    }

    strong {
      color: #0F172A;
    }

    /* Page Breaks */
    .page-break {
      page-break-after: always;
    }

    .no-break {
      page-break-inside: avoid;
    }

    /* Cover / Header Section */
    .header-box {
      border: 1.5pt solid var(--brand);
      border-radius: 8px;
      padding: 18px 22px;
      background: linear-gradient(135deg, #FFFFFF 0%, var(--brand-light) 100%);
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 18px;
    }

    .logo-img {
      width: 64px;
      height: 64px;
      object-fit: contain;
    }

    .header-text {
      flex: 1;
    }

    .badge {
      display: inline-block;
      background: var(--brand);
      color: #FFFFFF;
      font-size: 8pt;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }

    .meta-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 10px 14px;
      margin-bottom: 20px;
      font-size: 9pt;
    }

    .meta-item strong {
      display: block;
      color: var(--text-muted);
      font-size: 7.5pt;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .meta-item span {
      font-weight: 600;
      color: #0F172A;
    }

    /* Callout Alert Boxes */
    .alert {
      border-radius: 6px;
      padding: 10px 14px;
      margin: 12px 0;
      font-size: 9.5pt;
      border-left: 3.5pt solid;
      page-break-inside: avoid;
    }

    .alert-info {
      background: #EFF6FF;
      border-color: #2563EB;
      color: #1E40AF;
    }

    .alert-warning {
      background: #FFFBEB;
      border-color: #D97706;
      color: #92400E;
    }

    .alert-success {
      background: #F0FDF4;
      border-color: #16A34A;
      color: #166534;
    }

    .alert-brand {
      background: var(--brand-light);
      border-color: var(--brand);
      color: var(--brand-dark);
    }

    /* Tables */
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 12px 0;
      font-size: 9pt;
      page-break-inside: avoid;
    }

    th, td {
      border: 1px solid var(--border-color);
      padding: 6px 9px;
      text-align: left;
    }

    th {
      background: var(--brand);
      color: #FFFFFF;
      font-weight: 700;
      font-size: 8.5pt;
      letter-spacing: 0.3px;
    }

    tr:nth-child(even) td {
      background: #F8FAFC;
    }

    td.center, th.center {
      text-align: center;
    }

    td.right, th.right {
      text-align: right;
    }

    /* Status Pills */
    .status-pill {
      display: inline-block;
      font-size: 7.5pt;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 4px;
      text-transform: uppercase;
    }

    .status-green {
      background: #DCFCE7;
      color: #15803D;
    }

    .status-amber {
      background: #FEF3C7;
      color: #B45309;
    }

    .status-red {
      background: #FEE2E2;
      color: #B91C1C;
    }

    /* Workflow Cards */
    .flow-container {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin: 14px 0;
      page-break-inside: avoid;
    }

    .flow-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-top: 3pt solid var(--brand);
      border-radius: 6px;
      padding: 10px 12px;
    }

    .flow-card .step-num {
      display: inline-block;
      width: 22px;
      height: 22px;
      background: var(--brand);
      color: white;
      border-radius: 50%;
      text-align: center;
      line-height: 22px;
      font-size: 9pt;
      font-weight: bold;
      margin-bottom: 6px;
    }

    .flow-card h4 {
      font-size: 10pt;
      color: #1E293B;
      margin-bottom: 4px;
    }

    .flow-card p {
      font-size: 8.5pt;
      color: var(--text-muted);
      margin: 0;
    }

    /* KPI Preview Cards */
    .kpi-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
      margin: 10px 0;
      page-break-inside: avoid;
    }

    .kpi-box {
      border: 1px solid var(--border-color);
      background: var(--brand-light);
      border-radius: 6px;
      padding: 8px 10px;
      text-align: center;
    }

    .kpi-box .kpi-label {
      font-size: 7.5pt;
      color: var(--brand-dark);
      font-weight: 600;
      text-transform: uppercase;
    }

    .kpi-box .kpi-val {
      font-size: 13pt;
      color: var(--brand);
      font-weight: 800;
      margin-top: 2px;
    }
  </style>
</head>
<body>

  <!-- ==================== PAGE 1: COVER & OVERVIEW ==================== -->
  <div class="header-box">
    ${logoBase64 ? `<img src="${logoBase64}" class="logo-img" alt="Team N Logo" />` : ''}
    <div class="header-text">
      <span class="badge">Official Standard Operating Procedure</span>
      <h1>Marketing EOD Log & Team Dashboard</h1>
      <p style="color: var(--brand-dark); font-weight: 600; margin: 0; font-size: 11pt;">
        Daily Activity Tracking · Role-Specific Profiles · Team Summary · Management Reporting
      </p>
    </div>
  </div>

  <div class="meta-grid">
    <div class="meta-item">
      <strong>Specification</strong>
      <span>SRS v1.1 Final</span>
    </div>
    <div class="meta-item">
      <strong>Placement</strong>
      <span>Marketing ERP (/marketing/eod)</span>
    </div>
    <div class="meta-item">
      <strong>Effective Date</strong>
      <span>October 2026 Onward</span>
    </div>
    <div class="meta-item">
      <strong>Target Users</strong>
      <span>Marketing Team & Leadership</span>
    </div>
  </div>

  <h2>1. Executive Summary & Why We Upgraded</h2>
  <p>
    The Marketing department reports its daily operations through an End-of-Day (EOD) system to track activity volume, hours worked, and monthly KPI targets. Previously, this process was managed in a shared Google Sheet (<em>"Team N Marketing EOD Tracker v2"</em>).
  </p>
  <p>
    Starting October 2026, this entire system has been migrated directly into <strong>Team N ERP</strong> to eliminate common spreadsheet issues, improve data security, and offer a streamlined experience:
  </p>

  <div class="flow-container">
    <div class="flow-card">
      <span class="step-num">1</span>
      <h4>Role-Aware Views</h4>
      <p>Instead of scrolling past 17+ columns, team members only see the exact activities assigned to their specific job role.</p>
    </div>
    <div class="flow-card">
      <span class="step-num">2</span>
      <h4>Formula Integrity</h4>
      <p>Total daily output, working days, achievement %, and best days are computed live by the server—no broken formulas or accidental cell overwrites.</p>
    </div>
    <div class="flow-card">
      <span class="step-num">3</span>
      <h4>Auditable & Secure</h4>
      <p>Strict access controls prevent members from altering other people's entries. Late edits and manager overrides are automatically logged.</p>
    </div>
  </div>

  <h2>2. Module Access & The 8 Functional Tabs</h2>
  <p>
    To open the module, log into <strong>Team N ERP</strong>, expand the <strong>Marketing</strong> section in the left sidebar, and click <strong>EOD & Team Log</strong> (route: <code>/marketing/eod</code>).
  </p>

  <table>
    <thead>
      <tr>
        <th style="width: 22%;">Tab Name</th>
        <th style="width: 28%;">Primary Users</th>
        <th>Purpose & Core Actions</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><strong>1. EOD Entry</strong></td>
        <td>All Marketing Team Members</td>
        <td>Log daily counts, mandatory hours worked, and notes with live output calculation.</td>
      </tr>
      <tr>
        <td><strong>2. My Dashboard</strong></td>
        <td>All Marketing Team Members</td>
        <td>Individual monthly progress tiles, Target vs. Achieved table, 31-day grid, and PDF print.</td>
      </tr>
      <tr>
        <td><strong>3. Team Dashboards</strong></td>
        <td>Marketing Manager & Management</td>
        <td>Inspect individual dashboards of any team member using the top switcher dropdown.</td>
      </tr>
      <tr>
        <td><strong>4. Team Summary</strong></td>
        <td>Marketing Manager & Management</td>
        <td>Whole-department matrix comparing members side-by-side with Team Totals (A4 Landscape PDF).</td>
      </tr>
      <tr>
        <td><strong>5. Missed EODs</strong></td>
        <td>Marketing Manager</td>
        <td>Live tracker of past working days with missing hours; trigger reminder notifications.</td>
      </tr>
      <tr>
        <td><strong>6. Weekly Stats</strong></td>
        <td>Social Media Owner (Intern)</td>
        <td>Log weekly Reach, Engagement, and Posts for both Instagram pages across W1–W5.</td>
      </tr>
      <tr>
        <td><strong>7. Setup</strong></td>
        <td>Marketing Manager & Admins</td>
        <td>Manage 21 metrics, 5 groups, roles, activity assignments, and monthly target grid.</td>
      </tr>
      <tr>
        <td><strong>8. Month Close</strong></td>
        <td>Marketing Manager</td>
        <td>Record monthly remarks, perform digital sign-offs, and lock/reopen months.</td>
      </tr>
    </tbody>
  </table>

  <div class="page-break"></div>

  <!-- ==================== PAGE 2: TEAM MEMBER GUIDE ==================== -->
  <h2>3. For Team Members: Daily EOD Filing SOP</h2>
  <p>
    Every active marketing team member must file **one EOD entry per working day** (Monday to Saturday) before leaving the office or by <strong>7:00 PM IST</strong>.
  </p>

  <div class="alert alert-brand">
    <strong>Mobile-First Interface:</strong> EOD filing is fully responsive. You can comfortably submit your entry from your mobile phone or workstation using the large stepper controls.
  </div>

  <h3>Step-by-Step Filing Workflow:</h3>
  <ol>
    <li><strong>Select Date:</strong> The screen automatically opens to <strong>Today</strong>. If filing for yesterday, tap the <code>←</code> arrow button. (Edits are permitted up to 2 days back).</li>
    <li><strong>Enter Activity Counts:</strong> Scroll through your assigned activities. Tap <code>+</code> or <code>-</code> (or tap the box to type a number). Leave activities you didn't do as <code>0</code> or blank.</li>
    <li><strong>Observe Live Total Output:</strong> As you adjust numbers, the top-right badge calculates your daily output in real-time for all qualifying output activities.</li>
    <li><strong>Enter Hours Worked (Mandatory):</strong> Type your daily hours or tap a quick chip (<code>4h</code>, <code>6h</code>, <code>8h</code>).
      <div class="alert alert-warning" style="margin-top: 6px;">
        <strong>Validation Rule:</strong> You cannot submit a reported day without entering hours worked. Entering counts with <code>0</code> hours will flag a <strong>WARNING</strong>.
      </div>
    </li>
    <li><strong>Add Optional Notes:</strong> Note any special tasks, shoot locations, trial shoots, or reasons for leave/short hours.</li>
    <li><strong>Save & Submit:</strong> Tap <strong>Save & Submit EOD Log</strong>. A green notification will confirm your submission.</li>
  </ol>

  <h2>4. Understanding Your Monthly Dashboard (Tab 2)</h2>
  <p>
    Clicking <strong>My Dashboard</strong> opens your complete monthly review. All figures reconcile live from your daily submissions.
  </p>

  <div class="kpi-row">
    <div class="kpi-box">
      <div class="kpi-label">Days Reported</div>
      <div class="kpi-val">22 / 27</div>
    </div>
    <div class="kpi-box">
      <div class="kpi-label">Total Output</div>
      <div class="kpi-val">142</div>
    </div>
    <div class="kpi-box">
      <div class="kpi-label">Target Achieved</div>
      <div class="kpi-val">94%</div>
    </div>
    <div class="kpi-box">
      <div class="kpi-label">Hours Worked</div>
      <div class="kpi-val">176h</div>
    </div>
  </div>

  <h3>Dashboard Sections:</h3>
  <ul>
    <li><strong>Target vs. Achieved Table:</strong> Shows your targets, achieved counts, daily average, and your <em>Best Day</em> of the month.
      <ul>
        <li><span class="status-pill status-green">GREEN</span> : Achievement ≥ 100% of target.</li>
        <li><span class="status-pill status-amber">AMBER</span> : Achievement between 70% and 99%.</li>
        <li><span class="status-pill status-red">RED</span> : Achievement below 70%.</li>
      </ul>
    </li>
    <li><strong>Week-Wise Breakdown (W1–W5):</strong> Breaks down counts across standard week blocks: W1 (1–7), W2 (8–14), W3 (15–21), W4 (22–28), and W5 (29–end of month).</li>
    <li><strong>Interactive 31-Day Calendar Grid:</strong>
      <ul>
        <li><strong>Green Tile:</strong> Working day reported with hours and output.</li>
        <li><strong>Red Tile:</strong> Past working day where EOD was missed.</li>
        <li><strong>Grey Tile:</strong> Weekly off (Sunday) or declared public holiday.</li>
        <li><em>Tip:</em> Clicking any day in the grid opens that specific date's entry instantly!</li>
      </ul>
    </li>
    <li><strong>PDF Export & Print:</strong> Click the <strong>PDF</strong> button in the top right to download a clean, branded A4 Portrait PDF with full signature lines.</li>
  </ul>

  <div class="page-break"></div>

  <!-- ==================== PAGE 3: SPECIAL ROLES & MANAGEMENT ==================== -->
  <h2>5. For Social Media Owner (Intern): Weekly Page Stats</h2>
  <p>
    In addition to daily EOD logs, the social media owner (Marketing Intern — <strong>Saeeda</strong>) tracks audience metrics on a weekly basis under the <strong>Weekly Stats</strong> tab (Requirement FR-18).
  </p>
  <ul>
    <li>Metrics are recorded separately for <strong>Team N Makeovers</strong> (Organic) and <strong>Team N Kerala</strong> (Paid & Availability).</li>
    <li>Weekly fields: <strong>Posts Published</strong>, <strong>Reach</strong>, and <strong>Engagement</strong> for weeks W1 through W5.</li>
    <li>Numbers are reviewed weekly by the Marketing Manager to evaluate reach vs. enquiry volume.</li>
  </ul>

  <h2>6. For the Marketing Manager: Operations & Review SOP</h2>
  <p>
    The Marketing Manager (<strong>Salmanul Faris AT</strong>) maintains team quality, target settings, and monthly review closures.
  </p>

  <h3>Key Manager Responsibilities:</h3>
  <ol>
    <li><strong>Daily Missed EOD Review (Tab 5):</strong>
      <p>Check the Missed EODs list each morning. Use the <strong>Send Reminder</strong> button to notify any team member who missed yesterday's submission.</p>
    </li>
    <li><strong>Managing Role Profiles & Activity Sets (Tab 7):</strong>
      <p>When tasks evolve or new projects start, assign or remove metrics for any member in the <em>Setup</em> tab. Changes apply from the selected month forward—historical months remain untouched.</p>
    </li>
    <li><strong>Setting Monthly Targets:</strong>
      <p>Targets are set per member per metric. On the 1st of each month, click <strong>Copy from Prev Month</strong> to roll forward the existing target template in one click.</p>
    </li>
    <li><strong>Team Summary Review & CEO Reporting (Tab 4):</strong>
      <p>Review the comprehensive comparison matrix showing all 6 members side-by-side with total department output. Click <strong>Export PDF (Landscape)</strong> to generate executive reports for CEO reviews.</p>
    </li>
    <li><strong>Month Close & Digital Sign-off (Tab 8):</strong>
      <p>At month-end, write constructive highlights & feedback in the remarks box, click <strong>Save & Publish Remarks</strong>, and then tap <strong>Sign-off & Lock Month</strong>. This records your digital signature timestamp and locks the month against further edits.</p>
    </li>
  </ol>

  <h2>7. Roles & Access Control Summary</h2>
  <table>
    <thead>
      <tr>
        <th>Action</th>
        <th class="center">Team Member</th>
        <th class="center">Marketing Manager</th>
        <th class="center">Management (CEO)</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Enter own daily EOD</td>
        <td class="center">Yes (2-day window)</td>
        <td class="center">Yes</td>
        <td class="center">No</td>
      </tr>
      <tr>
        <td>Enter EOD on behalf of another member</td>
        <td class="center">No</td>
        <td class="center">Yes (Audit Logged)</td>
        <td class="center">No</td>
      </tr>
      <tr>
        <td>View own individual dashboard</td>
        <td class="center">Yes</td>
        <td class="center">Yes</td>
        <td class="center">Yes</td>
      </tr>
      <tr>
        <td>View other members' dashboards</td>
        <td class="center">No</td>
        <td class="center">Yes</td>
        <td class="center">Yes</td>
      </tr>
      <tr>
        <td>View whole-team summary matrix</td>
        <td class="center">No</td>
        <td class="center">Yes</td>
        <td class="center">Yes</td>
      </tr>
      <tr>
        <td>Set monthly targets & role profiles</td>
        <td class="center">No</td>
        <td class="center">Yes</td>
        <td class="center">No</td>
      </tr>
      <tr>
        <td>Write monthly remarks & lock month</td>
        <td class="center">No (Ack only)</td>
        <td class="center">Yes</td>
        <td class="center">No</td>
      </tr>
      <tr>
        <td>Export branded PDF reports</td>
        <td class="center">Own Dashboard only</td>
        <td class="center">All Reports</td>
        <td class="center">All Reports</td>
      </tr>
    </tbody>
  </table>

  <div class="page-break"></div>

  <!-- ==================== PAGE 4: MASTER METRICS CATALOGUE ==================== -->
  <h2>8. Master Metric Catalogue & Default Role Profiles</h2>
  <p>
    The ERP tracks <strong>21 standardized metrics</strong> categorized under 5 groups. Below is the master catalogue and default role assignments established under SRS v1.1:
  </p>

  <table>
    <thead>
      <tr>
        <th style="width: 6%;" class="center">#</th>
        <th style="width: 14%;">Group</th>
        <th style="width: 32%;">Metric / Activity Name</th>
        <th style="width: 10%;" class="center">Unit</th>
        <th style="width: 12%;" class="center">In Total?</th>
        <th>Assigned Role Profiles</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="center"><strong>1</strong></td>
        <td>Production</td>
        <td>Shoots done</td>
        <td class="center">Count</td>
        <td class="center">Yes</td>
        <td>Editor cum Videographer, Videographer/Photographer</td>
      </tr>
      <tr>
        <td class="center"><strong>2</strong></td>
        <td>Production</td>
        <td>Reels / videos edited</td>
        <td class="center">Count</td>
        <td class="center">Yes</td>
        <td>Video Editing Head, Editor cum Videographer</td>
      </tr>
      <tr>
        <td class="center"><strong>3</strong></td>
        <td>Production</td>
        <td>Story / short edits</td>
        <td class="center">Count</td>
        <td class="center">Yes</td>
        <td>Video Editing Head, Editor cum Videographer</td>
      </tr>
      <tr>
        <td class="center"><strong>4</strong></td>
        <td>Production</td>
        <td>Creatives designed</td>
        <td class="center">Count</td>
        <td class="center">Yes</td>
        <td>Marketing Executive, Marketing Intern</td>
      </tr>
      <tr>
        <td class="center"><strong>5</strong></td>
        <td>Posting</td>
        <td>Reels posted</td>
        <td class="center">Count</td>
        <td class="center">Yes</td>
        <td>Marketing Intern</td>
      </tr>
      <tr>
        <td class="center"><strong>6</strong></td>
        <td>Posting</td>
        <td>Stories posted</td>
        <td class="center">Count</td>
        <td class="center">Yes</td>
        <td>Marketing Intern</td>
      </tr>
      <tr>
        <td class="center"><strong>7</strong></td>
        <td>Posting</td>
        <td>Feed / carousel posts</td>
        <td class="center">Count</td>
        <td class="center">Yes</td>
        <td>Marketing Intern</td>
      </tr>
      <tr>
        <td class="center"><strong>8</strong></td>
        <td>Posting</td>
        <td>Collab posts</td>
        <td class="center">Count</td>
        <td class="center">Yes</td>
        <td>Marketing Intern</td>
      </tr>
      <tr>
        <td class="center"><strong>18</strong></td>
        <td>Posting</td>
        <td>Posts on other platforms (Snap, YT, Pinterest)</td>
        <td class="center">Count</td>
        <td class="center">Yes</td>
        <td>Marketing Intern</td>
      </tr>
      <tr>
        <td class="center"><strong>9</strong></td>
        <td>Ads</td>
        <td>Campaigns launched</td>
        <td class="center">Count</td>
        <td class="center">Yes</td>
        <td>Marketing Manager</td>
      </tr>
      <tr>
        <td class="center"><strong>10</strong></td>
        <td>Ads</td>
        <td>Ad creatives launched</td>
        <td class="center">Count</td>
        <td class="center">Yes</td>
        <td>Marketing Manager</td>
      </tr>
      <tr>
        <td class="center"><strong>11</strong></td>
        <td>Ads</td>
        <td>Ad spend (₹)</td>
        <td class="center">Currency</td>
        <td class="center"><span class="status-pill status-red">No</span></td>
        <td>Marketing Manager</td>
      </tr>
      <tr>
        <td class="center"><strong>12</strong></td>
        <td>Ads</td>
        <td>Leads from ads</td>
        <td class="center">Count</td>
        <td class="center"><span class="status-pill status-red">No</span></td>
        <td>Marketing Manager</td>
      </tr>
      <tr>
        <td class="center"><strong>13</strong></td>
        <td>Coordination</td>
        <td>Portfolios prepared</td>
        <td class="center">Count</td>
        <td class="center">Yes</td>
        <td>Marketing Executive</td>
      </tr>
      <tr>
        <td class="center"><strong>14</strong></td>
        <td>Coordination</td>
        <td>Events coordinated</td>
        <td class="center">Count</td>
        <td class="center">Yes</td>
        <td>Marketing Executive</td>
      </tr>
      <tr>
        <td class="center"><strong>15</strong></td>
        <td>Coordination</td>
        <td>Collab / partner outreach</td>
        <td class="center">Count</td>
        <td class="center">Yes</td>
        <td>Marketing Manager, Marketing Executive</td>
      </tr>
      <tr>
        <td class="center"><strong>16</strong></td>
        <td>Coordination</td>
        <td>Meetings held</td>
        <td class="center">Count</td>
        <td class="center"><span class="status-pill status-red">No</span></td>
        <td>Marketing Manager, Marketing Executive</td>
      </tr>
      <tr>
        <td class="center"><strong>17</strong></td>
        <td>Coordination</td>
        <td>Reports prepared</td>
        <td class="center">Count</td>
        <td class="center">Yes</td>
        <td>Marketing Manager, Executive, Intern</td>
      </tr>
      <tr>
        <td class="center"><strong>19</strong></td>
        <td>Coordination</td>
        <td>Videos scheduled to editors</td>
        <td class="center">Count</td>
        <td class="center">Yes</td>
        <td>Marketing Executive</td>
      </tr>
      <tr>
        <td class="center"><strong>20</strong></td>
        <td>Community</td>
        <td>Enquiries passed to Sales</td>
        <td class="center">Count</td>
        <td class="center"><span class="status-pill status-red">No</span></td>
        <td>Marketing Intern</td>
      </tr>
      <tr>
        <td class="center"><strong>21</strong></td>
        <td>Community</td>
        <td>Content calendar gaps flagged</td>
        <td class="center">Count</td>
        <td class="center"><span class="status-pill status-red">No</span></td>
        <td>Marketing Intern</td>
      </tr>
    </tbody>
  </table>

  <div class="alert alert-info" style="margin-top: 15px;">
    <strong>Total Output Eligibility:</strong> Metrics marked with "No" in the <em>In Total?</em> column (such as Ad spend, Leads from ads, and Enquiries) are vital performance figures tracked on dashboards, but are excluded from the physical count of Total Daily Output.
  </div>

  <h2>9. Frequently Asked Questions (FAQ)</h2>
  <ul>
    <li><strong>Q: What happens if I forget to submit my EOD on Friday?</strong><br>
    <strong>A:</strong> You can select Friday's date in the EOD Entry tab on Saturday or Monday (within 2 days) and file your entry normally.</li>
    <li><strong>Q: Does an unpaid or company holiday count against my days reported?</strong><br>
    <strong>A:</strong> No. Sundays and declared company holidays are automatically subtracted from total working days and shaded grey.</li>
    <li><strong>Q: Can the manager add new metrics or change roles without developer assistance?</strong><br>
    <strong>A:</strong> Yes! The entire metric catalog, activity groups, and role profiles are fully editable live in the <em>Setup</em> tab.</li>
  </ul>

  <div style="margin-top: 30px; padding-top: 15px; border-top: 1px solid var(--border-color); text-align: center; font-size: 8pt; color: var(--text-muted);">
    Team N Makeovers · Marketing ERP Department · Confidential — For Internal Distribution Only
  </div>

</body>
</html>
  `;

  // 3. Launch Puppeteer and render PDF
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

  const outputPath = path.resolve('d:/Nizan/Reports/Team_N_Marketing_EOD_User_Guide.pdf');

  await page.pdf({
    path: outputPath,
    format: 'A4',
    printBackground: true,
    margin: {
      top: '14mm',
      bottom: '16mm',
      left: '14mm',
      right: '14mm',
    },
    displayHeaderFooter: true,
    headerTemplate: `
      <div style="font-size: 7.5pt; font-family: sans-serif; color: #888888; width: 100%; text-align: right; padding-right: 14mm;">
        Team N Makeovers · Marketing EOD Log & Dashboard (v1.1)
      </div>
    `,
    footerTemplate: `
      <div style="font-size: 7.5pt; font-family: sans-serif; color: #888888; width: 100%; display: flex; justify-content: space-between; padding-left: 14mm; padding-right: 14mm;">
        <span>Team N ERP — Confidential Internal Guide</span>
        <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>
    `,
  });

  await browser.close();
  console.log(`[PDF Generator] Successfully generated PDF at: ${outputPath}`);
};

generatePdf().catch((err) => {
  console.error('[PDF Generator] Error:', err);
  process.exit(1);
});
