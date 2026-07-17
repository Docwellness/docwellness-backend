const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const config = require('../config/environment');

// Vercel's filesystem is read-only outside /tmp, and whatever lands there
// doesn't persist or serve statically anyway - route uploads through /tmp
// there so the module doesn't crash, matching this project's existing
// use of Cloudinary as the actual persistent image store.
const uploadDir = process.env.VERCEL ? os.tmpdir() : path.resolve(config.uploadPath);
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const userPart = req.user?._id ? `${req.user._id}-` : '';
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${file.fieldname}-${userPart}${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});

const allowedTypes = /jpeg|jpg|png|gif|webp/;

const fileFilter = (req, file, cb) => {
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (extname && mimetype) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed'));
  }
};

const upload = multer({
  storage,
  limits: { fileSize: config.maxFileSize },
  fileFilter,
});

module.exports = upload;