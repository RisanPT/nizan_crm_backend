import Collection from '../models/Collection.js';
import Expense from '../models/Expense.js';
import PDFDocument from 'pdfkit';
import { Parser } from 'json2csv';

export const getFinanceReport = async (req, res) => {
  try {
    const { month, year, employeeId, format } = req.query;

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59, 999);

    const filter = {
      date: { $gte: startDate, $lte: endDate },
    };

    if (employeeId && employeeId !== 'all') {
      filter.employeeId = employeeId;
    }

    const collections = await Collection.find(filter)
      .populate('employeeId', 'name')
      .populate('bookingId', 'bookingNumber customerName');
    
    const expenses = await Expense.find(filter)
      .populate('employeeId', 'name');

    if (format === 'csv') {
      return generateCSV(res, collections, expenses, month, year);
    } else {
      return generatePDF(res, collections, expenses, month, year);
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const generateCSV = (res, collections, expenses, month, year) => {
  const fields = ['Type', 'Date', 'Artist', 'Client/Category', 'Amount', 'Status', 'Notes'];
  
  const data = [
    ...collections.map(c => ({
      Type: 'Collection',
      Date: c.date.toDateString(),
      Artist: c.employeeId?.name || 'Unknown',
      'Client/Category': c.bookingId?.customerName || 'N/A',
      Amount: c.amount,
      Status: c.status,
      Notes: c.notes,
    })),
    ...expenses.map(e => ({
      Type: 'Expense',
      Date: e.date.toDateString(),
      Artist: e.employeeId?.name || 'Unknown',
      'Client/Category': e.category,
      Amount: e.amount,
      Status: e.status,
      Notes: e.notes,
    }))
  ];

  const parser = new Parser({ fields });
  const csv = parser.parse(data);

  res.header('Content-Type', 'text/csv');
  res.attachment(`Finance_Report_${month}_${year}.csv`);
  return res.send(csv);
};

const generatePDF = (res, collections, expenses, month, year) => {
  const doc = new PDFDocument({ margin: 30, size: 'A4' });
  
  res.header('Content-Type', 'application/pdf');
  res.attachment(`Finance_Report_${month}_${year}.pdf`);
  doc.pipe(res);

  // Header
  doc.fontSize(20).text('Nizan Makeovers - Finance Report', { align: 'center' });
  doc.fontSize(12).text(`Period: ${month}/${year}`, { align: 'center' });
  doc.moveDown();

  // Collections Table
  doc.fontSize(14).fillColor('#2c3e50').text('Fund Collections', { underline: true });
  doc.moveDown(0.5);
  
  doc.fontSize(10).fillColor('black');
  collections.forEach((c, i) => {
    doc.text(`${i + 1}. ${c.date.toDateString()} | ${c.employeeId?.name || 'Unknown'} | ₹${c.amount} | ${c.status}`);
    doc.fontSize(8).text(`   Client: ${c.bookingId?.customerName || 'N/A'} | Notes: ${c.notes}`, { color: 'grey' });
    doc.moveDown(0.5);
    doc.fontSize(10);
  });

  doc.moveDown();

  // Expenses Table
  doc.fontSize(14).fillColor('#c0392b').text('Expense Claims', { underline: true });
  doc.moveDown(0.5);

  doc.fontSize(10).fillColor('black');
  expenses.forEach((e, i) => {
    doc.text(`${i + 1}. ${e.date.toDateString()} | ${e.employeeId?.name || 'Unknown'} | ₹${e.amount} | ${e.status}`);
    doc.fontSize(8).text(`   Category: ${e.category} | Notes: ${e.notes}`, { color: 'grey' });
    doc.moveDown(0.5);
    doc.fontSize(10);
  });

  // Summary
  doc.moveDown();
  const totalColl = collections.reduce((sum, c) => sum + c.amount, 0);
  const totalExp = expenses.reduce((sum, e) => sum + e.amount, 0);
  
  doc.fontSize(12).fillColor('black').text('-----------------------------------');
  doc.text(`Total Collections: ₹${totalColl}`);
  doc.text(`Total Expenses: ₹${totalExp}`);
  doc.text(`Net Balance: ₹${totalColl - totalExp}`, { bold: true });

  doc.end();
};
