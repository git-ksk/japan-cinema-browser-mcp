import test from "node:test";
import assert from "node:assert/strict";
import {
  CINEMA_PROVIDERS,
  ProviderPolicyError,
  assertGenericControlAllowed,
  assertGenericFieldAllowed,
  assertGenericNavigationUrl,
  assertOfficialUrl,
  assertReviewedIntermediateControlAllowed,
  assertProviderCapability,
  isFinalPurchaseLabel,
  isSensitiveFieldLabel,
  providerForUrl
} from "../src/providers.js";

test("official provider domains and HTTPS subdomains are allowed", () => {
  assert.equal(providerForUrl("https://www.tohotheater.jp/" )?.id, "toho");
  assert.equal(providerForUrl("https://hlo.tohotheater.jp/net/schedule/036/TNPI2000J01.do")?.id, "toho");
  assert.equal(providerForUrl("https://foo.aeoncinema.com/path")?.id, "aeon");
  assert.equal(providerForUrl("https://theater.aeoncinema.com/theaters/hakusan/?date=20260814")?.id, "aeon");
  assert.equal(providerForUrl("https://109cinemas.net/" )?.id, "109");
  assert.equal(providerForUrl("https://cinema.109cinemas.net/path")?.id, "109");
});

test("lookalike, insecure, credentialed and non-default-port URLs are rejected", () => {
  assert.equal(providerForUrl("https://tohotheater.jp.evil.example/"), undefined);
  assert.equal(providerForUrl("https://eviltohotheater.jp/"), undefined);
  assert.equal(providerForUrl("https://aeoncinema.com.evil.example/"), undefined);
  assert.equal(providerForUrl("https://109cinemas.net.evil.example/"), undefined);
  assert.equal(providerForUrl("https://evil109cinemas.net/"), undefined);
  assert.equal(providerForUrl("http://www.tohotheater.jp/"), undefined);
  assert.equal(providerForUrl("https://user:pass@www.tohotheater.jp/"), undefined);
  assert.equal(providerForUrl("https://www.tohotheater.jp:8443/"), undefined);
  assert.equal(providerForUrl("https://user:pass@109cinemas.net/"), undefined);
  assert.equal(providerForUrl("https://109cinemas.net:8443/"), undefined);
  assert.throws(() => assertOfficialUrl("https://example.com/"));
});

test("TOHO and 109 expose reviewed read-only seatMap while all providers keep seat selection and transaction capabilities disabled", () => {
  for (const provider of [CINEMA_PROVIDERS.toho, CINEMA_PROVIDERS.aeon, CINEMA_PROVIDERS["109"]]) {
    assert.equal(provider.capabilities.theaters, true, provider.id);
    assert.equal(provider.capabilities.showtimes, true, provider.id);
    assert.equal(provider.capabilities.seatMap, provider.id === "toho" || provider.id === "109", provider.id);
    assert.equal(provider.capabilities.seatSelection, false, provider.id);
    assert.equal(provider.capabilities.checkoutPreparation, false, provider.id);
    assert.equal(provider.capabilities.purchaseSubmission, false, provider.id);
  }
  for (const provider of Object.values(CINEMA_PROVIDERS)) {
    assert.equal(provider.capabilities.purchaseSubmission, false, provider.id);
  }
});

test("provider capability matrix is enforced as a runtime policy boundary", () => {
  for (const providerId of ["toho", "aeon", "109"] as const) {
    assert.doesNotThrow(() => assertProviderCapability(providerId, "theaters"));
    assert.doesNotThrow(() => assertProviderCapability(providerId, "showtimes"));
  }

  assert.doesNotThrow(() => assertProviderCapability("toho", "seatMap"));
  assert.doesNotThrow(() => assertProviderCapability("109", "seatMap"));
  for (const providerId of ["aeon"] as const) {
    assert.throws(
      () => assertProviderCapability(providerId, "seatMap"),
      (error) => error instanceof ProviderPolicyError && error.code === "UNSUPPORTED_CAPABILITY",
      providerId
    );
  }

  for (const provider of Object.values(CINEMA_PROVIDERS)) {
    assert.throws(
      () => assertProviderCapability(provider.id, "seatSelection"),
      (error) => error instanceof ProviderPolicyError && error.code === "UNSUPPORTED_CAPABILITY",
      provider.id
    );
    assert.throws(
      () => assertProviderCapability(provider.id, "checkoutPreparation"),
      (error) => error instanceof ProviderPolicyError && error.code === "UNSUPPORTED_CAPABILITY",
      provider.id
    );
    assert.throws(
      () => assertProviderCapability(provider.id, "purchaseSubmission"),
      (error) => error instanceof ProviderPolicyError && error.code === "UNSUPPORTED_CAPABILITY",
      provider.id
    );
  }
});

test("sensitive fields are detected", () => {
  for (const label of ["パスワード", "カード番号", "セキュリティコード", "OTP", "Verification code", "CVV"]) {
    assert.equal(isSensitiveFieldLabel(label), true, label);
  }
  assert.equal(isSensitiveFieldLabel("メールアドレス"), false);
  assert.equal(isSensitiveFieldLabel("枚数"), false);
});

test("final purchase labels are detected", () => {
  for (const label of ["購入する", "決済する", "注文を確定", "Confirm purchase", "Pay now"]) {
    assert.equal(isFinalPurchaseLabel(label), true, label);
  }
  assert.equal(isFinalPurchaseLabel("座席を選ぶ"), false);
  assert.equal(isFinalPurchaseLabel("次へ"), false);
});

