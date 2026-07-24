const CustomFoodRequest = require('../../models/CustomFoodRequest');

/**
 * Controller to get custom food requests for a dietician.
 */
exports.getCustomFoodRequestsForDietician = async (req, res, next) => {
  try {
    const { status = 'Pending' } = req.query;

    const requests = await CustomFoodRequest.find({
      dieticianId: req.user._id,
      status,
    })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: requests,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Controller to update the status of a custom food request.
 */
exports.updateCustomFoodRequestStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, dieticianNote } = req.body;

    if (!['Accepted', 'Rejected'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Only Accepted or Rejected are allowed.',
      });
    }

    const request = await CustomFoodRequest.findByIdAndUpdate(
      id,
      { status, dieticianNote: dieticianNote || '' },
      { new: true }
    );

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Custom food request not found',
      });
    }

    // Update chat message status in BOTH collections so it reflects on reload
    const chatStatus = status === 'Accepted' ? 'approved' : 'rejected';
    try {
      // Update V1 MessageV1 collection (doctor app reads from this)
      const MessageV1 = require('../../chat/models/MessageV1');
      await MessageV1.updateMany(
        {
          type: 'custom_food',
          senderId: request.patientId,
          'customFoodData.status': 'pending',
          'customFoodData.foodName': request.foodName,
        },
        {
          $set: {
            'customFoodData.status': chatStatus,
            'customFoodData.reviewedAt': new Date(),
            'customFoodData.reviewedBy': req.user._id,
          },
        }
      );
    } catch (chatErr) {
      console.error('Failed to update MessageV1 status:', chatErr.message);
    }

    try {
      // Update old Chat collection (legacy reads from this)
      const Chat = require('../../models/Chat');
      await Chat.updateMany(
        {
          messageType: 'custom_food',
          senderId: request.patientId,
          'metadata.customFoodRequestId': request._id,
        },
        {
          $set: {
            'metadata.action': chatStatus,
          },
        }
      );
    } catch (chatErr) {
      console.error('Failed to update Chat status:', chatErr.message);
    }

    // Notify patient in real-time via socket
    try {
      const { getChatIO } = require('../../chat');
      const io = getChatIO();
      if (io) {
        io.to(`user:${request.patientId}`).emit('custom_food_status', {
          requestId: id,
          foodName: request.foodName,
          status: chatStatus,
        });
      }
    } catch (socketErr) {
      console.error('Failed to emit socket event:', socketErr.message);
    }

    return res.status(200).json({
      success: true,
      data: request,
    });
  } catch (error) {
    next(error);
  }
};
