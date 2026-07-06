const NUMERIC_FIELDS = ['weight', 'height', 'bmi', 'weightIndex'];

function normalizeHealthProfileNumbers(hp) {
  if (!hp || typeof hp !== 'object') {
    return;
  }

  NUMERIC_FIELDS.forEach((key) => {
    if (!(key in hp)) {
      return;
    }

    if (hp[key] === '' || hp[key] === null) {
      hp[key] = undefined;
      return;
    }

    const parsed = Number(hp[key]);
    hp[key] = Number.isFinite(parsed) ? parsed : undefined;
  });
}

module.exports = {
  normalizeHealthProfileNumbers,
};
