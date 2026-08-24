import test from "node:test";
import assert from "node:assert/strict";
import {
  cloudflareAccessTakeoverPrincipalBinding,
  takeoverPrincipalBindingForEmail
} from "../src/takeover-access.js";

test("Cloudflare Access takeover principal is exact, bounded, and requires the Access JWT header", () => {
  const expected = takeoverPrincipalBindingForEmail("Owner@Example.com");
  assert.equal(expected, takeoverPrincipalBindingForEmail("owner@example.com"));
  assert.equal(cloudflareAccessTakeoverPrincipalBinding({
    "cf-access-authenticated-user-email": "owner@example.com",
    "cf-access-jwt-assertion": "a.b.c"
  }, { enabled: true, cloudflareAccessEmail: "owner@example.com" }), expected);
  assert.equal(cloudflareAccessTakeoverPrincipalBinding({
    "cf-access-authenticated-user-email": "other@example.com",
    "cf-access-jwt-assertion": "a.b.c"
  }, { enabled: true, cloudflareAccessEmail: "owner@example.com" }), undefined);
  assert.equal(cloudflareAccessTakeoverPrincipalBinding({
    "cf-access-authenticated-user-email": "owner@example.com"
  }, { enabled: true, cloudflareAccessEmail: "owner@example.com" }), undefined);
  assert.equal(cloudflareAccessTakeoverPrincipalBinding({
    "cf-access-authenticated-user-email": "owner@example.com",
    "cf-access-jwt-assertion": "a.b.c"
  }, { enabled: false, cloudflareAccessEmail: "owner@example.com" }), undefined);
});
