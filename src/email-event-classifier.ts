/**
 * Heuristic classifier for email-open and email-click events.
 *
 * The classifier returns one of:
 *   - 'human_likely'  — the signals look like a real recipient
 *   - 'machine_likely' — the signals look like a proxy, prefetch,
 *                       image cache, security scanner or bot
 *   - 'unknown'       — insufficient signal either way
 *
 * The classification is ADVISORY — never the sole basis for any
 * decision. The admin UI must always show the raw event AND
 * the classification reasons.
 *
 * Why this exists:
 *   Modern email infrastructure (Apple Mail Privacy Protection,
 *   Gmail image proxy, Outlook / Microsoft Safe Links, corporate
 *   security gateways, spam filters, archiving systems) routinely
 *   pre-fetches images and pre-clicks links before — or completely
 *   independently of — the human recipient opening or clicking.
 *   Treating every open or click as "the customer saw this" or
 *   "the customer clicked this" is wrong and operationally risky.
 *
 * What we DON'T do here:
 *   - Block tracking based on classification.
 *   - Reject events.
 *   - Refuse to redirect a click because we think it's a scanner.
 *   We classify and record; the click still redirects, the pixel
 *   still returns its GIF, the event row still lands.
 */

export type EventClassification = 'human_likely' | 'machine_likely' | 'unknown';

export interface ClassificationResult {
    classification: EventClassification;
    reasons: string[];
}

// Lower-cased patterns we consider machine-likely. Each adds a reason
// code so the admin UI can explain *why* an event was classified.
const MAIL_PROXY_PATTERNS: Array<[RegExp, string]> = [
    [/gmail|googleimageproxy|googlebot|googleusercontent/i, 'gmail-proxy'],
    [/yahoo!? mail|yahoomail/i, 'yahoo-mail-proxy'],
    [/outlook|microsoft.*outlook|exchange|owa/i, 'outlook-proxy'],
    [/applemailprivacy|apple.*privacy|icloud.*relay/i, 'ampp'],
    [/proofpoint/i, 'proofpoint'],
    [/mimecast/i, 'mimecast'],
    [/barracuda/i, 'barracuda'],
    [/forcepoint/i, 'forcepoint'],
    [/symantec|messagelabs/i, 'symantec'],
    [/cloudmark/i, 'cloudmark'],
    [/trendmicro/i, 'trend-micro'],
    [/fireeye/i, 'fireeye'],
    [/abusix/i, 'abusix'],
    [/spamtitan|n-able/i, 'spam-filter'],
    [/safelinks|urldefense|safebrowsing/i, 'safelinks'],
    [/messagewise/i, 'messagewise'],
    [/inky email/i, 'inky'],
];

const SCANNER_UA_PATTERNS: Array<[RegExp, string]> = [
    [/bot|crawler|spider|fetcher|index/i, 'bot-ua'],
    [/headlesschrome|phantomjs|puppeteer/i, 'headless'],
    [/curl|wget|httpclient|python-requests|go-http/i, 'cli-ua'],
    [/preview|prefetch|preloaded/i, 'prefetch'],
    [/scanner|virustotal|sentinelone|cylance|crowdstrike|defender/i, 'scanner-ua'],
];

// Hostnames / IP-org substrings that strongly indicate datacentre /
// cloud-provider traffic when they appear in the IP enrichment data.
const DATACENTRE_ORG_PATTERNS = [
    'amazon', 'aws', 'google', 'azure', 'microsoft', 'digitalocean',
    'linode', 'ovh', 'hetzner', 'leaseweb', 'choopa', 'vultr',
    'oracle', 'tencent', 'alibaba', 'fastly', 'cloudflare',
];

export interface ClassifierInput {
    userAgent: string | null;
    /** When set, the enrichment provider's flags. Each field is
     *  optional — pass through whatever you have. */
    ipIsVpn?: boolean | null;
    ipIsProxy?: boolean | null;
    ipIsTor?: boolean | null;
    ipIsDatacentre?: boolean | null;
    ipIsKnownSecurityScanner?: boolean | null;
    ipOrg?: string | null;
    /** Some providers expose a numeric risk score (0..100). >= 70
     *  is treated as a strong "machine / risky" signal. */
    ipRiskScore?: number | null;
    /** Optional: the event type — opens have a slightly different
     *  default-when-unknown to clicks because Apple Mail Privacy
     *  Protection produces opens that look human but are actually
     *  proxy fetches. */
    eventType?: 'email_open' | 'email_click';
}

export function classifyEmailEvent(input: ClassifierInput): ClassificationResult {
    const reasons: string[] = [];
    const ua = (input.userAgent || '').toLowerCase();
    const org = (input.ipOrg || '').toLowerCase();

    // 1. User-agent patterns that strongly imply a machine / scanner.
    for (const [re, code] of MAIL_PROXY_PATTERNS) {
        if (re.test(input.userAgent || '')) reasons.push(code);
    }
    for (const [re, code] of SCANNER_UA_PATTERNS) {
        if (re.test(input.userAgent || '')) reasons.push(code);
    }

    // 2. IP enrichment flags.
    if (input.ipIsTor) reasons.push('tor');
    if (input.ipIsVpn) reasons.push('vpn');
    if (input.ipIsProxy) reasons.push('proxy');
    if (input.ipIsDatacentre) reasons.push('datacentre');
    if (input.ipIsKnownSecurityScanner) reasons.push('known-scanner');
    if (typeof input.ipRiskScore === 'number' && input.ipRiskScore >= 70) {
        reasons.push('high-risk-ip');
    }
    if (org && DATACENTRE_ORG_PATTERNS.some(p => org.includes(p))) {
        reasons.push('datacentre-org');
    }

    // 3. UA-completely-missing on a click is unusual — flag.
    if (!ua) reasons.push('no-ua');

    // Dedup reasons so the JSON stays small.
    const uniqueReasons = Array.from(new Set(reasons));

    // 4. Decision rules.
    //    Any strong machine signal => machine_likely.
    //    No signals + recognisable browser UA => human_likely.
    //    Otherwise => unknown.
    const strongMachineReasons = [
        'gmail-proxy', 'ampp', 'safelinks', 'proofpoint', 'mimecast',
        'barracuda', 'forcepoint', 'symantec', 'cloudmark',
        'trend-micro', 'fireeye', 'inky', 'spam-filter',
        'bot-ua', 'headless', 'cli-ua', 'scanner-ua',
        'tor', 'known-scanner', 'datacentre', 'high-risk-ip',
    ];
    const hasStrongMachine = uniqueReasons.some(r => strongMachineReasons.includes(r));
    if (hasStrongMachine) {
        return { classification: 'machine_likely', reasons: uniqueReasons };
    }

    // Recognisable real-browser UA with no machine signals.
    const looksLikeBrowser = /Mozilla\/[0-9]/i.test(input.userAgent || '') &&
        /(Chrome|Safari|Firefox|Edg|Opera|Brave)\b/.test(input.userAgent || '') &&
        !/HeadlessChrome|bot|crawl/i.test(input.userAgent || '');
    if (looksLikeBrowser) {
        return { classification: 'human_likely', reasons: uniqueReasons };
    }

    return { classification: 'unknown', reasons: uniqueReasons };
}
