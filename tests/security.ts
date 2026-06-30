

describe('security', () => {
  // SCENARIO: POST /api/v1/brain/share - security headers validation
  describe('POST /api/v1/brain/share', () => {
    // Covers: AC4
    it('happy path - security headers validation', async () => {
      const response = await request.post('/api/v1/brain/share')
        .send({ expiresInDays: 30, maxViews: 10 })
        .expect(201);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('deny');
      expect(response.headers['x-powered-by']).not.toBeDefined();
    });

    // Covers: AC4
    it('Negative: security headers not set', async () => {
      const response = await request.post('/api/v1/brain/share')
        .send({ expiresInDays: 30, maxViews: 10 })
        .expect(500);
      expect(response.body.error).toBe('Security headers not set');
    });

    // SCENARIO: GET /api/v1/brain/:shareLink - security headers validation
    describe('GET /api/v1/brain/:shareLink', () => {
      // Covers: AC5
      it('happy path - security headers validation', async () => {
        const response = await request.get('/api/v1/brain/share')
          .expect(410);
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['x-frame-options']).toBe('deny');
        expect(response.headers['x-powered-by']).not.toBeDefined();
      });

      // Covers: AC5
      it('Negative: security headers not set', async () => {
        const response = await request.get('/api/v1/brain/share')
          .expect(500);
        expect(response.body.error).toBe('Security headers not set');
      });
    });
  });
});


