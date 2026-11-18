// Today's account-wide usage from Cloudflare's GraphQL Analytics API, against the Workers Free daily limits.
// Used by the hourly alert in the Worker and by `npm run admin stats` on the owner's PC.

export const FREE_LIMITS =
{
    requests: 100_000,     // Workers requests per day (all Workers on the account)
    rowsRead: 5_000_000,   // D1 rows read per day
    rowsWritten: 100_000,  // D1 rows written per day
};

export interface Usage
{
    date: string;
    requests: number;
    rowsRead: number;
    rowsWritten: number;
}

const QUERY = `query Usage($acct: String!, $start: Time!, $end: Time!, $date: Date!) {
  viewer {
    accounts(filter: { accountTag: $acct }) {
      workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end }) {
        sum { requests }
      }
      d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date: $date }) {
        sum { rowsRead rowsWritten }
      }
    }
  }
}`;

// Today's requests and D1 rows from Cloudflare's analytics API.
export async function fetchUsage(accountId: string, token: string, asOf = new Date()): Promise<Usage>
{
    const date = asOf.toISOString().slice(0, 10);
    const start = date + "T00:00:00Z";
    const end = new Date(Date.parse(start) + 86_400_000).toISOString();
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql",
    {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { acct: accountId, start, end, date } }),
    });

    if (!res.ok) throw new Error("analytics http " + res.status);

    const body = (await res.json()) as any;

    if (body.errors?.length) throw new Error("analytics: " + String(body.errors[0]?.message).slice(0, 200));

    const acct = body.data?.viewer?.accounts?.[0] ?? {};
    const sum = (rows: any[] | undefined, field: string) => (rows ?? []).reduce((total, row) => total + Number(row?.sum?.[field] ?? 0), 0);

    return {
        date,
        requests: sum(acct.workersInvocationsAdaptive, "requests"),
        rowsRead: sum(acct.d1AnalyticsAdaptiveGroups, "rowsRead"),
        rowsWritten: sum(acct.d1AnalyticsAdaptiveGroups, "rowsWritten"),
    };
}

// Usage as a share of the free plan's daily limits.
export function percentages(usage: Usage)
{
    return {
        requests: (usage.requests / FREE_LIMITS.requests) * 100,
        rowsRead: (usage.rowsRead / FREE_LIMITS.rowsRead) * 100,
        rowsWritten: (usage.rowsWritten / FREE_LIMITS.rowsWritten) * 100,
    };
}

export interface Health
{
    requests: number;
    errors: number;
    /** CPU time per request in milliseconds; the Workers Free limit is 10 ms. */
    cpuP50: number;
    cpuP99: number;
}

const HEALTH_QUERY = `query Health($acct: String!, $start: Time!, $end: Time!, $script: String!) {
  viewer {
    accounts(filter: { accountTag: $acct }) {
      workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end, scriptName: $script }) {
        sum { requests errors }
        quantiles { cpuTimeP50 cpuTimeP99 }
      }
    }
  }
}`;

/** Today's requests, errors and CPU time for one Worker. Used by the owner's admin tool only. */
export async function fetchHealth(accountId: string, token: string, script: string, asOf = new Date()): Promise<Health>
{
    const date = asOf.toISOString().slice(0, 10);
    const start = date + "T00:00:00Z";
    const end = new Date(Date.parse(start) + 86_400_000).toISOString();
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql",
    {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ query: HEALTH_QUERY, variables: { acct: accountId, start, end, script } }),
    });

    if (!res.ok) throw new Error("analytics http " + res.status);

    const body = (await res.json()) as any;

    if (body.errors?.length) throw new Error("analytics: " + String(body.errors[0]?.message).slice(0, 200));

    const rows: any[] = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
    let requests = 0, errors = 0, p50 = 0, p99 = 0;

    for (const row of rows)
    {
        requests += Number(row?.sum?.requests ?? 0);
        errors += Number(row?.sum?.errors ?? 0);
        // Quantiles come per group; the worst group is the honest number.
        p50 = Math.max(p50, Number(row?.quantiles?.cpuTimeP50 ?? 0));
        p99 = Math.max(p99, Number(row?.quantiles?.cpuTimeP99 ?? 0));
    }

    return { requests, errors, cpuP50: p50 / 1000, cpuP99: p99 / 1000 };
}
