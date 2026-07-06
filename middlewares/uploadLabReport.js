const fs = require('fs');
const path = require('path');
const multer = require('multer');

const labsUploadDir = path.join(__dirname, '..', 'uploads', 'labs');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      fs.mkdirSync(labsUploadDir, { recursive: true });
    } catch (err) {
      return cb(err);
    }
    return cb(null, labsUploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `lab-${uniqueSuffix}${ext}`);
  },
});

const uploadLabReport = multer({ storage });

module.exports = uploadLabReport;
