import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import multer from 'multer';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '../.env');

console.log('Loading .env from:', envPath, '| Exists:', fs.existsSync(envPath));
dotenv.config({ path: envPath, override: true });

console.log('Cloudinary Config Check:', {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'MISSING',
  api_key: process.env.CLOUDINARY_API_KEY ? 'FOUND (length ' + process.env.CLOUDINARY_API_KEY.length + ')' : 'MISSING',
  api_secret: process.env.CLOUDINARY_API_SECRET ? 'FOUND' : 'MISSING',
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'team_n_crm',
    transformation: [{ width: 1000, height: 1000, crop: 'limit' }],
  },
});

const upload = multer({ storage: storage });

export { cloudinary, upload };
