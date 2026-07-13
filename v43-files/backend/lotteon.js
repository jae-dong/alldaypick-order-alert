const API_BASE = 'https://api.lotteon.com';

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

async function requestIdentity(config) {
  const response = await fetch(
    `${API_BASE}/v1/openapi/common/v1/identity`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
        'Accept-Language': 'ko',
        'X-Timezone': 'GMT+09:00'
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
    body,
    text
  };
}

function authError(result) {
  const detail =
    messageFrom(result.body) ||
    String(result.text || '').slice(0, 300);

  if (result.status === 401) {
    return new Error(
      '롯데온 인증키 오류(HTTP 401): ' +
      '인증키가 정확한지, 만료되거나 재발급된 키가 아닌지 확인해 주세요.' +
      (detail ? ` · ${detail}` : '')
    );
  }

  if (result.status === 403) {
    return new Error(
      '롯데온 출발지 IP 접근거부(HTTP 403): ' +
      'OpenAPI관리의 서버 IP에 현재 수집기 PC의 공인 IPv4를 등록해 주세요.' +
      (detail ? ` · ${detail}` : '')
    );
  }

  if (result.status === 429) {
    return new Error(
      '롯데온 호출량 초과(HTTP 429): 잠시 후 다시 시도합니다.'
    );
  }

  return new Error(
    `롯데온 인증 실패(HTTP ${result.status})` +
    (detail ? `: ${detail}` : '')
  );
}

export async function testLotteonConnection(config) {
  if (!isLotteonConfigured(config)) {
    throw new Error(
      '롯데온 API 키 또는 거래처번호가 등록되지 않았습니다.'
    );
  }

  const result = await requestIdentity(config);

  if (!result.ok) {
    throw authError(result);
  }

  const data =
    result.body?.data ||
    result.body?.result ||
    result.body;

  return {
    connected: true,
    authMode: 'bearer',
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
