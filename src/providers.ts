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
      ...NO_TRANSACTION_CAPABILITIES
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

export function isSensitiveFieldLabel(value: string): boolean {
  return /(password|passcode|パスワード|暗証|card\s*(?:number|no)|カード番号|credit\s*card|クレジットカード|cvv|cvc|security\s*code|セキュリティコード|otp|one[- ]?time|ワンタイム|mfa|認証コード|verification\s*code|確認コード|3d\s*secure|3ds)/i.test(value);
}

export function isFinalPurchaseLabel(value: string): boolean {
  return /(購入(?:する|確定|完了)|決済(?:する|確定|実行)|支払(?:う|い|を確定)|注文を確定|予約を確定|チケットを購入|buy\s*(?:now|ticket)|purchase|pay\s*(?:now|confirm)|place\s*order|confirm\s*(?:purchase|payment|order|booking)|complete\s*(?:purchase|payment|order|booking)|agree\s*(?:and|&).*purchase)/i.test(value.trim());
}
