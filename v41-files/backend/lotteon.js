const API_BASE = 'https://openapi.lotteon.com';

function value(object, keys) {
  for (const key of keys) {
    if (object && object[key] != null) {
      return object[key];
    }
  }
  return '';
}

function messageFrom(body) {
  if (!body || typeof body !== 'object') return '';

  return String(
    value(body, [
      'message',
      'msg',
      'resultMessage',
      'resultMsg',
      'errorMessage',
      'error_description'
    ]) || ''
  );
}

export function lotteonConfigFromEnv(env = process.env) {
  return {
    apiKey: String(env.LOTTEON_API_KEY || '').trim(),
    sellerId: String(env.LOTTEON_SELLER_ID || '').trim(),
    sellerLoginId: String(env.LOTTEON_LOGIN_ID || '').trim()
  };
}

export function isLotteonConfigured(config) {
  return Boolean(config?.apiKey && config?.sellerId);
}

async function requestIdentity(config, authorization) {
  const response = await fetch(
    `${API_BASE}/v1/openapi/common/v1/identity`,
    {
      method: 'GET',
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
        'Content-Type': 'application/json;charset=UTF-8'
      }
    }
  );

  const text = await response.text();
  let body = {};

  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    body
  };
}

export async function testLotteonConnection(config) {
  if (!isLotteonConfigured(config)) {
    throw new Error('롯데온 API 키 또는 거래처번호가 등록되지 않았습니다.');
  }

  // 롯데온 문서/운영 시점에 따라 Authorization 표기가 다를 수 있어
  // Bearer 방식과 키 직접 입력 방식을 순서대로 자동 확인합니다.
  const attempts = [
    `Bearer ${config.apiKey}`,
    config.apiKey
  ];

  const errors = [];

  for (const authorization of attempts) {
    const result = await requestIdentity(config, authorization);

    if (result.ok) {
      const data =
        result.body?.data ||
        result.body?.result ||
        result.body;

      return {
        connected: true,
        authMode: authorization.startsWith('Bearer ')
          ? 'bearer'
          : 'direct',
        identity: {
          sellerId:
            String(
              value(data, [
                'trNo',
                'lrtrNo',
                'sellerId',
                'accountNumber'
              ]) || config.sellerId
            ),
          sellerName:
            String(
              value(data, [
                'trNm',
                'sellerName',
                'shopName'
              ]) || ''
            )
        },
        raw: data
      };
    }

    errors.push(
      `HTTP ${result.status} ${messageFrom(result.body)}`.trim()
    );
  }

  throw new Error(
    `롯데온 인증 실패: ${errors.join(' / ')}`
  );
}

export async function saveLotteonIntegration(db, result) {
  await db.collection('system').doc('integrations').set({
    lotteon: {
      name: '롯데온',
      connected: true,
      configured: true,
      lastRun: new Date().toISOString(),
      message:
        `인증 성공 · 거래처 ${result.identity.sellerId}` +
        (
          result.identity.sellerName
            ? ` · ${result.identity.sellerName}`
            : ''
        ),
      authMode: result.authMode,
      sellerId: result.identity.sellerId,
      sellerName: result.identity.sellerName
    }
  }, { merge: true });
}

export async function saveLotteonError(db, config, error) {
  await db.collection('system').doc('integrations').set({
    lotteon: {
      name: '롯데온',
      connected: false,
      configured: isLotteonConfigured(config),
      lastRun: new Date().toISOString(),
      message:
        error instanceof Error
          ? error.message
          : String(error)
    }
  }, { merge: true });
}
