import test from "node:test";
import assert from "node:assert/strict";
import {
  CINEMA_PROVIDERS,
  ProviderPolicyError,
  assertOfficialUrl,
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

test("TOHO, AEON and 109 expose read-only Phase 1 capabilities while transaction capabilities remain disabled", () => {
  for (const provider of [CINEMA_PROVIDERS.toho, CINEMA_PROVIDERS.aeon, CINEMA_PROVIDERS["109"]]) {
    assert.equal(provider.capabilities.theaters, true, provider.id);
    assert.equal(provider.capabilities.showtimes, true, provider.id);
    assert.equal(provider.capabilities.seatMap, false, provider.id);
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

  for (const provider of Object.values(CINEMA_PROVIDERS)) {
    assert.throws(
      () => assertProviderCapability(provider.id, "seatMap"),
      (error) => error instanceof ProviderPolicyError && error.code === "UNSUPPORTED_CAPABILITY",
      provider.id
    );
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
