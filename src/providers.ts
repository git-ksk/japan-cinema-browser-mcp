export type CinemaProviderId = "toho" | "aeon" | "109";

export interface ProviderCapabilities {
  theaters: boolean;
  showtimes: boolean;
  seatMap: boolean;
  seatSelection: boolean;
  checkoutPreparation: boolean;
  purchaseSubmission: boolean;
}

export type ProviderCapability = keyof ProviderCapabilities;

export interface CinemaProviderDefinition {
  id: CinemaProviderId;
  name: string;
  rootUrl: string;
  allowedDomain: string;
  capabilities: ProviderCapabilities;
}

const NO_TRANSACTION_CAPABILITIES = {
  seatMap: false,
  seatSelection: false,
  checkoutPreparation: false,
  purchaseSubmission: false
} as const;

export const CINEMA_PROVIDERS: Record<CinemaProviderId, CinemaProviderDefinition> = {
  toho: {
    id: "toho",
    name: "TOHO Cinemas",
    rootUrl: "https://www.tohotheater.jp/",
    allowedDomain: "tohotheater.jp",
    capabilities: {
      theaters: true,
      showtimes: true,
      ...NO_TRANSACTION_CAPABILITIES,
      seatMap: true
    }
  },
  aeon: {
    id: "aeon",
    name: "AEON Cinema",
    rootUrl: "https://www.aeoncinema.com/",
    allowedDomain: "aeoncinema.com",
    capabilities: {
      theaters: true,
      showtimes: true,
      ...NO_TRANSACTION_CAPABILITIES
    }
  },
  "109": {
    id: "109",
    name: "109 Cinemas",
    rootUrl: "https://109cinemas.net/",
    allowedDomain: "109cinemas.net",
    capabilities: {
      theaters: true,
      showtimes: true,
      ...NO_TRANSACTION_CAPABILITIES
    }
  }
};

function hostnameMatches(hostname: string, allowedDomain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const domain = allowedDomain.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

export class ProviderPolicyError extends Error {
  constructor(
    public readonly code:
      | "UNSUPPORTED_PROVIDER"
      | "UNSUPPORTED_CAPABILITY"
      | "URL_NOT_ALLOWED"
      | "UNREVIEWED_INTERACTION"
      | "SENSITIVE_FIELD"
      | "FINAL_ACTION_REQUIRES_CONFIRMATION",
    message: string
  ) {
    super(message);
    this.name = "ProviderPolicyError";
  }
}

export function assertProviderCapability(providerId: CinemaProviderId, capability: ProviderCapability): CinemaProviderDefinition {
  const provider = CINEMA_PROVIDERS[providerId];
  if (!provider.capabilities[capability]) {
    throw new ProviderPolicyError(
      "UNSUPPORTED_CAPABILITY",
      `${provider.name} capability '${capability}' is not enabled.`
    );
  }
  return provider;
}

export function providerForUrl(value: string): CinemaProviderDefinition | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    return undefined;
  }
  return Object.values(CINEMA_PROVIDERS).find((provider) => hostnameMatches(url.hostname, provider.allowedDomain));
}

export function assertOfficialUrl(value: string, expectedProvider?: CinemaProviderId): URL {
  const provider = providerForUrl(value);
  if (!provider || (expectedProvider && provider.id !== expectedProvider)) {
    throw new ProviderPolicyError(
      "URL_NOT_ALLOWED",
      "Navigation is limited to reviewed HTTPS pages under TOHO Cinemas, AEON Cinema, and 109 Cinemas official domains."
    );
  }
  return new URL(value);
}

