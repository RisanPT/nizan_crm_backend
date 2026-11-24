// Cloudinary storage for Team N Website images.
import { cloudinary } from '../config/cloudinary.js';

export const WEBSITE_FOLDER = 'team_n_website';

// Uploads an already-checked image to team_n_website/<subfolder>.
// The incoming transformation re-encodes the file: caps it at 2560 px, applies
// good-quality compression and drops camera metadata (EXIF / GPS).
export const uploadWebsiteImage = (buffer, subfolder) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'image',
        folder: `${WEBSITE_FOLDER}/${subfolder}`,
        unique_filename: true,
        overwrite: false,
        transformation: [{ width: 2560, height: 2560, crop: 'limit', quality: 'auto:good' }],
      },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
    stream.end(buffer);
  });

export const destroyWebsiteImage = (publicId) =>
  cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
