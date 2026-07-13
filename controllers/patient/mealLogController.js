const MealLog = require('../../models/MealLog');
const Chat = require('../../models/Chat');
const Conversation = require('../../models/Conversation');
const DietPlan = require('../../models/DietPlan');
const config = require('../../config/environment');
const cloudinary = require('../../config/cloudinary');
const { cloudinaryUserFolder } = require('../../utils/cloudinaryFolder');
const fs = require('fs/promises');

// v1 Chat Integration
const { MealLogSyncService } = require('../../chat/services');

const isToday = (date) => {
  const today = new Date();
  const compareDate = new Date(date);
  return (
    today.getFullYear() === compareDate.getFullYear() &&
    today.getMonth() === compareDate.getMonth() &&
    today.getDate() === compareDate.getDate()
  );
};

const getStartOfDay = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const getEndOfDay = () => {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
};

exports.createMealLog = async (req, res, next) => {
  try {
    const patientId = req.user._id;
    const { mealType, recipeId, servings, caloriesConsumed, notes } = req.body;

    const startOfDay = getStartOfDay();
    const endOfDay = getEndOfDay();

    let todayLog = await MealLog.findOne({
      patientId,
      date: { $gte: startOfDay, $lte: endOfDay },
    });

    const newMeal = {
      mealType,
      servingTime: mealType,
      recipeId,
      servings: servings || 1,
      caloriesConsumed: caloriesConsumed || 0,
      notes,
    };

    if (!todayLog) {
      todayLog = await MealLog.create({
        patientId,
        date: new Date(),
        meals: [newMeal],
        totalCalories: caloriesConsumed || 0,
      });
    } else {
      todayLog.meals.push(newMeal);
      todayLog.totalCalories = todayLog.meals.reduce(
        (sum, m) => sum + (m.caloriesConsumed || 0),
        0
      );
      await todayLog.save();
    }

    const todayStats = await getTodayStatsInternal(patientId);

    await sendMealUpdateToChat(req, patientId, {
      action: 'added',
      itemName: mealType,
      calories: caloriesConsumed,
      servings,
      servingTime: mealType,
      todayStats,
    });

    // v1 Chat Sync: Create meal_log message card
    try {
      await MealLogSyncService.ingestFromInternal({
        event_type: 'meal_log.created',
        meal_log_id: todayLog._id.toString(),
        meal_log_version: todayLog.__v || 1,
        actor_user_id: patientId.toString(),
        snapshot: {
          mealType,
          calories: caloriesConsumed,
          servings,
          totalCalories: todayStats.totalCalories,
          plannedCalories: todayStats.plannedCalories,
        },
      });
    } catch (syncError) {
      console.error('[MealLogSync] Failed to sync create event:', syncError.message);
    }

    res.status(201).json({
      success: true,
      data: {
        mealLog: todayLog,
        todayStats,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.updateMealLog = async (req, res, next) => {
  try {
    const { id, mealIndex } = req.params;
    const patientId = req.user._id;
    const updates = req.body;

    const mealLog = await MealLog.findOne({ _id: id, patientId });

    if (!mealLog) {
      return res.status(404).json({ success: false, message: 'Meal log not found' });
    }

    if (!isToday(mealLog.date)) {
      return res.status(403).json({
        success: false,
        message: 'You can only edit meals logged today',
      });
    }

    const idx = parseInt(mealIndex);
    if (mealLog.meals[idx]) {
      Object.assign(mealLog.meals[idx], updates);
      mealLog.totalCalories = mealLog.meals.reduce((sum, m) => sum + (m.caloriesConsumed || 0), 0);
      await mealLog.save();
    }

    const todayStats = await getTodayStatsInternal(patientId);

    await sendMealUpdateToChat(req, patientId, {
      action: 'updated',
      itemName: mealLog.meals[idx]?.mealType || 'Meal',
      calories: mealLog.meals[idx]?.caloriesConsumed,
      servings: mealLog.meals[idx]?.servings,
      servingTime: mealLog.meals[idx]?.mealType,
      todayStats,
    });

    // v1 Chat Sync: Update meal_log message card in-place
    try {
      await MealLogSyncService.ingestFromInternal({
        event_type: 'meal_log.updated',
        meal_log_id: mealLog._id.toString(),
        meal_log_version: (mealLog.__v || 0) + 1,
        actor_user_id: patientId.toString(),
        snapshot: {
          mealType: mealLog.meals[idx]?.mealType,
          calories: mealLog.meals[idx]?.caloriesConsumed,
          servings: mealLog.meals[idx]?.servings,
          totalCalories: todayStats.totalCalories,
          plannedCalories: todayStats.plannedCalories,
        },
      });
    } catch (syncError) {
      console.error('[MealLogSync] Failed to sync update event:', syncError.message);
    }

    res.status(200).json({
      success: true,
      data: { mealLog, todayStats },
    });
  } catch (error) {
    next(error);
  }
};

exports.deleteMealLog = async (req, res, next) => {
  try {
    const { id, mealIndex } = req.params;
    const patientId = req.user._id;

    const mealLog = await MealLog.findOne({ _id: id, patientId });

    if (!mealLog) {
      return res.status(404).json({ success: false, message: 'Meal log not found' });
    }

    if (!isToday(mealLog.date)) {
      return res.status(403).json({
        success: false,
        message: 'You can only delete meals logged today',
      });
    }

    if (mealIndex !== undefined) {
      mealLog.meals.splice(parseInt(mealIndex), 1);
      mealLog.totalCalories = mealLog.meals.reduce((sum, m) => sum + (m.caloriesConsumed || 0), 0);
      await mealLog.save();
    } else {
      await mealLog.deleteOne();
    }

    res.status(200).json({ success: true, message: 'Meal deleted' });
  } catch (error) {
    next(error);
  }
};

exports.getTodayMealLogs = async (req, res, next) => {
  try {
    const patientId = req.user._id;
    const startOfDay = getStartOfDay();
    const endOfDay = getEndOfDay();

    const mealLog = await MealLog.findOne({
      patientId,
      date: { $gte: startOfDay, $lte: endOfDay },
    }).populate('meals.recipeId');

    const stats = await getTodayStatsInternal(patientId);

    res.status(200).json({
      success: true,
      data: {
        mealLog,
        stats,
        canEdit: true,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.getCalorieTrend = async (req, res, next) => {
  try {
    const patientId = req.user._id;
    const { days = 7 } = req.query;
    const daysCount = Math.min(parseInt(days) || 7, 30);

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - (daysCount - 1));
    startDate.setHours(0, 0, 0, 0);

    const mealLogs = await MealLog.find({
      patientId,
      date: { $gte: startDate },
    }).sort({ date: 1 });

    // Build a map of date → total calories
    const calorieMap = {};
    for (let i = 0; i < daysCount; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().split('T')[0];
      calorieMap[key] = 0;
    }

    for (const log of mealLogs) {
      const key = new Date(log.date).toISOString().split('T')[0];
      if (calorieMap[key] !== undefined) {
        calorieMap[key] += log.totalCalories || 0;
      }
    }

    const trend = Object.entries(calorieMap).map(([date, calories]) => ({
      date,
      calories: Math.round(calories),
    }));

    res.status(200).json({ success: true, data: trend });
  } catch (error) {
    next(error);
  }
};

exports.getMealLogStats = async (req, res, next) => {
  try {
    const patientId = req.user._id;
    const stats = await getTodayStatsInternal(patientId);

    res.status(200).json({ success: true, data: stats });
  } catch (error) {
    next(error);
  }
};

exports.getAllMealLogs = async (req, res, next) => {
  try {
    const patientId = req.user._id;
    const { page = 1, limit = 20, date } = req.query;

    const filter = { patientId };

    if (date) {
      const queryDate = new Date(date);
      const startOfDay = new Date(queryDate.setHours(0, 0, 0, 0));
      const endOfDay = new Date(queryDate.setHours(23, 59, 59, 999));
      filter.date = { $gte: startOfDay, $lte: endOfDay };
    }

    const mealLogs = await MealLog.find(filter)
      .populate('meals.recipeId')
      .sort({ date: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await MealLog.countDocuments(filter);

    res.status(200).json({
      success: true,
      data: mealLogs,
      pagination: { page: parseInt(page), limit: parseInt(limit), total },
    });
  } catch (error) {
    next(error);
  }
};

exports.completeMeal = async (req, res, next) => {
  try {
    const { id, mealIndex } = req.params;
    const patientId = req.user._id;

    const mealLog = await MealLog.findOne({ _id: id, patientId });

    if (!mealLog) {
      return res.status(404).json({ success: false, message: 'Meal log not found' });
    }

    if (!isToday(mealLog.date)) {
      return res.status(403).json({
        success: false,
        message: 'You can only complete meals logged today',
      });
    }

    const idx = parseInt(mealIndex);
    if (mealLog.meals[idx]) {
      mealLog.meals[idx].isCompleted = true;
      await mealLog.save();
    }

    const todayStats = await getTodayStatsInternal(patientId);

    await sendMealUpdateToChat(req, patientId, {
      action: 'completed',
      itemName: mealLog.meals[idx]?.mealType || 'Meal',
      calories: mealLog.meals[idx]?.caloriesConsumed,
      servings: mealLog.meals[idx]?.servings,
      servingTime: mealLog.meals[idx]?.mealType,
      todayStats,
    });

    // v1 Chat Sync: Update meal_log message card for completion
    try {
      await MealLogSyncService.ingestFromInternal({
        event_type: 'meal_log.completed',
        meal_log_id: mealLog._id.toString(),
        meal_log_version: (mealLog.__v || 0) + 1,
        actor_user_id: patientId.toString(),
        snapshot: {
          mealType: mealLog.meals[idx]?.mealType,
          calories: mealLog.meals[idx]?.caloriesConsumed,
          isCompleted: true,
          totalCalories: todayStats.totalCalories,
          plannedCalories: todayStats.plannedCalories,
          completionPercentage: todayStats.completionPercentage,
        },
      });
    } catch (syncError) {
      console.error('[MealLogSync] Failed to sync complete event:', syncError.message);
    }

    res.status(200).json({
      success: true,
      data: { mealLog, todayStats },
    });
  } catch (error) {
    next(error);
  }
};

exports.addMealNote = async (req, res, next) => {
  try {
    const patientId = req.user._id;
    const { description } = req.body;

    let imageUrl = null;
    if (req.file) {
      const result = await cloudinary.uploader.upload(req.file.path, {
        folder: cloudinaryUserFolder(patientId, 'meal-notes'),
      });
      imageUrl = result.secure_url;
      await fs.unlink(req.file.path).catch(() => {});
    }

    const dieticianId = config.defaultDieticianId;
    let conversation = await Conversation.findOne({
      $and: [{ 'participants.userId': patientId }, { 'participants.userId': dieticianId }],
    });

    if (!conversation) {
      conversation = await Conversation.create({
        participants: [{ userId: patientId }, { userId: dieticianId }],
      });
    }

    const chatMessage = await Chat.create({
      conversationId: conversation._id,
      senderId: patientId,
      receiverId: dieticianId,
      message: description || 'Meal note',
      messageType: 'meal_log',
      attachment: imageUrl,
      description,
      metadata: {
        action: 'note',
        imageUrl,
      },
    });

    conversation.lastMessage = description
      ? `Note: ${description.substring(0, 30)}...`
      : 'Sent a meal note';
    conversation.lastMessageAt = new Date();
    await conversation.save();

    const io = req.app.get('io');
    if (io) {
      io.to(dieticianId.toString()).emit('new_message', chatMessage);
    }

    res.status(201).json({
      success: true,
      data: { chatMessage },
    });
  } catch (error) {
    next(error);
  }
};

async function sendMealUpdateToChat(req, patientId, data) {
  const dieticianId = config.defaultDieticianId;
  let conversation = await Conversation.findOne({
    $and: [{ 'participants.userId': patientId }, { 'participants.userId': dieticianId }],
  });

  if (!conversation) {
    conversation = await Conversation.create({
      participants: [{ userId: patientId }, { userId: dieticianId }],
    });
  }

  const chatMessage = await Chat.create({
    conversationId: conversation._id,
    senderId: patientId,
    receiverId: dieticianId,
    message: `${data.action === 'added' ? 'Logged' : data.action === 'updated' ? 'Updated' : 'Completed'}: ${data.itemName}`,
    messageType: 'meal_log',
    metadata: {
      action: data.action,
      itemName: data.itemName,
      calories: data.calories,
      servings: data.servings,
      servingTime: data.servingTime,
      totalConsumed: data.todayStats?.totalCalories,
      totalPlanned: data.todayStats?.plannedCalories,
    },
  });

  conversation.lastMessage = chatMessage.message;
  conversation.lastMessageAt = new Date();
  await conversation.save();

  const io = req.app.get('io');
  if (io) {
    io.to(dieticianId.toString()).emit('new_message', chatMessage);
    io.to(dieticianId.toString()).emit('meal_log_update', {
      patientId: patientId.toString(),
      stats: data.todayStats,
    });
  }
}

async function getTodayStatsInternal(patientId) {
  const startOfDay = getStartOfDay();
  const endOfDay = getEndOfDay();

  const todayLog = await MealLog.findOne({
    patientId,
    date: { $gte: startOfDay, $lte: endOfDay },
  });

  const totalCalories = todayLog?.totalCalories || 0;
  const mealsLogged = todayLog?.meals?.length || 0;

  const activePlan = await DietPlan.findOne({
    patientId,
    isActive: true,
  });

  const plannedCalories = activePlan?.dailyCalorieTarget || 2000;

  return {
    totalCalories,
    plannedCalories,
    mealsLogged,
    completionPercentage: Math.round((totalCalories / plannedCalories) * 100),
    canEdit: true,
  };
}
