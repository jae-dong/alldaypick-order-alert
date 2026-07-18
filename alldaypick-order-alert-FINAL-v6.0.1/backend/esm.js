export function esmConfigFromEnv(env = process.env) {
  return {
    sellerId: String(env.ESM_SELLER_ID || '').trim(),
    apiKey: String(env.ESM_API_KEY || '').trim()
  };
}

export function isEsmConfigured(config) {
  return Boolean(config?.sellerId && config?.apiKey);
}

export async function updateEsmConnectionStatus(db, config) {
  const configured = isEsmConfigured(config);

  await db.collection('system').doc('integrations').set({
    gmarket: {
      name: 'G마켓',
      connected: false,
      configured,
      lastRun: new Date().toISOString(),
      message: configured
        ? 'ESM 키 등록 완료 · 주문 API 연결 대기'
        : 'ESM API 키 등록 필요'
    },
    auction: {
      name: '옥션',
      connected: false,
      configured,
      lastRun: new Date().toISOString(),
      message: configured
        ? 'ESM 키 등록 완료 · 주문 API 연결 대기'
        : 'ESM API 키 등록 필요'
    }
  }, { merge: true });

  return { configured };
}
