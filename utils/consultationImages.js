import { cloudinary } from '../config/cloudinary.js';

// Consultation reference photos live on Cloudinary; the Consultation record
// keeps only the link and public id. Links are unguessable but not signed —
// the same trade-off as chat photos (utils/chatMedia.js). Large photos are
// scaled down on upload so they stay quick to open on a phone.

const FOLDER = () =>
  String(process.env.CONSULTATION_IMAGE_FOLDER || '').trim() || 'team_n_crm/consultations';

// Kept on an object so tests can swap them out and never reach Cloudinary.
export const referenceImageStore = {
  upload: (buffer) =>
    new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'image',
          folder: FOLDER(),
          transformation: [{ width: 2000, height: 2000, crop: 'limit' }],
        },
        (err, result) => (err ? reject(err) : resolve(result))
      );
      stream.end(buffer);
    }),
  destroy: (publicId) => cloudinary.uploader.destroy(publicId, { resource_type: 'image' }),
};

/// Uploads one image. Returns { url, publicId }.
export const uploadReferenceImage = async (buffer) => {
  const result = await referenceImageStore.upload(buffer);
  return { url: result.secure_url, publicId: result.public_id };
};

/// Deletes one image from Cloudinary. Never throws — a failed delete only
/// leaves an orphaned file behind.
export const deleteReferenceImage = async (publicId) => {
  if (!publicId) return;
  try {
    await referenceImageStore.destroy(publicId);
  } catch (err) {
    console.error('reference image delete failed:', err.message);
  }
};
