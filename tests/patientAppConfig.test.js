describe('patientApp.minBuildNumber config', () => {
  const original = process.env.PATIENT_APP_MIN_BUILD;
  afterEach(() => {
    if (original === undefined) delete process.env.PATIENT_APP_MIN_BUILD;
    else process.env.PATIENT_APP_MIN_BUILD = original;
    jest.resetModules();
  });

  const load = () => {
    jest.resetModules();
    return require('../config/environment').patientApp.minBuildNumber;
  };

  it('defaults to 0 (nothing forced) when unset', () => {
    delete process.env.PATIENT_APP_MIN_BUILD;
    expect(load()).toBe(0);
  });

  it('reads the configured build number', () => {
    process.env.PATIENT_APP_MIN_BUILD = '13';
    expect(load()).toBe(13);
  });

  it('treats garbage as 0', () => {
    process.env.PATIENT_APP_MIN_BUILD = 'abc';
    expect(load()).toBe(0);
  });
});
