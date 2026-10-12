/**
 * Placement engine against a real in-memory MongoDB
 * (openspec add-admin-panel: admin-product-placements).
 * Covers: activation touches only image fields, previous image is restored on
 * expiry/cancel, restore never clobbers a newer image, and the sweep is
 * idempotent.
 */
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

let Recipe, ProductPlacement, Brand, AdminAuditLog, engine;
const OID = () => new (require('mongoose').Types.ObjectId)();

beforeAll(async () => {
  await connectTestDb();
  Recipe = require('../models/Recipe');
  ProductPlacement = require('../models/ProductPlacement');
  Brand = require('../models/Brand');
  AdminAuditLog = require('../models/AdminAuditLog');
  engine = require('../utils/placementEngine');
});
afterEach(async () => {
  await clearTestDb();
});
afterAll(async () => {
  await disconnectTestDb();
});

// Raw inserts: the Recipe schema has many required fields that are irrelevant here.
async function makeRecipe(fields = {}) {
  const _id = OID();
  await Recipe.collection.insertOne({
    _id,
    name: 'Whey Protein',
    category: 'Supplements',
    nutrition: { calories: 120, protein: 24 },
    ingredients: [{ name: 'Whey isolate' }],
    instructions: ['Mix with water'],
    ...fields,
  });
  return _id;
}
const fresh = (id) => Recipe.collection.findOne({ _id: id });

async function makePlacement(recipeIds, over = {}) {
  const brand = await Brand.create({ name: 'Acme Nutrition', legalName: 'Acme Nutrition Pvt Ltd', email: 'a@b.co', licenceNumber: 'L1' });
  return ProductPlacement.create({
    brandId: brand._id,
    productName: 'Whey 1kg',
    recipeIds,
    image: { url: 'https://res.cloudinary.com/x/commercial.jpg', alt: 'Tub of whey', width: 1200, height: 1200 },
    disclosure: 'Sponsored',
    startsAt: new Date(Date.now() - 3600_000),
    endsAt: new Date(Date.now() + 86400_000),
    status: 'scheduled',
    ...over,
  });
}

describe('activatePlacement', () => {
  it('swaps only image, imageSource and sponsoredLabel, and remembers the old image', async () => {
    const id = await makeRecipe({ image: 'https://old/ai.jpg', imageSource: 'ai-generated' });
    const p = await makePlacement([id]);
    await engine.activatePlacement(p);

    const r = await fresh(id);
    expect(r.image).toBe('https://res.cloudinary.com/x/commercial.jpg');
    expect(r.imageSource).toBe('commercial');
    expect(r.sponsoredLabel).toBe('Sponsored');
    // Nothing clinical changed.
    expect(r.nutrition).toEqual({ calories: 120, protein: 24 });
    expect(r.ingredients).toEqual([{ name: 'Whey isolate' }]);
    expect(r.instructions).toEqual(['Mix with water']);

    const saved = await ProductPlacement.findById(p._id);
    expect(saved.status).toBe('active');
    expect(saved.previousImages[String(id)]).toEqual({ image: 'https://old/ai.jpg', imageSource: 'ai-generated' });
  });

  it('is idempotent: running twice keeps the ORIGINAL previous image', async () => {
    const id = await makeRecipe({ image: 'https://old/ai.jpg', imageSource: 'ai-generated' });
    const p = await makePlacement([id]);
    await engine.activatePlacement(p);
    await engine.activatePlacement(await ProductPlacement.findById(p._id));
    const saved = await ProductPlacement.findById(p._id);
    expect(saved.previousImages[String(id)].image).toBe('https://old/ai.jpg');
  });
});

