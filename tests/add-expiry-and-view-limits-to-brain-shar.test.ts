// SCENARIO: POST /api/v1/brain/share - expiresAt and maxViews validation
describe('POST /api/v1/brain/share', () => {
  it('happy path - expiresInDays and maxViews validation', async () => {
    // Covers: AC1
    const response = await request.post('/api/v1/brain/share')
      .send({ expiresInDays: 30, maxViews: 10 })
      .expect(201);
    expect(response.body.expiresAt).toBeGreaterThan(Date.now());
    expect(response.body.maxViews).toBeGreaterThanOrEqual(0);
  });

  it('Negative: expiresInDays out of range', async () => {
    // Covers: AC1
    const response = await request.post('/api/v1/brain/share')
      .send({ expiresInDays: -30, maxViews: 10 })
      .expect(400);
    expect(response.body.error).toBe('Invalid expiresInDays value');
  });

  it('Negative: maxViews out of range', async () => {
    // Covers: AC1
    const response = await request.post('/api/v1/brain/share')
      .send({ expiresInDays: 30, maxViews: -10 })
      .expect(400);
    expect(response.body.error).toBe('Invalid maxViews value');
  });
});

// SCENARIO: GET /api/v1/brain/:shareLink
describe('GET /api/v1/brain/:shareLink', () => {
  it('happy path - expiresAt and maxViews return', async () => {
    // Covers: AC2
    const response = await request.get('/api/v1/brain/share')
      .expect(410);
    expect(response.body.expiresAt).toBeGreaterThan(Date.now());
    expect(response.body.maxViews).toBeGreaterThanOrEqual(0);
  });

  it('Negative: expiresAt past', async () => {
    // Covers: AC2
    const response = await request.get('/api/v1/brain/share')
      .expect(410);
    expect(response.body.expiresAt).toBeLessThan(Date.now());
  });

  it('Negative: maxViews reached', async () => {
    // Covers: AC2
    const response = await request.get('/api/v1/brain/share')
      .expect(410);
    expect(response.body.maxViews).toBeLessThanOrEqual(0);
  });
});

// SCENARIO: GET /api/v1/brain/shares
describe('GET /api/v1/brain/shares', () => {
  it('happy path - expiresAt, maxViews, and viewCount return', async () => {
    // Covers: AC3
    const response = await request.get('/api/v1/brain/shares')
      .expect(200);
    expect(response.body.expiresAt).toBeGreaterThan(Date.now());
    expect(response.body.maxViews).toBeGreaterThanOrEqual(0);
    expect(response.body.viewCount).toBeGreaterThanOrEqual(0);
  });

  it('Negative: no shares', async () => {
    // Covers: AC3
    const response = await request.get('/api/v1/brain/shares')
      .expect(200);
    expect(response.body.length).toBe(0);
  });
});