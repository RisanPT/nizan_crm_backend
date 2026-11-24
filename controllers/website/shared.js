// Helpers shared by the Team N Website admin controllers.
import { WEBSITE_FOLDER } from '../../utils/websiteMedia.js';
import { cloudinaryUrlPrefix } from '../../utils/websiteContent.js';

// Images saved into content must be ours: our Cloudinary account, website folder.
export const imageOpts = () => ({
  imageUrlPrefix: cloudinaryUrlPrefix(process.env.CLOUDINARY_CLOUD_NAME),
  imageFolder: WEBSITE_FOLDER,
});

export const validationFailed = (res, errors) =>
  res.status(422).json({ message: errors[0] || 'Some fields are not valid.', errors });

export const isObjectId = (id) => /^[a-f0-9]{24}$/i.test(String(id || ''));

export const userId = (req) => req.user?._id ?? null;