describe('endPlacement / restore', () => {
  it('restores the previous image and removes the disclosure', async () => {
    const id = await makeRecipe({ image: 'https://old/ai.jpg', imageSource: 'ai-generated' });
    const p = await makePlacement([id]);
    await engine.activatePlacement(p);
    await engine.endPlacement(await ProductPlacement.findById(p._id), 'cancelled', 'brand pulled out');

    const r = await fresh(id);
    expect(r.image).toBe('https://old/ai.jpg');
    expect(r.imageSource).toBe('ai-generated');
    expect(r.sponsoredLabel).toBeUndefined();
    const saved = await ProductPlacement.findById(p._id);
    expect(saved.status).toBe('cancelled');
    expect(saved.endReason).toBe('brand pulled out');
  });

  it('removes the image entirely when the entry had none before', async () => {
    const id = await makeRecipe({});
    const p = await makePlacement([id]);
    await engine.activatePlacement(p);
    await engine.endPlacement(await ProductPlacement.findById(p._id), 'expired', 'end_date_reached');
    const r = await fresh(id);
    expect(r.image).toBeUndefined();
    expect(r.imageSource).toBeUndefined();
    expect(r.sponsoredLabel).toBeUndefined();
  });

  it('never overwrites an image that someone else has set since', async () => {
    const id = await makeRecipe({ image: 'https://old/ai.jpg', imageSource: 'ai-generated' });
    const p = await makePlacement([id]);
    await engine.activatePlacement(p);
    await Recipe.collection.updateOne({ _id: id }, { $set: { image: 'https://newer/upload.jpg', imageSource: 'admin-uploaded' } });
    await engine.endPlacement(await ProductPlacement.findById(p._id), 'expired', 'end_date_reached');
    const r = await fresh(id);
    expect(r.image).toBe('https://newer/upload.jpg');
    expect(r.imageSource).toBe('admin-uploaded');
  });
});

describe('runPlacementSweep', () => {
  it('starts due placements and expires finished ones, auditing each', async () => {
    const a = await makeRecipe({ image: 'https://old/a.jpg', imageSource: 'ai-generated' });
    const b = await makeRecipe({ image: 'https://old/b.jpg', imageSource: 'ai-generated' });
    const starting = await makePlacement([a]);
    const finishing = await makePlacement([b], {
      status: 'active',
      startsAt: new Date(Date.now() - 2 * 86400_000),
      endsAt: new Date(Date.now() - 60_000),
      previousImages: { [String(b)]: { image: 'https://old/b.jpg', imageSource: 'ai-generated' } },
    });
    await Recipe.collection.updateOne(
      { _id: b },
      { $set: { image: finishing.image.url, imageSource: 'commercial', sponsoredLabel: 'Sponsored' } }
    );

    const result = await engine.runPlacementSweep();
    expect(result).toEqual({ activated: 1, expired: 1, errors: 0 });
    expect((await fresh(a)).imageSource).toBe('commercial');
    expect((await fresh(b)).image).toBe('https://old/b.jpg');
    expect((await ProductPlacement.findById(starting._id)).status).toBe('active');
    expect((await ProductPlacement.findById(finishing._id)).status).toBe('expired');

    const actions = (await AdminAuditLog.find({}).lean()).map((x) => x.action).sort();
    expect(actions).toEqual(['placement.activate', 'placement.expire']);
  });

  it('is a no-op the second time', async () => {
    const a = await makeRecipe({ image: 'https://old/a.jpg', imageSource: 'ai-generated' });
    await makePlacement([a]);
    await engine.runPlacementSweep();
    const second = await engine.runPlacementSweep();
    expect(second).toEqual({ activated: 0, expired: 0, errors: 0 });
  });

  it('leaves a future placement alone', async () => {
    const a = await makeRecipe({ image: 'https://old/a.jpg', imageSource: 'ai-generated' });
    await makePlacement([a], { startsAt: new Date(Date.now() + 86400_000), endsAt: new Date(Date.now() + 2 * 86400_000) });
    await engine.runPlacementSweep();
    expect((await fresh(a)).image).toBe('https://old/a.jpg');
  });
});
