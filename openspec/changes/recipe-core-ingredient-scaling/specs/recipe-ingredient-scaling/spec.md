## Purpose

Governs how a `RecipeVersion`'s ingredient quantities move together when a dietician edits one or more of them: when the total weight of the ingredients that actually matter clinically/portion-wise (the core ingredient group — one ingredient for a single-grain dish, several together for a combo/mixed dish) changes, every other ingredient's quantity follows the recipe's own proportions automatically, instead of silently drifting out of ratio.

## ADDED Requirements

### Requirement: Editing the core ingredient group's total weight proportionally rescales sub ingredients
When a dietician submits an ingredient-quantity update for a `RecipeVersion` whose ingredients include at least one core ingredient, the system SHALL compute the core group's total weight in grams both before (from the version being edited) and after (from the submitted quantities), converting each core ingredient's quantity via the existing gram-conversion logic (`resolveGramsForIngredient`). If the two totals differ (beyond negligible floating-point noise), the system SHALL recompute every sub ingredient's quantity as `previousSubQuantity × (newCoreTotalGrams ÷ previousCoreTotalGrams)`, expressed in that ingredient's existing unit, in place of whatever quantity was submitted for it in the same request. Each core ingredient's own submitted quantity SHALL always be honored verbatim, whether or not the group's total changed.

#### Scenario: Doubling a single core ingredient doubles every sub ingredient
- **WHEN** a dietician saves a new version of a single-core recipe (e.g. Chapati's Whole Wheat Flour) where the submitted core ingredient's quantity is exactly double the previous version's, regardless of what quantities were submitted for the sub ingredients
- **THEN** every sub ingredient's saved quantity is exactly double the previous version's corresponding quantity

#### Scenario: Rebalancing within a multi-core group without changing its total leaves sub ingredients unchanged
- **WHEN** a dietician saves a new version of a multi-core recipe (e.g. Mixed Vegetable's Carrot/Beans/Peas/Cauliflower) where individual core ingredients' quantities change but their combined gram weight is unchanged from the previous version
- **THEN** every sub ingredient's saved quantity is exactly whatever was submitted for it (an intentional override), unaffected by the internal rebalancing among core ingredients

#### Scenario: Growing a multi-core group's total weight scales sub ingredients by that total's ratio
- **WHEN** a dietician saves a new version of a multi-core recipe where the core group's combined gram weight increases by a given ratio, regardless of how that increase is distributed among the individual core ingredients
- **THEN** every sub ingredient's saved quantity is scaled by that same ratio

#### Scenario: Unchanged core group total leaves submitted sub-ingredient values as-is
- **WHEN** a dietician saves a new version where the core group's total gram weight is unchanged from the previous version
- **THEN** each sub ingredient's saved quantity is exactly whatever was submitted for it in the request (an intentional override, e.g. reducing salt for a hypertensive patient), and that saved value becomes the baseline the next edit's ratio is computed from

#### Scenario: Recipe with no core ingredient designated falls back to today's behavior
- **WHEN** a dietician saves a new version of a `RecipeVersion` whose ingredients carry no ingredient with `role: core`
- **THEN** every ingredient's saved quantity is exactly whatever was submitted, with no proportional recomputation performed

#### Scenario: Unresolvable core-ingredient weight falls back to today's behavior
- **WHEN** a core ingredient's quantity cannot be converted to grams (no matching `FoodItem.unitConversions`/`density` entry for its unit) in either the previous or the submitted version, making the core group's total weight impossible to compute on one or both sides
- **THEN** no sub-ingredient recomputation is performed and every ingredient's saved quantity is exactly whatever was submitted, the same as if no core ingredient were designated

### Requirement: The "Makes (on the plate)" serving display continues to scale from the recipe's overall change
The pre-existing `components` proportional-rescale behavior (driven by the ratio between the previous and new total per-serving calories) SHALL remain unaffected by this capability and SHALL continue to apply regardless of whether the triggering edit was a core-group weight change or a sub-ingredient override.

#### Scenario: Components scale after a core-triggered rescale
- **WHEN** a core-group weight change triggers sub-ingredient recomputation and the resulting nutrition total changes
- **THEN** the saved version's `components` quantities are scaled by the resulting calorie ratio, exactly as they already are for any other ingredient edit
