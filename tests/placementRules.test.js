/**
 * Product placement rules (openspec add-admin-panel: admin-product-placements).
 */
const {
  validateDates,
  validateImageFile,
  findOverlap,
  approvalBlockers,
  dueAction,
} = require('../utils/placementRules');

const d = (s) => new Date(s);

describe('validateDates', () => {
  it('rejects end not after start, and missing dates', () => {
    expect(validateDates('2026-11-01', '2026-11-01')).toMatch(/after the start/);
    expect(validateDates('2026-11-02', '2026-11-01')).toMatch(/after the start/);
    expect(validateDates(undefined, '2026-11-01')).toMatch(/required/);
  });
  it('accepts a valid range', () => {
    expect(validateDates('2026-11-01', '2026-12-01')).toBeNull();
  });
});

describe('validateImageFile', () => {
  const ok = { mimetype: 'image/png', size: 1024 };
  it('requires a file, an allowed type and at most 10 MB', () => {
    expect(validateImageFile(undefined)).toMatch(/required/);
    expect(validateImageFile({ mimetype: 'image/gif', size: 10 })).toMatch(/JPG, PNG or WebP/);
    expect(validateImageFile({ mimetype: 'image/png', size: 10 * 1024 * 1024 + 1 })).toMatch(/10 MB/);
    expect(validateImageFile(ok)).toBeNull();
  });
  it('requires at least 800 x 800 pixels', () => {
    expect(validateImageFile(ok, { width: 799, height: 1200 })).toMatch(/800 x 800/);
    expect(validateImageFile(ok, { width: 1200, height: 799 })).toMatch(/800 x 800/);
    expect(validateImageFile(ok, { width: 800, height: 800 })).toBeNull();
  });
});

describe('findOverlap', () => {
  const live = {
    _id: 'a',
    status: 'active',
    recipeIds: ['r1', 'r2'],
    startsAt: d('2026-11-01'),
    endsAt: d('2026-12-01'),
  };
  const cand = (over) => ({ _id: 'b', recipeIds: ['r2'], startsAt: d('2026-11-15'), endsAt: d('2027-01-01'), ...over });

  it('detects a shared entry in overlapping dates', () => {
    expect(findOverlap(cand(), [live])).toEqual({ placement: live, recipeId: 'r2' });
  });
  it('ignores different entries, disjoint dates, back-to-back ranges and ended placements', () => {
    expect(findOverlap(cand({ recipeIds: ['r9'] }), [live])).toBeNull();
    expect(findOverlap(cand({ startsAt: d('2027-02-01'), endsAt: d('2027-03-01') }), [live])).toBeNull();
    expect(findOverlap(cand({ startsAt: d('2026-12-01'), endsAt: d('2027-01-01') }), [live])).toBeNull();
    expect(findOverlap(cand(), [{ ...live, status: 'expired' }])).toBeNull();
    expect(findOverlap(cand(), [{ ...live, status: 'draft' }])).toBeNull();
  });
  it('does not clash with itself', () => {
    expect(findOverlap({ ...live }, [live])).toBeNull();
  });
});

describe('approvalBlockers', () => {
  const full = {
    productName: 'Whey 1kg',
    image: { url: 'https://x/y.jpg', alt: 'Tub of whey protein' },
    recipeIds: ['r1'],
    disclosure: 'Sponsored',
    startsAt: d('2026-11-01'),
    endsAt: d('2026-12-01'),
  };
  const brand = { licenceNumber: '10020022000123' };
  const checks = { licenceRecorded: true, noHealthClaims: true };

  it('returns nothing when complete', () => {
    expect(approvalBlockers(full, brand, checks)).toEqual([]);
  });
  it('lists every missing item', () => {
    const m = approvalBlockers({ ...full, image: undefined, recipeIds: [], disclosure: '  ' }, { licenceNumber: '' }, {});
    expect(m).toEqual(
      expect.arrayContaining([
        'Manufacturer licence number on the brand',
        'Product image',
        'At least one linked entry',
        'Sponsored disclosure label',
        'Checklist: licence number recorded',
        'Checklist: image makes no unapproved health claims',
      ])
    );
  });
  it('requires alt text', () => {
    expect(approvalBlockers({ ...full, image: { url: 'u' } }, brand, checks)).toContain('Image alt text');
  });
});

describe('dueAction', () => {
  const base = { startsAt: d('2026-11-01T00:00:00Z'), endsAt: d('2026-12-01T00:00:00Z') };
  it('activates a scheduled placement once its start has passed', () => {
    expect(dueAction({ ...base, status: 'scheduled' }, d('2026-10-31T23:59:00Z'))).toBeNull();
    expect(dueAction({ ...base, status: 'scheduled' }, d('2026-11-01T00:01:00Z'))).toBe('activate');
  });
  it('expires an active placement after its end', () => {
    expect(dueAction({ ...base, status: 'active' }, d('2026-11-30T23:00:00Z'))).toBeNull();
    expect(dueAction({ ...base, status: 'active' }, d('2026-12-01T00:00:00Z'))).toBe('expire');
  });
  it('expires a scheduled placement whose whole window was missed', () => {
    expect(dueAction({ ...base, status: 'scheduled' }, d('2026-12-02T00:00:00Z'))).toBe('expire_unstarted');
  });
  it('does nothing for drafts and ended placements', () => {
    expect(dueAction({ ...base, status: 'draft' }, d('2027-01-01'))).toBeNull();
    expect(dueAction({ ...base, status: 'expired' }, d('2027-01-01'))).toBeNull();
  });
});