test("generic navigation is limited to reviewed public read surfaces", () => {
  for (const [url, provider] of [
    ["https://www.tohotheater.jp/", "toho"],
    ["https://www.tohotheater.jp/theater/find.html", "toho"],
    ["https://hlo.tohotheater.jp/net/schedule/036/TNPI2000J01.do", "toho"],
    ["https://www.aeoncinema.com/theater/", "aeon"],
    ["https://theater.aeoncinema.com/theaters/hakusan/?date=20260815", "aeon"],
    ["https://109cinemas.net/", "109"],
    ["https://109cinemas.net/kohoku/", "109"],
    ["https://109cinemas.net/kohoku/schedules/20260815.html", "109"]
  ] as const) {
    assert.doesNotThrow(() => assertGenericNavigationUrl(url, provider), `${provider}: ${url}`);
  }

  for (const url of [
    "https://api.tohotheater.jp/internal/schedule",
    "https://www.tohotheater.jp/api/private",
    "https://foo.aeoncinema.com/path",
    "https://theater.aeoncinema.com/api/showtimes",
    "https://cinema.109cinemas.net/path",
    "https://109cinemas.net/api/internal",
    "https://109cinemas.net/kohoku/schedules/20260815.html?theater_code=13"
  ]) {
    assert.throws(
      () => assertGenericNavigationUrl(url),
      (error) => error instanceof ProviderPolicyError && error.code === "URL_NOT_ALLOWED",
      url
    );
  }
});

test("generic navigation preserves wrong-domain, credential and port rejection", () => {
  for (const url of [
    "https://tohotheater.jp.evil.example/",
    "https://user:pass@www.aeoncinema.com/theater/",
    "https://109cinemas.net:8443/kohoku/"
  ]) {
    assert.throws(
      () => assertGenericNavigationUrl(url),
      (error) => error instanceof ProviderPolicyError && error.code === "URL_NOT_ALLOWED",
      url
    );
  }
});

test("generic controls enforce disabled transaction capabilities before fuzzy automation", () => {
  for (const provider of ["toho", "aeon", "109"] as const) {
    for (const label of ["座席を選ぶ", "座席選択", "Select seats"]) {
      assert.throws(
        () => assertGenericControlAllowed(provider, label),
        (error) => error instanceof ProviderPolicyError && error.code === "UNSUPPORTED_CAPABILITY",
        `${provider}: ${label}`
      );
    }
    for (const label of ["券種を選択", "チケット枚数", "Checkout", "お客様情報へ進む", "次へ"]) {
      assert.throws(
        () => assertGenericControlAllowed(provider, label),
        (error) => error instanceof ProviderPolicyError && error.code === "UNSUPPORTED_CAPABILITY",
        `${provider}: ${label}`
      );
    }
    assert.throws(
      () => assertGenericControlAllowed(provider, "購入する"),
      (error) => error instanceof ProviderPolicyError && error.code === "UNSUPPORTED_CAPABILITY",
      provider
    );
  }
});

test("generic controls allow reviewed read navigation but reject unknown script-driven controls", () => {
  assert.doesNotThrow(() => assertGenericControlAllowed(
    "109",
    "港北",
    "https://109cinemas.net/kohoku/"
  ));
  assert.doesNotThrow(() => assertGenericControlAllowed("toho", "8/15（土）"));
  assert.throws(
    () => assertGenericControlAllowed("toho", "続行"),
    (error) => error instanceof ProviderPolicyError && error.code === "UNREVIEWED_INTERACTION"
  );
  assert.throws(
    () => assertGenericControlAllowed("109", "詳細", "https://109cinemas.net/api/internal"),
    (error) => error instanceof ProviderPolicyError && error.code === "URL_NOT_ALLOWED"
  );
});


test("TOHO non-member continuation is allowed only through the exact provider-specific reviewed intermediate policy", () => {
  assert.doesNotThrow(() => assertReviewedIntermediateControlAllowed("toho", "ログインせずに購入する"));
  for (const [provider, label] of [
    ["aeon", "ログインせずに購入する"],
    ["109", "ログインせずに購入する"],
    ["toho", "購入する"],
    ["toho", "ログインせずに購入を続ける"]
  ] as const) {
    assert.throws(
      () => assertReviewedIntermediateControlAllowed(provider, label),
      (error) => error instanceof ProviderPolicyError && error.code === "UNREVIEWED_INTERACTION"
    );
  }
  assert.throws(
    () => assertGenericControlAllowed("toho", "ログインせずに購入する"),
    (error) => error instanceof ProviderPolicyError && error.code === "UNSUPPORTED_CAPABILITY"
  );
});

test("generic fields allow read filters but block seat, checkout and unreviewed fields", () => {
  assert.doesNotThrow(() => assertGenericFieldAllowed("aeon", "劇場を検索"));
  assert.doesNotThrow(() => assertGenericFieldAllowed("109", "作品名"));
  assert.throws(
    () => assertGenericFieldAllowed("toho", "カード番号"),
    (error) => error instanceof ProviderPolicyError && error.code === "SENSITIVE_FIELD"
  );
  for (const [label, code] of [
    ["座席番号", "UNSUPPORTED_CAPABILITY"],
    ["チケット枚数", "UNSUPPORTED_CAPABILITY"],
    ["メールアドレス", "UNSUPPORTED_CAPABILITY"],
    ["備考", "UNREVIEWED_INTERACTION"]
  ] as const) {
    assert.throws(
      () => assertGenericFieldAllowed("toho", label),
      (error) => error instanceof ProviderPolicyError && error.code === code,
      label
    );
  }
});
