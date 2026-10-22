import { cloudinary } from '../config/cloudinary.js';
import { baseMime } from '../middleware/chatUpload.js';

// Turns the multer files on a chat request into stored attachments.
//
//  - Photos  -> Cloudinary `image`, downscaled to 1600px and stored as JPEG
//               (so HEIC from iPhones renders everywhere).
//  - Voice   -> Cloudinary `video` (Cloudinary's resource type for audio),
//               delivered as MP3. Staff on Chrome record WebM/Opus, which iOS
//               can't play, so every voice note is normalised to MP3.
//
// URLs are unguessable Cloudinary links (not signed), same trade-off as the
// other CRM uploads.

const MAX_VOICE_MS = 10 * 60 * 1000;

const upload = (buffer, options) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) =>
      err ? reject(err) : resolve(result),
    );
    stream.end(buffer);
  });

const uploadImage = async (file) => {
  const isGif = baseMime(file.mimetype) === 'image/gif';
  const result = await upload(file.buffer, {
    resource_type: 'image',
    folder: 'team_n_crm/chat',
    transformation: [{ width: 1600, height: 1600, crop: 'limit' }],
    ...(isGif ? {} : { format: 'jpg' }),
  });
  return { url: result.secure_url, type: 'image', durationMs: 0 };
};

const uploadAudio = async (file, clientDurationMs) => {
  const result = await upload(file.buffer, {
    resource_type: 'video',
    folder: 'team_n_crm/chat_audio',
    eager: [{ format: 'mp3' }],
    eager_async: false,
  });
  const url = cloudinary.url(result.public_id, { resource_type: 'video', format: 'mp3', secure: true });
  const fromCloudinary = Math.round(Number(result.duration || 0) * 1000);
  const durationMs = Math.min(MAX_VOICE_MS, Math.max(0, fromCloudinary || clientDurationMs || 0));
  return { url, type: 'audio', durationMs };
};

/// Uploads every file on the request (in order). At most one voice note per
/// message. Throws an Error with `.status` set for bad input.
export const uploadChatFiles = async (files = [], body = {}) => {
  const audioFiles = files.filter((f) => baseMime(f.mimetype).startsWith('audio/'));
  if (audioFiles.length > 1) {
    const err = new Error('Send one voice message at a time.');
    err.status = 400;
    throw err;
  }
  const clientDurationMs = Number.parseInt(body.durationMs, 10) || 0;
  return Promise.all(
    files.map((f) =>
      baseMime(f.mimetype).startsWith('audio/') ? uploadAudio(f, clientDurationMs) : uploadImage(f),
    ),
  );
};

/// What the inbox list / notifications show for a message.
export const previewFor = (text = '', attachments = []) => {
  const t = String(text || '').trim();
  if (t) return t.slice(0, 120);
  if (attachments.some((a) => a.type === 'audio')) return '🎤 Voice message';
  const photos = attachments.filter((a) => a.type === 'image').length;
  if (photos === 1) return '📷 Photo';
  if (photos > 1) return `📷 ${photos} photos`;
  return '';
};
