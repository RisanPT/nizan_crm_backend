import { PDFParse } from 'pdf-parse';
import fs from 'fs';

async function extractGapAnalysis() {
  const dataBuffer = fs.readFileSync('d:/Nizan/HRMS-v2-Scope-and-Gap-Analysis.pdf');
  const parser = new PDFParse({ data: dataBuffer });
  await parser.load();
  const text = (await parser.getText()).text;
  fs.writeFileSync('d:/Nizan/nizan_crm_backend/scripts/hrms_gap_extracted.txt', text);
  console.log('Wrote to d:/Nizan/nizan_crm_backend/scripts/hrms_gap_extracted.txt. Length:', text.length);
}
extractGapAnalysis();
