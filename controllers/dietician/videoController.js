const Video = require('../../models/Video');

/**
 * @desc    Add a new video
 * @route   POST /api/dietician/videos
 * @access  Dietician only
 */
exports.addVideo = async (req, res) => {
  try {
    const dieticianId = req.user._id;
    const { source, youtubeUrl, thumbnailUrl, visibleToUser, title, text } = req.body;

    if (!source) {
      return res.status(400).json({ success: false, message: 'Source is required' });
    }

    const videoData = {
      dieticianId,
      title: title || '',
      source,
      youtubeUrl: youtubeUrl || '',
      thumbnailUrl: thumbnailUrl || '',
      text: text || '',
      visibleToUser: visibleToUser === true || visibleToUser === 'true',
    };

    // Handle uploaded banner image
    if (req.files?.bannerImage?.[0]) {
      videoData.bannerImage = `/uploads/${req.files.bannerImage[0].filename}`;
    }

    // Handle uploaded video file (Device Storage)
    if (req.files?.videoFile?.[0]) {
      videoData.videoFile = `/uploads/${req.files.videoFile[0].filename}`;
    }

    const video = await Video.create(videoData);

    return res.status(201).json({
      success: true,
      message: 'Video added successfully',
      data: video,
    });
  } catch (error) {
    console.error('addVideo error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Update an existing video
 * @route   PUT /api/dietician/videos/:videoId
 * @access  Dietician only
 */
exports.updateVideo = async (req, res) => {
  try {
    const { videoId } = req.params;
    const dieticianId = req.user._id;
    const { source, youtubeUrl, thumbnailUrl, visibleToUser, title, text } = req.body;

    const video = await Video.findOne({ _id: videoId, dieticianId });
    if (!video) {
      return res.status(404).json({ success: false, message: 'Video not found' });
    }

    if (source) video.source = source;
    if (title !== undefined) video.title = title;
    if (text !== undefined) video.text = text;
    if (youtubeUrl !== undefined) video.youtubeUrl = youtubeUrl;
    if (thumbnailUrl !== undefined) video.thumbnailUrl = thumbnailUrl;
    if (visibleToUser !== undefined) {
      video.visibleToUser = visibleToUser === true || visibleToUser === 'true';
    }

    if (req.files?.bannerImage?.[0]) {
      video.bannerImage = `/uploads/${req.files.bannerImage[0].filename}`;
    }
    if (req.files?.videoFile?.[0]) {
      video.videoFile = `/uploads/${req.files.videoFile[0].filename}`;
    }

    await video.save();

    return res.status(200).json({
      success: true,
      message: 'Video updated successfully',
      data: video,
    });
  } catch (error) {
    console.error('updateVideo error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Get all videos for the dietician
 * @route   GET /api/dietician/videos
 * @access  Dietician only
 */
exports.getVideos = async (req, res) => {
  try {
    const videos = await Video.find({ dieticianId: req.user._id }).sort({ createdAt: -1 }).lean();
    return res.status(200).json({
      success: true,
      data: videos,
    });
  } catch (error) {
    console.error('getVideos error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Delete a specific video
 * @route   DELETE /api/dietician/videos/:videoId
 * @access  Dietician only
 */
exports.deleteVideo = async (req, res) => {
  try {
    const { videoId } = req.params;
    const deleted = await Video.findOneAndDelete({
      _id: videoId,
      dieticianId: req.user._id,
    });
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Video not found' });
    }
    return res.status(200).json({
      success: true,
      message: 'Video deleted successfully',
    });
  } catch (error) {
    console.error('deleteVideo error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Get visible videos for a patient (by their dietician)
 * @route   GET /api/patient/videos
 * @access  Patient only
 * @note    Finds the dietician via DietPlan
 */
exports.getVisibleVideosForPatient = async (req, res) => {
  try {
    const DietPlan = require('../../models/DietPlan');
    const config = require('../../config/environment');
    const patientId = req.user._id;

    // Find the dietician assigned to this patient via DietPlan
    const plan = await DietPlan.findOne({ patientId }).select('dieticianId').lean();
    const dieticianId = plan && plan.dieticianId ? plan.dieticianId : config.defaultDieticianId;

    if (!dieticianId) {
      return res.status(200).json({ success: true, data: [] });
    }

    const videos = await Video.find({
      dieticianId,
      visibleToUser: true,
    })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: videos,
    });
  } catch (error) {
    console.error('getVisibleVideosForPatient error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
