const SIGNOZ_API_URL = (process.env.SIGNOZ_API_URL || 'http://localhost:8080/api').replace(/\/$/, '');
const SIGNOZ_API_KEY = process.env.SIGNOZ_API_KEY;

function authHeaders() {
  if (!SIGNOZ_API_KEY) {
    throw new Error(
      'SIGNOZ_API_KEY is not set. Create one in SigNoz UI -> Settings -> Service Accounts -> Keys.'
    );
  }
  return { 'Content-Type': 'application/json', 'SIGNOZ-API-KEY': SIGNOZ_API_KEY };
}

export async function querySessionSpans(traceId, { sinceMs, service = 'signoz-governor-demo-agent' } = {}) {
  const end = Date.now();
  const start = sinceMs ?? end - 10 * 60 * 1000;

  const body = {
    start,
    end,
    requestType: 'raw',
    variables: {},
    compositeQuery: {
      queries: [
        {
          type: 'builder_query',
          spec: {
            name: 'A',
            signal: 'traces',
            filter: {
              expression: `service.name = '${service}' AND traceID = '${traceId}'`,
            },
            selectFields: [
              { name: 'name' },
              { name: 'timestamp' },
              { name: 'hasError' },
              { name: 'gen_ai.tool.name' },
              { name: 'gen_ai.tool.call.arguments' },
              { name: 'cost.usd' },
              { name: 'gen_ai.usage.input_tokens' },
              { name: 'gen_ai.usage.output_tokens' },
            ],
            order: [{ key: { name: 'timestamp' }, direction: 'asc' }],
            limit: 200,
            offset: 0,
            disabled: false,
          },
        },
      ],
    },
  };

  const res = await fetch(`${SIGNOZ_API_URL}/v5/query_range`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SigNoz query_range failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  const rows = data?.data?.data?.results?.[0]?.rows ?? [];

  return rows.map(normalizeSpanRow);
}

function normalizeSpanRow(row) {
  const attrs = row.data ?? row.attributes ?? row;
  return {
    spanId: attrs.span_id ?? attrs.spanID ?? attrs.spanId,
    name: attrs.name ?? row.name,
    timestamp: attrs.timestamp ?? row.timestamp,
    toolName: attrs['gen_ai.tool.name'],
    toolArgs: attrs['gen_ai.tool.call.arguments'],
    hasError: attrs.hasError ?? attrs.has_error ?? false,
    costUsd: Number(attrs['cost.usd'] ?? 0),
    inputTokens: Number(attrs['gen_ai.usage.input_tokens'] ?? 0),
    outputTokens: Number(attrs['gen_ai.usage.output_tokens'] ?? 0),
  };
}

/**
 * Schema CONFIRMED against a real alert created via the SigNoz UI on this
 * instance, then fetched back via GET /api/v1/rules/<id>. evalWindow and
 * frequency live nested under evaluation.spec, not top-level. matchType
 * and op use 'at_least_once'/'equal', not '1'/'1'.
 */
export async function createAlertRule({ sessionId, reason, detail, traceId }) {
  const body = {
    alert: `governor-${reason}-${sessionId}`,
    alertType: 'TRACES_BASED_ALERT',
    ruleType: 'threshold_rule',
    version: 'v5',
    schemaVersion: 'v2alpha1',
    disabled: false,
    condition: {
      compositeQuery: {
        queryType: 'builder',
        panelType: 'graph',
        queries: [
          {
            type: 'builder_query',
            spec: {
              name: 'A',
              stepInterval: 0,
              signal: 'traces',
              source: '',
              aggregations: [{ expression: 'count()' }],
              filter: { expression: `service.name = 'signoz-governor-demo-agent'` },
              having: { expression: '' },
            },
          },
        ],
      },
      selectedQueryName: 'A',
      thresholds: {
        kind: 'basic',
        spec: [
          {
            name: 'critical',
            target: 0,
            targetUnit: '',
            recoveryTarget: null,
            matchType: 'at_least_once',
            op: 'equal',
            channels: [],
          },
        ],
      },
    },
    annotations: {
      description: `${detail} (session: ${sessionId}, trace: ${traceId || 'unknown'})`,
      summary: `Governor tripped: ${reason}`,
    },
    evaluation: {
      kind: 'rolling',
      spec: {
        evalWindow: '5m0s',
        frequency: '1m',
      },
    },
    notificationSettings: {
      usePolicy: true,
    },
  };

  const res = await fetch(`${SIGNOZ_API_URL}/v1/rules`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SigNoz create rule failed: ${res.status} ${text}`);
  }

  return res.json();
}

export function traceUrl(traceId) {
  const uiBase = (process.env.SIGNOZ_UI_URL || 'http://localhost:8080').replace(/\/$/, '');
  return `${uiBase}/trace/${traceId}`;
}
