// Cloudinary uploads are namespaced per-user so each account's assets live
// under their own subfolder instead of one shared bucket per asset type
// (docwellness/chat, docwellness/profiles, etc. previously mixed every
// user's files together).
function cloudinaryUserFolder(userId, assetType) {
  return `docwellness/${userId}/${assetType}`;
}

module.exports = { cloudinaryUserFolder };
