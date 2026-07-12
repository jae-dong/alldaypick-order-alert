export function elevenstConfigFromEnv(env = process.env) {
  return {
    apiKey: String(env.ELEVENST_API_KEY || '').trim(),
    sellerId: String(env.ELEVENST_SELLER_ID || '').trim()
  };
}

export function isElevenstConfigured(config) {
  return Boolean(config?.apiKey);
}

export async function checkElevenstConfiguration(db, config) {
  const configured = isElevenstConfigured(config);

  await db.collection('system').doc('integrations').set(
    {
      elevenst: {
        name: '11번가',
        connected: false,
        configured,
        lastRun: new Date().toISOString(),
        message: configured
          ? 'API 키 등록 완료 · 주문 API 연결 대기'
          : 'Open API 키 등록 필요'
      }
    },
    { merge: true }
  );

  return {
    configured,
    connected: false
  };
}
