// Wraps an async Express route/controller so a rejected promise (a thrown
// error inside an `async` function) reaches next(err) - and therefore
// middlewares/error.js - automatically, instead of becoming an unhandled
// rejection that hangs the request. Existing controllers already do this
// manually via try/catch + next(error) (or their own inline
// res.status().json(...)) - both patterns keep working untouched; this is
// only for NEW controllers that want to skip the boilerplate try/catch by
// just `throw`ing (an ApiError or otherwise) instead.
//
// Usage:
//   router.get('/thing', asyncHandler(async (req, res) => {
//     const thing = await Thing.findById(req.params.id);
//     if (!thing) throw ApiError.notFound('Thing not found');
//     res.json({ success: true, data: thing });
//   }));
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
