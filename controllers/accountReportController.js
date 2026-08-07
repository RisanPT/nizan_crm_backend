import asyncHandler from 'express-async-handler';
import AccountReport from '../models/AccountReport.js';
import { cloudinary } from '../config/cloudinary.js';
import { Readable } from 'stream';

// @desc    Upload an account report
// @route   POST /api/account-reports
// @access  Private
const uploadReport = asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400);
    throw new Error('No file uploaded');
  }

  const { title } = req.body;
  if (!title) {
    res.status(400);
    throw new Error('Please provide a title for the report');
  }

  const ext = req.file.originalname.split('.').pop().toLowerCase();
  const fileType = ext === 'pdf' ? 'pdf' : (ext.startsWith('xls') ? 'excel' : 'other');

  // We use resource_type: 'raw' for PDFs and Excel files
  // Cloudinary's upload_stream allows us to pipe the memory buffer
  const uploadStream = cloudinary.uploader.upload_stream(
    {
      resource_type: 'raw',
      folder: 'team_n_crm/reports',
      use_filename: true,
      unique_filename: true,
    },
    async (error, result) => {
      if (error) {
        console.error('Cloudinary upload error:', error);
        res.status(500);
        return res.json({ message: 'Error uploading file to Cloudinary' });
      }

      // Save to database
      const report = new AccountReport({
        title,
        fileUrl: result.secure_url,
        fileType,
        uploadedBy: req.user._id,
      });

      const savedReport = await report.save();
      // Populate the uploader so the client gets the same shape as GET (which
      // groups reports by uploader name) — otherwise uploadedBy is a bare id.
      await savedReport.populate('uploadedBy', 'name email');

      res.status(201).json(savedReport);
    }
  );

  // Convert buffer to stream and pipe it to cloudinary
  Readable.from(req.file.buffer).pipe(uploadStream);
});

// @desc    Get all account reports
// @route   GET /api/account-reports
// @access  Private
const getReports = asyncHandler(async (req, res) => {
  const reports = await AccountReport.find({})
    .populate('uploadedBy', 'name email')
    .sort({ createdAt: -1 });

  res.json(reports);
});

// @desc    Delete an account report
// @route   DELETE /api/account-reports/:id
// @access  Private
const deleteReport = asyncHandler(async (req, res) => {
  const report = await AccountReport.findById(req.params.id);

  if (report) {
    // Optionally delete from Cloudinary as well
    if (report.fileUrl) {
      try {
        // Extract public_id from raw file URL
        // Example: https://res.cloudinary.com/demo/raw/upload/v12345/folder/file.pdf
        const urlParts = report.fileUrl.split('/');
        const folderIndex = urlParts.indexOf('team_n_crm');
        if (folderIndex !== -1) {
          const publicIdWithExt = urlParts.slice(folderIndex).join('/');
          // For raw files in Cloudinary, the public_id includes the extension
          await cloudinary.uploader.destroy(publicIdWithExt, { resource_type: 'raw' });
        }
      } catch (err) {
        console.error('Failed to delete file from Cloudinary:', err);
      }
    }

    await report.deleteOne();
    res.json({ message: 'Report removed' });
  } else {
    res.status(404);
    throw new Error('Report not found');
  }
});

export { uploadReport, getReports, deleteReport };