function validCompactDate(value: string): boolean {
  if (!/^20\d{6}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function noSearchOrHash(url: URL): boolean {
  return !url.search && !url.hash;
}

function isReviewedGenericReadSurface(url: URL, providerId: CinemaProviderId): boolean {
  if (providerId === "toho") {
    if (url.hostname === "www.tohotheater.jp" && ["/", "/theater/find.html"].includes(url.pathname)) {
      return noSearchOrHash(url);
    }
    return (
      ["www.tohotheater.jp", "hlo.tohotheater.jp"].includes(url.hostname) &&
      /^\/net\/schedule\/\d{3}\/TNPI2000J01\.do$/.test(url.pathname) &&
      noSearchOrHash(url)
    );
  }

  if (providerId === "aeon") {
    if (
      url.hostname === "www.aeoncinema.com" &&
      ["/", "/theater", "/theater/", "/theater/index.html"].includes(url.pathname)
    ) {
      return noSearchOrHash(url);
    }
    if (url.hostname !== "theater.aeoncinema.com" || !/^\/theaters\/[a-z0-9_-]+\/?$/.test(url.pathname) || url.hash) {
      return false;
    }
    if (!url.search) return true;
    const entries = [...url.searchParams.entries()];
    return entries.length === 1 && entries[0]?.[0] === "date" && validCompactDate(entries[0]?.[1] ?? "");
  }

  if (url.hostname !== "109cinemas.net" || url.hash) return false;
  if (url.pathname === "/") return !url.search;
  if (/^\/[a-z0-9-]+\/$/.test(url.pathname)) return !url.search;
  if (/^\/[a-z0-9-]+\/schedules\/20\d{6}\.html$/.test(url.pathname)) {
    const date = url.pathname.match(/\/(20\d{6})\.html$/)?.[1];
    return Boolean(date && validCompactDate(date) && !url.search);
  }
  return false;
}

export function assertGenericNavigationUrl(value: string, expectedProvider?: CinemaProviderId): URL {
  const url = assertOfficialUrl(value, expectedProvider);
  const provider = providerForUrl(url.href);
  if (!provider || !isReviewedGenericReadSurface(url, provider.id)) {
    throw new ProviderPolicyError(
      "URL_NOT_ALLOWED",
      "Generic navigation is limited to explicitly reviewed public cinema read surfaces. Provider adapters may use separately reviewed explicit routes discovered from rendered public UI."
    );
  }
  return url;
}

function transactionCapabilityForLabel(value: string): ProviderCapability | undefined {
  const label = value.trim();
  if (isFinalPurchaseLabel(label)) return "purchaseSubmission";
  if (/(座席表|座席図|seat\s*map|seat\s*availability)/i.test(label)) return "seatMap";
  if (/(座席(?:番号|選択|指定|を選|を指定)|(?:選択|指定).*座席|seat.*(?:select|choose|pick)|(?:select|choose|pick).*seat)/i.test(label)) {
    return "seatSelection";
  }
  if (/(券種|チケット(?:種類|種別|枚数)|枚数|checkout|お客様情報|購入情報|予約情報|氏名|メールアドレス|e-?mail|電話番号|phone|次へ|確認画面|支払方法|payment\s*method)/i.test(label)) {
    return "checkoutPreparation";
  }
  return undefined;
}

function isReviewedReadControlLabel(value: string): boolean {
  const label = value.trim();
  return (
    /^(?:20\d{2}[年\/.\-])?\d{1,2}[月\/.\-]\d{1,2}(?:日)?(?:\s*[（(][^）)]{1,4}[）)])?$/.test(label) ||
    /上映スケジュール|スケジュールを確認|schedule/i.test(label)
  );
}

function isReviewedReadFieldLabel(value: string): boolean {
  return /(劇場|映画|作品|上映|検索|search|filter|日付|date)/i.test(value.trim());
}

export function assertGenericControlAllowed(
  providerId: CinemaProviderId,
  label: string,
  targetUrl?: string
): void {
  const capability = transactionCapabilityForLabel(label);
  if (capability) {
    assertProviderCapability(providerId, capability);
    if (capability === "purchaseSubmission") {
      throw new ProviderPolicyError(
        "FINAL_ACTION_REQUIRES_CONFIRMATION",
        "Final purchase/payment/booking controls require the separate confirmation flow."
      );
    }
    throw new ProviderPolicyError(
      "UNREVIEWED_INTERACTION",
      `Generic automation does not implement reviewed transactional capability '${capability}'. Use a dedicated provider workflow after separate review.`
    );
  }
  if (targetUrl) {
    assertGenericNavigationUrl(targetUrl, providerId);
    return;
  }
  if (isReviewedReadControlLabel(label)) return;
  throw new ProviderPolicyError(
    "UNREVIEWED_INTERACTION",
    "Generic script-driven controls are limited to explicitly reviewed read-only interactions. Use a provider adapter for provider-specific reviewed UI flows."
  );
}

export function assertReviewedIntermediateControlAllowed(providerId: CinemaProviderId, label: string): void {
  if (providerId === "toho" && label.trim() === "ログインせずに購入する") return;
  throw new ProviderPolicyError(
    "UNREVIEWED_INTERACTION",
    "This provider-specific intermediate control has not been reviewed for automated use."
  );
}

export function assertGenericFieldAllowed(providerId: CinemaProviderId, label: string): void {
  if (isSensitiveFieldLabel(label)) {
    throw new ProviderPolicyError("SENSITIVE_FIELD", "Sensitive authentication or payment fields must be entered by the user directly in Chrome.");
  }
  const capability = transactionCapabilityForLabel(label);
  if (capability) {
    assertProviderCapability(providerId, capability);
    throw new ProviderPolicyError(
      "UNREVIEWED_INTERACTION",
      `Generic form filling does not implement reviewed transactional capability '${capability}'. Use a dedicated provider workflow after separate review.`
    );
  }
  if (isReviewedReadFieldLabel(label)) return;
  throw new ProviderPolicyError(
    "UNREVIEWED_INTERACTION",
    "Generic form filling is limited to explicitly reviewed read-only search/filter fields."
  );
}

export function isSensitiveFieldLabel(value: string): boolean {
  return /(password|passcode|パスワード|暗証|card\s*(?:number|no)|カード番号|credit\s*card|クレジットカード|cvv|cvc|security\s*code|セキュリティコード|otp|one[- ]?time|ワンタイム|mfa|認証コード|verification\s*code|確認コード|3d\s*secure|3ds)/i.test(value);
}

export function isFinalPurchaseLabel(value: string): boolean {
  return /(購入(?:する|確定|完了)|決済(?:する|確定|実行)|支払(?:う|い|を確定)|注文を確定|予約を確定|チケットを購入|buy\s*(?:now|ticket)|purchase|pay\s*(?:now|confirm)|place\s*order|confirm\s*(?:purchase|payment|order|booking)|complete\s*(?:purchase|payment|order|booking)|agree\s*(?:and|&).*purchase)/i.test(value.trim());
}
