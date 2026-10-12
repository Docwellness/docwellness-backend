/**
 * Disclosure label helper (openspec add-admin-panel: admin-product-placements).
 * The apps show this label wherever a commercial image is displayed, so it must
 * never be missing while a commercial image is live and never linger afterwards.
 */
const { sponsoredLabelOf } = require('../utils/sponsored');

describe('sponsoredLabelOf', () => {
  it('returns the placement disclosure while a commercial image is live', () => {
    expect(sponsoredLabelOf({ imageSource: 'commercial', sponsoredLabel: 'Paid partnership' })).toBe('Paid partnership');
  });

  it('falls back to "Sponsored" so a commercial image is never shown undisclosed', () => {
    expect(sponsoredLabelOf({ imageSource: 'commercial' })).toBe('Sponsored');
    expect(sponsoredLabelOf({ imageSource: 'commercial', sponsoredLabel: '   ' })).toBe('Sponsored');
  });

  it('returns null for every non-commercial image, even with a leftover label', () => {
    for (const imageSource of ['ai-generated', 'dietician-uploaded', 'admin-uploaded', null, undefined]) {
      expect(sponsoredLabelOf({ imageSource, sponsoredLabel: 'Sponsored' })).toBeNull();
    }
  });

  it('tolerates missing documents', () => {
    expect(sponsoredLabelOf(null)).toBeNull();
    expect(sponsoredLabelOf(undefined)).toBeNull();
  });
});
