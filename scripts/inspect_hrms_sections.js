import { PDFParse } from 'pdf-parse';
import fs from 'fs';

async function extractSection() {
  const dataBuffer = fs.readFileSync('d:/Nizan/HRMS-v2-SRS.pdf');
  const parser = new PDFParse({ data: dataBuffer });
  await parser.load();
  const text = (await parser.getText()).text;
  
  // Find "3 Functional requirements" after index 2000 (after TOC)
  const firstIdx = text.indexOf('3 Functional requirements');
  const secondIdx = text.indexOf('3 Functional requirements', firstIdx + 20);
  
  console.log('firstIdx:', firstIdx, 'secondIdx:', secondIdx);
  const start = secondIdx !== -1 ? secondIdx : text.indexOf('3.1 Recruitment', firstIdx + 50);
  
  const extIdx = text.indexOf('5 External interface requirements', start);
  const sectionContent = text.slice(start, extIdx !== -1 ? extIdx : start + 30000);
  
  console.log('Length:', sectionContent.length);
  // Write to a text file for review
  fs.writeFileSync('d:/Nizan/nizan_crm_backend/scripts/hrms_srs_extracted.txt', sectionContent);
  console.log('Wrote to d:/Nizan/nizan_crm_backend/scripts/hrms_srs_extracted.txt');
}
extractSection();
