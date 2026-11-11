import { PDFParse } from 'pdf-parse';
import fs from 'fs';

async function inspect(filePath, name) {
  try {
    const dataBuffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: dataBuffer });
    await parser.load();
    const text = await parser.getText();
    console.log('=== ' + name + ' ===');
    console.log('Total characters:', text.text.length);
    const lines = text.text.split('\n').filter(l => l.trim().length > 0);
    console.log('First 50 lines:');
    console.log(lines.slice(0, 50).join('\n'));
    
    // Search for keywords like "flow", "lifecycle", "state", "status", "module", "workflow"
    console.log('\n--- HEADINGS / SECTIONS ---');
    const headings = lines.filter(l => /^(section|[0-9]+\.|\bmodule\b|\bworkflow\b|\blifecycle\b)/i.test(l.trim()));
    console.log(headings.slice(0, 30).join('\n'));
  } catch (e) {
    console.error('Error in ' + name, e);
  }
}

async function run() {
  await inspect('d:/Nizan/HRMS-v2-SRS.pdf', 'HRMS-v2-SRS.pdf');
  console.log('\n======================================================\n');
  await inspect('d:/Nizan/HRMS-v2-Scope-and-Gap-Analysis.pdf', 'HRMS-v2-Scope-and-Gap-Analysis.pdf');
}
run();
